-- ============================================================
-- Migration 085 — O consumo da produção sai do pote na ABERTURA
--
-- A DINÂMICA REAL. Os baldes não esperam a produção acabar para serem
-- repostos. Quando o primeiro balde de açúcar termina, ele já vai para a
-- equipe de reabastecimento enquanto a produção continua no segundo. O
-- reabastecimento acontece COM A SESSÃO ABERTA.
--
-- O DEFEITO. Até aqui a produção só baixava o insumo dos potes no FECHAMENTO.
-- Durante a sessão, `locais_lotes` ficava intocado e o sistema seguia achando
-- que o pote estava como na abertura. O abastecimento (083/084) calcula o que
-- entrou como "peso do pote − o que já tinha", e com o número velho errava de
-- dois jeitos, os dois calados:
--
--   Pote abre com 17 kg, produção consome 12, sobram 5. O operador despeja 10
--   e a balança marca 15. A conta dá 15 − 17 = −2, e a tela ACUSAVA erro de
--   balança ou de tara. Era o caso mais comum.
--
--   Com despejo grande — 25 kg, balança em 30 — a conta dava 13 kg de entrada
--   contra 25 kg que saíram das embalagens. Os 12 kg viravam PERDA que nunca
--   houve, e o fechamento descontava os mesmos 12 kg de novo.
--
-- POR QUE MOVER A SUBTRAÇÃO RESOLVE, E É BARATO. Duas coisas já estavam
-- prontas no código:
--
--   1. O teórico já é ENFILEIRADO, não rateado (059): "raspa-se o primeiro
--      pote até acabar e só então se abre o segundo". Descontar na abertura
--      produz no sistema exatamente o estado que a equipe de reposição
--      encontra na bancada — pote #1 zerado, pote #2 parcial.
--   2. A quantidade JÁ ESTÁ DECIDIDA na abertura: `consumo_teorico` sai do
--      plano, e o fechamento (065) só aplicava esse mesmo número. Nenhuma
--      medição nova acontecia lá. Muda QUANDO, não QUANTO.
--
-- A cautela da 065 — errar sempre para o lado de sobrar espaço no pote —
-- existia porque `capacidade_max` era limite rígido. Deixou de valer na 084,
-- quando a capacidade virou referência e o operador passou a encher até onde
-- cabe fisicamente.
--
-- COMO. Uma coluna guarda quanto do teórico JÁ SAIU do pote, e uma função
-- idempotente reconcilia a diferença. Ela é chamada na abertura, na edição do
-- plano e no fechamento — e sempre acerta o que faltar, inclusive nada.
--
-- APLICADA EM QUATRO PARTES (085a a 085d no histórico do Supabase). O texto
-- abaixo é o mesmo, na ordem em que foi executado.
-- ============================================================

-- ── 085a: a coluna e a reconciliação ──────────────────────

ALTER TABLE sessoes_producao_locais
  ADD COLUMN IF NOT EXISTS consumo_aplicado DECIMAL NOT NULL DEFAULT 0;

COMMENT ON COLUMN sessoes_producao_locais.consumo_aplicado IS
  'Quanto do consumo teórico já foi retirado de locais_lotes por esta linha. '
  'quantidade_inicial continua sendo o que havia no pote quando a sessão abriu.';

UPDATE sessoes_producao_locais spl
   SET consumo_aplicado = COALESCE(spl.consumo_real, 0)
  FROM sessoes_producao s
 WHERE s.id = spl.sessao_id
   AND s.status = 'fechada'
   AND spl.consumo_aplicado = 0;

CREATE OR REPLACE FUNCTION aplicar_teorico_nos_recipientes(p_sessao_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_sessao       sessoes_producao%ROWTYPE;
  v_local_id     UUID;
  v_linha        RECORD;
  v_lote         RECORD;
  v_mov_saida    UUID;
  v_mov_volta    UUID;
  v_mov_codigo   TEXT;
  v_delta        DECIMAL;
  v_move         DECIMAL;
  v_tem          DECIMAL;
  v_total_saiu   DECIMAL := 0;
  v_total_voltou DECIMAL := 0;
  v_potes        INTEGER := 0;
  v_mexeu        BOOLEAN;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao WHERE id = p_sessao_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;

  FOR v_local_id IN
    SELECT DISTINCT local_id FROM sessoes_producao_locais WHERE sessao_id = p_sessao_id
  LOOP
    -- Uma movimentação por pote e por sentido, criada só quando há o que
    -- registrar: com o teórico enfileirado a maioria dos potes fica em zero, e
    -- criar movimentação para eles encheria o histórico de registros vazios.
    v_mov_saida := NULL;
    v_mov_volta := NULL;
    v_mexeu     := FALSE;

    FOR v_linha IN
      SELECT spl.id, spl.lote_id,
             LEAST(COALESCE(spl.consumo_teorico, 0), spl.quantidade_inicial) AS alvo,
             spl.consumo_aplicado AS aplicado
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_local_id
    LOOP
      v_delta := ROUND(v_linha.alvo - v_linha.aplicado, 3);
      CONTINUE WHEN v_delta = 0;

      SELECT l.unidade, l.validade_original INTO v_lote FROM lotes l WHERE l.id = v_linha.lote_id;

      IF v_delta > 0 THEN
        -- Sai do pote. Nunca além do que há lá dentro: se o teórico for maior,
        -- o insumo acabou no meio e alguém abasteceu — a auditoria acerta.
        SELECT COALESCE(quantidade, 0) INTO v_tem
          FROM locais_lotes WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;
        v_move := LEAST(v_delta, COALESCE(v_tem, 0));
        CONTINUE WHEN v_move <= 0;

        UPDATE locais_lotes
           SET quantidade = quantidade - v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        IF v_mov_saida IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'consumo_producao',
                  v_sessao.aberta_por, p_sessao_id,
                  'Consumo previsto da sessão, baixado na abertura.')
          RETURNING id INTO v_mov_saida;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
        VALUES (v_mov_saida, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado + v_move WHERE id = v_linha.id;

        v_total_saiu := v_total_saiu + v_move;
        v_mexeu := TRUE;

      ELSE
        -- O plano diminuiu: devolve ao pote o que não vai mais ser usado.
        v_move := -v_delta;

        UPDATE locais_lotes
           SET quantidade = quantidade + v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        -- A linha pode ter sumido no caminho (uma contagem que zerou o pote,
        -- por exemplo). O helper recria em vez de a devolução evaporar.
        IF NOT FOUND THEN
          PERFORM abastecer_recipiente(v_local_id, v_linha.lote_id, v_move,
                                       v_lote.unidade, v_lote.validade_original);
        END IF;

        IF v_mov_volta IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'ajuste_inventario',
                  v_sessao.aberta_por, p_sessao_id,
                  'Plano da sessão diminuiu: insumo devolvido ao recipiente.')
          RETURNING id INTO v_mov_volta;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_mov_volta, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado - v_move WHERE id = v_linha.id;

        v_total_voltou := v_total_voltou + v_move;
        v_mexeu := TRUE;
      END IF;
    END LOOP;

    IF v_mexeu THEN v_potes := v_potes + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'saiu',       ROUND(v_total_saiu, 3),
    'devolvido',  ROUND(v_total_voltou, 3),
    'recipientes', v_potes
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION aplicar_teorico_nos_recipientes(UUID) IS
  'Acerta os recipientes com o consumo teórico da sessão: tira o que falta '
  'tirar e devolve o que o plano deixou de precisar. Idempotente — rodar duas '
  'vezes seguidas não mexe em nada na segunda.';

-- ── 085b: a abertura desconta os recipientes ──────────────

CREATE OR REPLACE FUNCTION abrir_sessao_producao_v2(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_producao  DATE,
  p_plano          JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_inseridos         INTEGER;
  v_faltantes         JSONB;
  v_trava             JSONB;
  v_aplicacao         JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM sessoes_producao
              WHERE empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Já existe uma sessão aberta. Feche-a antes de abrir uma nova.');
  END IF;

  IF p_plano IS NULL OR jsonb_array_length(p_plano) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe ao menos uma ficha com quantidade de formas.');
  END IF;

  -- ── Insumo suficiente nos recipientes? ────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'codigo', x.codigo, 'nome', x.nome,
           'precisa', ROUND(x.demanda, 3), 'tem', ROUND(x.conteudo, 3),
           'falta', ROUND(x.demanda - x.conteudo, 3), 'unidade', x.unidade))
    INTO v_faltantes
    FROM (
      SELECT i.codigo, i.nome, i.unidade_medida AS unidade,
             SUM(fti.quantidade * (e->>'formas')::INTEGER) AS demanda,
             COALESCE((SELECT SUM(c.quantidade_total)
                         FROM v_recipientes_composicao c
                        WHERE c.empresa_id = p_empresa_id AND c.insumo_id = i.id), 0) AS conteudo
        FROM jsonb_array_elements(p_plano) e
        JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
        JOIN insumos i ON i.id = fti.insumo_id
       WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       GROUP BY i.id, i.codigo, i.nome, i.unidade_medida
    ) x
   WHERE x.demanda > x.conteudo;

  IF v_faltantes IS NOT NULL THEN
    v_trava := avaliar_trava(p_empresa_id, 'sessao_sem_insumo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object(
        'ok', false,
        'trava', 'sessao_sem_insumo',
        'mensagem', format('%s insumo(s) sem quantidade suficiente nos recipientes. '
                           'A produção pararia no meio para abastecer.',
                           jsonb_array_length(v_faltantes)),
        'faltantes', v_faltantes
      );
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'sessao_sem_insumo',
                              jsonb_build_object('faltantes', v_faltantes), p_justificativa);
  END IF;

  -- ── Cria a sessão ─────────────────────────────────────────
  v_sessao_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, observacoes_abertura
  )
  VALUES (
    p_empresa_id, v_sessao_codigo, p_data_producao, 'aberta',
    p_responsavel_id, NOW(), p_observacoes
  )
  RETURNING id INTO v_sessao_id;

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas);

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT v_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.consumo_teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    GET DIAGNOSTICS v_inseridos = ROW_COUNT;
    v_locais_vinculados := v_locais_vinculados + v_inseridos;
  END LOOP;

  -- O teorico deixa de ser rateado entre todos os potes: e enfileirado.
  PERFORM redistribuir_teorico_sequencial(v_sessao_id);

  -- E sai do pote AGORA, não no fechamento: os baldes são repostos durante a
  -- produção, e a reposição precisa encontrar no sistema o pote como ele está
  -- na bancada.
  v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

  RETURN jsonb_build_object(
    'ok', true, 'sessao_id', v_sessao_id, 'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades, 'locais_vinculados', v_locais_vinculados,
    'consumo_baixado', COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0),
    'recipientes_baixados', COALESCE((v_aplicacao->>'recipientes')::INTEGER, 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 085c: editar o plano aplica a DIFERENÇA ───────────────

CREATE OR REPLACE FUNCTION atualizar_plano_sessao(
  p_sessao_id  UUID,
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_ficha          RECORD;
  v_item           RECORD;
  v_rendimento     INTEGER;
  v_total_unidades INTEGER := 0;
  v_aplicacao      JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessoes_producao
                  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou já fechada.');
  END IF;

  -- Fichas que saíram do plano
  DELETE FROM sessoes_producao_skus
   WHERE sessao_id = p_sessao_id
     AND ficha_tecnica_id NOT IN (
       SELECT (e->>'ficha_id')::UUID FROM jsonb_array_elements(p_plano) e
        WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     );

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Ficha sem rendimento cadastrado.');
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (p_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas)
    ON CONFLICT (sessao_id, ficha_tecnica_id) DO UPDATE SET
      ficha_versao_id      = EXCLUDED.ficha_versao_id,
      quantidade_planejada = EXCLUDED.quantidade_planejada,
      multiplicador        = EXCLUDED.multiplicador;

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  -- Consumo teórico recalculado e rateado entre os lotes já vinculados
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    UPDATE sessoes_producao_locais spl
       SET consumo_teorico = v_item.teorico * (spl.quantidade_inicial / t.total)
      FROM (SELECT SUM(quantidade_inicial) AS total
              FROM sessoes_producao_locais
             WHERE sessao_id = p_sessao_id AND insumo_id = v_item.insumo_id) t
     WHERE spl.sessao_id = p_sessao_id
       AND spl.insumo_id = v_item.insumo_id
       AND t.total > 0;
  END LOOP;

  -- Insumos que entraram com uma ficha nova ainda não têm recipiente vinculado
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM sessoes_producao_locais
                        WHERE sessao_id = p_sessao_id AND insumo_id = fti.insumo_id)
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT p_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;
  END LOOP;

  -- O teorico deixa de ser rateado entre todos os potes: e enfileirado.
  PERFORM redistribuir_teorico_sequencial(p_sessao_id);

  -- Mudar de 44 para 50 formas tira mais do pote; voltar para 40 devolve. É a
  -- DIFERENÇA que se aplica, não o total — senão descontaria duas vezes.
  v_aplicacao := aplicar_teorico_nos_recipientes(p_sessao_id);

  RETURN jsonb_build_object(
    'ok', true,
    'quantidade_planejada', v_total_unidades,
    'consumo_baixado',   COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0),
    'consumo_devolvido', COALESCE((v_aplicacao->>'devolvido')::DECIMAL, 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 085d: o fechamento só liquida ─────────────────────────

CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao               sessoes_producao%ROWTYPE;
  v_sku                  JSONB;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_produto        DECIMAL(8,4) := 0;
  v_ficha_id             UUID;
  v_produto_id           UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
  v_potes                INTEGER := 0;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  SELECT ftv.peso_medio_g, sps.quantidade_planejada, sps.ficha_tecnica_id
    INTO v_peso_medio_g, v_qtd_planejada, v_ficha_id
    FROM sessoes_producao_skus sps
    JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
   WHERE sps.sessao_id = p_sessao_id
   LIMIT 1;

  SELECT tipo, insumo_resultado_id INTO v_tipo_ficha, v_insumo_resultado_id
    FROM fichas_tecnicas WHERE id = v_ficha_id;

  -- ── SKUs: inalterado ──────────────────────────────────────
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_qtd_perdida_proc    := COALESCE((v_sku->>'quantidade_perdida')::INTEGER, 0);
    v_qtd_descartada_gram := COALESCE((v_sku->>'quantidade_descartada_gramatura')::INTEGER, 0);
    v_peso_descartado_g   := COALESCE((v_sku->>'peso_descartado_gramatura_g')::DECIMAL, 0);
    v_qtd_produzida       := GREATEST(v_qtd_planejada - v_qtd_perdida_proc - v_qtd_descartada_gram, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_produzida            = v_qtd_produzida,
           quantidade_perdida              = v_qtd_perdida_proc,
           quantidade_descartada_gramatura = v_qtd_descartada_gram,
           peso_descartado_gramatura_g     = NULLIF(v_peso_descartado_g, 0)
     WHERE sessao_id = p_sessao_id
       AND ficha_tecnica_id = (v_sku->>'ficha_id')::UUID;
  END LOOP;

  -- ── Recipientes: o estoque JÁ SAIU na abertura (085) ──────
  -- A chamada abaixo é rede de segurança, não a regra: numa sessão normal ela
  -- encontra tudo aplicado e não mexe em nada. Existe para as sessões que
  -- estavam abertas antes da 085, e para o caso de o teórico ter mudado sem
  -- passar por atualizar_plano_sessao.
  PERFORM aplicar_teorico_nos_recipientes(p_sessao_id);

  SELECT COUNT(DISTINCT local_id) INTO v_potes
    FROM sessoes_producao_locais
   WHERE sessao_id = p_sessao_id AND consumo_aplicado > 0;

  -- Liquida as linhas com o que de fato saiu. Um único UPDATE cobre os potes
  -- usados e os intocados: nestes consumo_aplicado é zero, e a linha fecha com
  -- o que tinha em vez de ficar com quantidade_final nula.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial - consumo_aplicado,
         consumo_real     = consumo_aplicado,
         desvio           = 0
   WHERE sessao_id = p_sessao_id;

  -- ── Perda de produto: inalterada ──────────────────────────
  IF v_qtd_planejada > 0 THEN
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      v_fator_produto := (
        (v_qtd_perdida_proc::DECIMAL * v_peso_medio_g + v_peso_descartado_g)
        / (v_qtd_planejada::DECIMAL * v_peso_medio_g)
      ) * 100;
    ELSE
      v_fator_produto := (
        (v_qtd_perdida_proc + v_qtd_descartada_gram)::DECIMAL / v_qtd_planejada::DECIMAL
      ) * 100;
    END IF;
  END IF;

  UPDATE sessoes_producao
     SET status                 = 'fechada',
         fechada_por            = p_responsavel_id,
         data_fechamento        = NOW(),
         observacoes_fechamento = p_observacoes,
         -- NULL, não zero: a perda de insumo não é mais medida aqui.
         fator_perda_insumos    = NULL,
         fator_perda_produto    = v_fator_produto
   WHERE id = p_sessao_id;

  -- ── Lote resultante: inalterado ───────────────────────────
  IF v_ficha_id IS NOT NULL AND v_qtd_produzida > 0 THEN
    IF v_tipo_ficha = 'insumo' AND v_insumo_resultado_id IS NOT NULL THEN
      v_lote_result := registrar_lote_insumo_producao(
        p_empresa_id, v_insumo_resultado_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
    ELSE
      SELECT id INTO v_produto_id
        FROM produtos
       WHERE ficha_tecnica_id = v_ficha_id AND empresa_id = p_empresa_id AND ativo = true
       LIMIT 1;

      IF FOUND THEN
        v_lote_result := registrar_lote_produto(
          p_empresa_id, v_produto_id, p_sessao_id,
          v_data_producao, v_qtd_produzida, p_responsavel_id
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'recipientes_baixados', v_potes,
    'fator_perda_produto', v_fator_produto,
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'tipo_ficha', COALESCE(v_tipo_ficha, 'produto')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $do$
DECLARE
  v_id UUID;
BEGIN
  -- Sessões que já estavam abertas nasceram sob a regra antiga e ainda não
  -- tiveram a baixa. Aplicar agora dá o mesmo resultado que o fechamento
  -- delas produziria, só que na hora certa.
  FOR v_id IN SELECT id FROM sessoes_producao WHERE status = 'aberta' LOOP
    PERFORM aplicar_teorico_nos_recipientes(v_id);
  END LOOP;
END $do$;

-- ============================================================
-- Migration 089 — O estoque de produto nasce na PÓS-PRODUÇÃO
--
-- O lote de produto nascia no FECHAMENTO da sessão. Três coisas erradas nisso,
-- todas encontradas no primeiro uso real:
--
--   1. O brownie ainda está na forma. Ele só vira estoque quando é
--      desenformado — e até lá o sistema já oferecia as unidades à expedição.
--   2. As perdas da desenforma chegam depois. A 088 remendou isso ajustando o
--      lote por diferença; com o lote nascendo no lugar certo, o remendo some.
--   3. A validade contava da produção. Na padaria são 120 dias contados da
--      PÓS-PRODUÇÃO: o LPROD-0001 ficou com 08/12 onde devia estar 10/12.
--
-- E faltava o que nunca existiu: uma sessão pode virar MAIS DE UM LOTE. A
-- produção do dia 11 foi desenformada em dois dias, e cada parte tem a sua
-- validade.
--
-- O DESENHO. Continua um registro de pós por sessão — o `UNIQUE (sessao_id)`
-- fica de pé. O que ganha divisão é a quantidade boa: `p_partes` diz quantas
-- unidades saíram em cada data de desenforma, e cada validade distinta vira um
-- lote. A chave natural de uma parte é a validade: duas partes com a mesma
-- validade são o mesmo lote, e por isso são somadas antes de gravar.
--
-- A função valida TUDO antes de escrever a primeira linha. `RETURN` de erro no
-- meio do caminho não desfaz o que já foi gravado — quem devolve `ok: false`
-- não pode ter mexido em nada.
--
-- O acerto dos dois lotes que já existiam está na 089b.
-- ============================================================

-- ── lotes_produto: quando saiu da forma ─────────────────────
-- `data_producao` continua sendo o dia do forno — é a rastreabilidade, e não
-- se mexe nela. A validade é que passa a contar da desenforma.
ALTER TABLE lotes_produto ADD COLUMN IF NOT EXISTS data_desenforma DATE;

COMMENT ON COLUMN lotes_produto.data_desenforma IS
  'Dia em que estas unidades saíram da forma. É desta data que sai a validade; '
  'data_producao continua sendo o dia do forno.';

-- ── registrar_lote_produto aceita validade explícita ────────
-- Dois parâmetros novos. Sem eles a função se comporta exatamente como antes,
-- que é o que o fechamento de ficha de insumo e qualquer chamador antigo espera.
-- DROP antes do CREATE: com o número de argumentos diferente, o CREATE OR
-- REPLACE criaria uma sobrecarga e a chamada de 6 argumentos ficaria ambígua.
DROP FUNCTION IF EXISTS registrar_lote_produto(UUID, UUID, UUID, DATE, INTEGER, UUID);

CREATE OR REPLACE FUNCTION registrar_lote_produto(
  p_empresa_id     UUID,
  p_produto_id     UUID,
  p_sessao_id      UUID,
  p_data_producao  DATE,
  p_quantidade     INTEGER,
  p_responsavel_id UUID,
  p_validade        DATE DEFAULT NULL,
  p_data_desenforma DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_validade_dias INTEGER;
  v_validade      DATE;
  v_codigo        TEXT;
  v_qr_code       TEXT;
  v_lote_id       UUID;
BEGIN
  SELECT validade_dias INTO v_validade_dias
    FROM produtos
   WHERE id = p_produto_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Produto não encontrado.');
  END IF;

  -- A validade vem pronta da pós-produção. Sem ela, o comportamento antigo:
  -- conta da produção, e um ano quando o produto não tem prazo cadastrado.
  v_validade := COALESCE(
    p_validade,
    p_data_producao + COALESCE(v_validade_dias, 365)
  );

  v_codigo  := gerar_proximo_codigo(p_empresa_id, 'lotes_produto', 'LPROD');
  v_qr_code := 'QR-' || v_codigo;

  INSERT INTO lotes_produto (
    empresa_id, codigo, produto_id, sessao_id,
    data_producao, data_desenforma, validade,
    quantidade_produzida, quantidade_disponivel,
    status, qr_code
  )
  VALUES (
    p_empresa_id, v_codigo, p_produto_id, p_sessao_id,
    p_data_producao, p_data_desenforma, v_validade,
    p_quantidade, p_quantidade,
    'ativo', v_qr_code
  )
  RETURNING id INTO v_lote_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lote_id', v_lote_id,
    'codigo', v_codigo,
    'validade', v_validade,
    'qr_code', v_qr_code
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── registrar_pos_producao: agora é ela que cria os lotes ───
DROP FUNCTION IF EXISTS registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE);

CREATE OR REPLACE FUNCTION registrar_pos_producao(
  p_empresa_id     UUID,
  p_sessao_id      UUID,
  p_responsavel_id UUID,
  p_descartes      JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_data           DATE DEFAULT NULL,
  p_partes         JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_data_producao DATE;
  v_data_pos      DATE := COALESCE(p_data, CURRENT_DATE);
  v_pos_id        UUID;
  v_item          JSONB;
  v_qtd           INTEGER;
  v_sku           RECORD;
  v_parte         RECORD;
  v_n             INTEGER := 0;
  v_boas          INTEGER;
  v_soma          INTEGER;
  v_sem_validade  INTEGER;
  v_lote_id       UUID;
  v_lote          JSONB;
  v_novo_disp     INTEGER;
  v_keep_prod     UUID[] := '{}';
  v_keep_val      DATE[] := '{}';
  v_mantidos      UUID[] := '{}';
  v_avisos        TEXT[] := '{}';
  v_lotes_presos  TEXT;
  v_lotes_novos   INTEGER := 0;
BEGIN
  SELECT data_producao INTO v_data_producao
    FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'fechada';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'A sessão precisa estar fechada para registrar a pós-produção.');
  END IF;

  -- ════════════════════════════════════════════════════════
  -- FASE 1 — conferência. Nada é escrito aqui.
  -- ════════════════════════════════════════════════════════
  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id,
           COALESCE(ft.nome, 'ficha sem nome')            AS ficha_nome,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)             AS rendimento,
           pr.id                                          AS produto_id,
           pr.validade_dias
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
      LEFT JOIN fichas_tecnicas ft         ON ft.id = sk.ficha_tecnica_id
      LEFT JOIN LATERAL (
        SELECT p.id, p.validade_dias
          FROM produtos p
         WHERE p.ficha_tecnica_id = sk.ficha_tecnica_id
           AND p.empresa_id = p_empresa_id AND p.ativo = true
         LIMIT 1
      ) pr ON true
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    -- As boas saem por diferença, como sempre: ninguém conta unidade boa.
    SELECT GREATEST(
             v_sku.formas * v_sku.rendimento
             - COALESCE(SUM(COALESCE((e->>'quantidade')::INTEGER, 0)), 0), 0)
      INTO v_boas
      FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) e
     WHERE (e->>'sessao_sku_id')::UUID = v_sku.id;

    -- Ficha sem produto cadastrado não vira estoque. Avisa em vez de falhar
    -- calada, que foi o que aconteceu no dia 10.
    IF v_sku.produto_id IS NULL THEN
      IF v_boas > 0 THEN
        v_avisos := v_avisos || format(
          '%s não tem produto cadastrado: as %s unidades boas não entraram no estoque.',
          v_sku.ficha_nome, v_boas);
      END IF;
      CONTINUE;
    END IF;

    SELECT COUNT(*) FILTER (
             WHERE NULLIF(e->>'validade','') IS NULL
               AND NULLIF(e->>'data_desenforma','') IS NULL),
           COALESCE(SUM(COALESCE((e->>'quantidade')::INTEGER, 0)), 0)
      INTO v_sem_validade, v_soma
      FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
     WHERE (e->>'sessao_sku_id')::UUID = v_sku.id;

    IF v_sem_validade > 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        'Falta a data de desenforma de uma das partes de %s.', v_sku.ficha_nome));
    END IF;

    IF v_boas > 0 AND v_soma = 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        'Informe a validade das %s unidades boas de %s.', v_boas, v_sku.ficha_nome));
    END IF;

    IF v_soma <> v_boas THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s: as validades somam %s unidades e as boas são %s.',
        v_sku.ficha_nome, v_soma, v_boas));
    END IF;

    -- Guarda (produto, validade) de tudo que vai existir depois desta chamada.
    FOR v_parte IN
      SELECT COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             ) AS validade
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
         AND COALESCE((e->>'quantidade')::INTEGER, 0) > 0
       GROUP BY 1
    LOOP
      v_keep_prod := v_keep_prod || v_sku.produto_id;
      v_keep_val  := v_keep_val  || v_parte.validade;
    END LOOP;
  END LOOP;

  -- Lote que vai deixar de existir e já teve saída não some em silêncio.
  SELECT string_agg(lp.codigo, ', ' ORDER BY lp.codigo)
    INTO v_lotes_presos
    FROM lotes_produto lp
   WHERE lp.sessao_id = p_sessao_id
     AND NOT EXISTS (
       SELECT 1 FROM unnest(v_keep_prod, v_keep_val) AS k(prod, val)
        WHERE k.prod = lp.produto_id AND k.val = lp.validade)
     AND (lp.quantidade_disponivel <> lp.quantidade_produzida
          OR EXISTS (SELECT 1 FROM expedicoes_itens ei
                      WHERE ei.lote_produto_id = lp.id));

  IF v_lotes_presos IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'O lote %s já teve saída e as validades informadas não o incluem. '
      'Mantenha a validade dele ou acerte a expedição primeiro.', v_lotes_presos));
  END IF;

  -- ════════════════════════════════════════════════════════
  -- FASE 2 — escrita.
  -- ════════════════════════════════════════════════════════
  INSERT INTO pos_producao (empresa_id, sessao_id, data, responsavel_id, observacoes)
  VALUES (p_empresa_id, p_sessao_id, v_data_pos, p_responsavel_id, p_observacoes)
  ON CONFLICT (sessao_id) DO UPDATE
     SET data = EXCLUDED.data,
         responsavel_id = EXCLUDED.responsavel_id,
         observacoes = EXCLUDED.observacoes,
         updated_at = NOW()
  RETURNING id INTO v_pos_id;

  DELETE FROM pos_producao_descartes WHERE pos_id = v_pos_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) LOOP
    v_qtd := COALESCE((v_item->>'quantidade')::INTEGER, 0);
    IF v_qtd > 0 THEN
      INSERT INTO pos_producao_descartes (pos_id, sessao_sku_id, motivo_id, quantidade)
      VALUES (v_pos_id, (v_item->>'sessao_sku_id')::UUID,
              (v_item->>'motivo_id')::UUID, v_qtd)
      ON CONFLICT (pos_id, sessao_sku_id, motivo_id)
      DO UPDATE SET quantidade = EXCLUDED.quantidade;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)             AS rendimento,
           pr.id                                          AS produto_id,
           pr.validade_dias
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
      LEFT JOIN LATERAL (
        SELECT p.id, p.validade_dias
          FROM produtos p
         WHERE p.ficha_tecnica_id = sk.ficha_tecnica_id
           AND p.empresa_id = p_empresa_id AND p.ativo = true
         LIMIT 1
      ) pr ON true
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    SELECT COALESCE(SUM(d.quantidade), 0) INTO v_qtd
      FROM pos_producao_descartes d
     WHERE d.pos_id = v_pos_id AND d.sessao_sku_id = v_sku.id;

    v_boas := GREATEST(v_sku.formas * v_sku.rendimento - v_qtd, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_perdida   = v_qtd,
           quantidade_produzida = v_boas
     WHERE id = v_sku.id;

    CONTINUE WHEN v_sku.produto_id IS NULL;

    -- Partes agrupadas pela validade: duas partes do mesmo dia são um lote só.
    FOR v_parte IN
      SELECT COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             )                                                   AS validade,
             MIN(NULLIF(e->>'data_desenforma','')::DATE)         AS desenforma,
             SUM(COALESCE((e->>'quantidade')::INTEGER, 0))::INTEGER AS quantidade
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
         AND COALESCE((e->>'quantidade')::INTEGER, 0) > 0
       GROUP BY 1
    LOOP
      SELECT id INTO v_lote_id
        FROM lotes_produto
       WHERE sessao_id = p_sessao_id
         AND produto_id = v_sku.produto_id
         AND validade = v_parte.validade;

      IF FOUND THEN
        -- Por diferença, para não apagar o que uma expedição já tirou daqui.
        SELECT GREATEST(quantidade_disponivel + (v_parte.quantidade - quantidade_produzida), 0)
          INTO v_novo_disp
          FROM lotes_produto WHERE id = v_lote_id;

        UPDATE lotes_produto
           SET quantidade_produzida  = v_parte.quantidade,
               quantidade_disponivel = v_novo_disp,
               data_desenforma       = COALESCE(v_parte.desenforma, data_desenforma),
               status = CASE
                 WHEN v_novo_disp <= 0        THEN 'esgotado'::status_lote_produto_enum
                 WHEN status = 'esgotado'     THEN 'ativo'::status_lote_produto_enum
                 ELSE status
               END
         WHERE id = v_lote_id;
      ELSE
        v_lote := registrar_lote_produto(
          p_empresa_id, v_sku.produto_id, p_sessao_id,
          v_data_producao, v_parte.quantidade, p_responsavel_id,
          v_parte.validade, COALESCE(v_parte.desenforma, v_data_pos)
        );
        v_lote_id := (v_lote->>'lote_id')::UUID;
        v_lotes_novos := v_lotes_novos + 1;
      END IF;

      v_mantidos := v_mantidos || v_lote_id;
    END LOOP;
  END LOOP;

  -- O que sobrou está intocado — a fase 1 garantiu isso.
  DELETE FROM lotes_produto
   WHERE sessao_id = p_sessao_id
     AND NOT (id = ANY(v_mantidos));

  RETURN jsonb_build_object(
    'ok', true,
    'pos_id', v_pos_id,
    'descartes', v_n,
    'lotes', COALESCE(array_length(v_mantidos, 1), 0),
    'lotes_novos', v_lotes_novos,
    'avisos', to_jsonb(v_avisos)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE, JSONB) IS
  'Registra a desenforma: os descartes por motivo, as unidades boas por '
  'diferença e os lotes de produto — um por validade. É aqui que o produto '
  'entra no estoque, não no fechamento da sessão.';

-- ── fechar_sessao_producao não cria mais lote de produto ────
-- (reescrita a partir do pg_get_functiondef do que estava vivo; só o bloco do
--  lote resultante muda. Ficha de insumo continua igual: sub-receita não passa
--  por desenforma, e o insumo produzido entra no estoque no fechamento.)
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

  -- ── Lote resultante ───────────────────────────────────────
  -- PRODUTO não vira lote aqui: o brownie ainda está na forma, e é a
  -- pós-produção que sabe quantos saíram inteiros e com que validade (089).
  -- Sub-receita continua entrando no estoque agora — ela não é desenformada.
  IF v_ficha_id IS NOT NULL AND v_qtd_produzida > 0
     AND v_tipo_ficha = 'insumo' AND v_insumo_resultado_id IS NOT NULL THEN
    v_lote_result := registrar_lote_insumo_producao(
      p_empresa_id, v_insumo_resultado_id, p_sessao_id,
      v_data_producao, v_qtd_produzida, p_responsavel_id
    );
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

-- ── A fila da pós é só de produto ───────────────────────────
-- Sessão de sub-receita não é desenformada; ficava na fila para sempre.
-- Só o WHERE muda, então CREATE OR REPLACE basta e o security_invoker fica.
CREATE OR REPLACE VIEW v_pos_producao_pendente AS
 SELECT s.id AS sessao_id,
    s.empresa_id,
    s.codigo,
    s.data_producao,
    s.data_fechamento,
    (CURRENT_DATE - s.data_producao) AS dias_parado,
    (COALESCE(sum(COALESCE(sk.formas_assadas, sk.multiplicador, 0)), (0)::bigint))::integer AS formas,
    (COALESCE(sum((COALESCE(sk.formas_assadas, sk.multiplicador, 0) * COALESCE(v.rendimento_fornada, 0))), (0)::bigint))::integer AS unidades_teoricas
   FROM (((sessoes_producao s
     JOIN sessoes_producao_skus sk ON ((sk.sessao_id = s.id)))
     LEFT JOIN fichas_tecnicas_versoes v ON ((v.id = sk.ficha_versao_id)))
     LEFT JOIN fichas_tecnicas ft ON ((ft.id = sk.ficha_tecnica_id)))
  WHERE ((s.status = 'fechada'::status_sessao_enum)
     AND (COALESCE(ft.tipo, 'produto') <> 'insumo')
     AND (NOT (EXISTS ( SELECT 1
           FROM pos_producao p
          WHERE (p.sessao_id = s.id)))))
  GROUP BY s.id, s.empresa_id, s.codigo, s.data_producao, s.data_fechamento;

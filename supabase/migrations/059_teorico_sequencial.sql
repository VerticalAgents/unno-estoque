-- ============================================================
-- Migration 059 — O consumo teórico vira fila, não divisão
--
-- PROBLEMA
-- A 038 passou a ratear o teórico entre TODOS os recipientes do insumo, na
-- proporção do que cada um tinha. Com dois potes de açúcar de 17 kg e uma
-- necessidade de 30,764 kg, cada pote ficava com metade: 15,382. A tela então
-- pedia para tirar 15,382 de cada pote — deixando 1,6 kg parado no #1 e outro
-- tanto no #2.
--
-- Não é assim que se produz. Raspa-se o primeiro pote até acabar e só então
-- se abre o segundo. Menos pote aberto, menos sobra velha, menos lote em
-- circulação — e o FEFO só funciona se o mais antigo for esvaziado de fato.
--
-- A 038 estava certa no problema que resolveu (o teórico ia todo para o
-- primeiro LOTE e zero nos demais, o que estragava o desvio linha a linha).
-- Errou na solução: dividir entre potes em vez de enfileirar.
--
-- CORREÇÃO
-- O teórico do insumo é despejado pote a pote, na ordem em que se sugere usar:
-- validade mais próxima primeiro e, empatando, o número menor (#1, #2, #3 —
-- por isso `chave_natural`, senão #10 vem antes de #2). Cada pote absorve até
-- o que tem dentro; o que sobrar passa ao seguinte.
--
-- Dentro de um pote com lotes misturados o rateio proporcional CONTINUA — ali
-- ele é obrigatório, porque a balança pesa o pote e ninguém sabe de qual lote
-- veio cada grama. É a mesma regra do fechamento (036).
--
-- O último pote da fila absorve o que faltar quando o estoque produtivo não
-- cobre a necessidade. Sem isso a soma dos teóricos ficaria menor que a
-- necessidade real e o `fator_perda_insumos` do fechamento sairia otimista.
-- ============================================================

CREATE OR REPLACE FUNCTION redistribuir_teorico_sequencial(p_sessao_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_insumo     RECORD;
  v_pote       RECORD;
  v_linha      RECORD;
  v_restante   DECIMAL;
  v_cota_pote  DECIMAL;
  v_cota_linha DECIMAL;
  v_acumulado  DECIMAL;
  v_potes      INTEGER;
  v_linhas     INTEGER;
  v_tocadas    INTEGER := 0;
BEGIN
  FOR v_insumo IN
    SELECT insumo_id, SUM(consumo_teorico) AS total
      FROM sessoes_producao_locais
     WHERE sessao_id = p_sessao_id
     GROUP BY insumo_id
    HAVING SUM(consumo_teorico) > 0
  LOOP
    v_restante := v_insumo.total;

    SELECT COUNT(*) INTO v_potes FROM (
      SELECT spl.local_id
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.insumo_id = v_insumo.insumo_id
       GROUP BY spl.local_id
      HAVING SUM(spl.quantidade_inicial) > 0
    ) t;

    CONTINUE WHEN v_potes = 0;

    FOR v_pote IN
      SELECT spl.local_id, SUM(spl.quantidade_inicial) AS no_pote
        FROM sessoes_producao_locais spl
        JOIN locais l  ON l.id  = spl.local_id
        LEFT JOIN lotes lo ON lo.id = spl.lote_id
       WHERE spl.sessao_id = p_sessao_id AND spl.insumo_id = v_insumo.insumo_id
       GROUP BY spl.local_id, l.nome
      HAVING SUM(spl.quantidade_inicial) > 0
       ORDER BY MIN(lo.validade_pos_abertura) NULLS LAST, chave_natural(l.nome)
    LOOP
      v_potes := v_potes - 1;

      -- O último da fila leva o que faltar, mesmo que passe do que tem dentro:
      -- é assim que a soma dos teóricos continua igual à necessidade real.
      IF v_potes = 0 THEN
        v_cota_pote := GREATEST(v_restante, 0);
      ELSE
        v_cota_pote := GREATEST(LEAST(v_restante, v_pote.no_pote), 0);
      END IF;

      v_restante := v_restante - v_cota_pote;

      SELECT COUNT(*) INTO v_linhas
        FROM sessoes_producao_locais
       WHERE sessao_id = p_sessao_id AND local_id = v_pote.local_id
         AND insumo_id = v_insumo.insumo_id;

      v_acumulado := 0;

      FOR v_linha IN
        SELECT spl.id, spl.quantidade_inicial
          FROM sessoes_producao_locais spl
         WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_pote.local_id
           AND spl.insumo_id = v_insumo.insumo_id
         ORDER BY spl.quantidade_inicial DESC, spl.id
      LOOP
        v_linhas := v_linhas - 1;

        -- Dentro do pote, proporcional; a última linha fecha o arredondamento.
        IF v_linhas = 0 THEN
          v_cota_linha := v_cota_pote - v_acumulado;
        ELSE
          v_cota_linha := ROUND(
            v_cota_pote * (v_linha.quantidade_inicial / v_pote.no_pote), 3);
        END IF;

        UPDATE sessoes_producao_locais
           SET consumo_teorico = GREATEST(v_cota_linha, 0)
         WHERE id = v_linha.id;

        v_acumulado := v_acumulado + v_cota_linha;
        v_tocadas   := v_tocadas + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_tocadas;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION redistribuir_teorico_sequencial IS
  'Enfileira o consumo teórico do insumo pote a pote (validade, depois número) '
  'em vez de dividi-lo entre todos. Dentro de cada pote segue proporcional.';

DROP FUNCTION IF EXISTS abrir_sessao_producao_v2(UUID, UUID, DATE, JSONB, TEXT);

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

  RETURN jsonb_build_object(
    'ok', true, 'sessao_id', v_sessao_id, 'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades, 'locais_vinculados', v_locais_vinculados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- atualizar_plano_sessao — mudar as formas com a sessão aberta
--
-- Recalcula quantidade planejada e consumo teórico. NÃO mexe em
-- `quantidade_inicial`: aquilo é a foto do que havia no pote quando a sessão
-- abriu, e é dela que sai o consumo real no fechamento. Adulterar destruiria
-- a medição.
-- ============================================================
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

  RETURN jsonb_build_object('ok', true, 'quantidade_planejada', v_total_unidades);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Sessões abertas agora seguem a regra nova
--
-- Quem está com uma sessão aberta neste momento veria os números antigos até
-- fechá-la. Como a redistribuição só reparte um total que já está gravado,
-- refazê-la é seguro: `quantidade_inicial` — a foto do pote na abertura, de
-- onde sai o consumo real — não é tocada.
-- ============================================================
DO $$
DECLARE
  v_sessao UUID;
BEGIN
  FOR v_sessao IN SELECT id FROM sessoes_producao WHERE status = 'aberta' LOOP
    PERFORM redistribuir_teorico_sequencial(v_sessao);
  END LOOP;
END $$;

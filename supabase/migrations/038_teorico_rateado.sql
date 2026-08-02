-- ============================================================
-- Migration 038 — Consumo teórico também rateado
--
-- `abrir_sessao_producao` (v1 e v2) jogava TODO o consumo teórico do insumo no
-- primeiro recipiente e zero nos demais. Com um recipiente por insumo isso não
-- aparecia. Com mistura, aparece: o segundo lote fica com consumo real 3,6 kg
-- contra teórico 0, e o `desvio` — que é o indicador de eficiência da produção
-- — vira ruído.
--
-- O total sempre fechou (o fator de perda soma tudo), mas a leitura linha a
-- linha era enganosa.
--
-- Agora o teórico é distribuído na mesma proporção do rateio de consumo, então
-- `desvio` passa a significar a mesma coisa em todas as linhas.
-- ============================================================

CREATE OR REPLACE FUNCTION abrir_sessao_producao_v2(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_producao  DATE,
  p_plano          JSONB,
  p_observacoes    TEXT DEFAULT NULL
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
    SELECT (e->>'ficha_id')::UUID   AS ficha_id,
           (e->>'versao_id')::UUID  AS versao_id,
           (e->>'formas')::INTEGER  AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes
     WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (
      v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
      v_rendimento * v_ficha.formas, v_ficha.formas
    );

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
    -- Uma linha por (recipiente, lote) do insumo, com o teórico rateado na
    -- proporção do que cada lote tem — mesma lógica do rateio de consumo.
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT
      v_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
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

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', v_sessao_id,
    'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades,
    'locais_vinculados', v_locais_vinculados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

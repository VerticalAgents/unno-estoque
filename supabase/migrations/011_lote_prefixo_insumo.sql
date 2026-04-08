-- ============================================================
-- Migration 011 — Prefixo do lote = código do insumo
-- Formato: INS014-0001 / INS014-0001.1/3 … INS014-0001.3/3
-- Sequencial é por insumo (MAX independente por prefixo).
-- ============================================================

-- ── 1. registrar_entrada_lote — usa codigo do insumo como prefixo
CREATE OR REPLACE FUNCTION registrar_entrada_lote(
  p_empresa_id          UUID,
  p_insumo_id           UUID,
  p_fornecedor_id       UUID,
  p_data_recebimento    DATE,
  p_validade_original   DATE,
  p_quantidade_recebida DECIMAL,
  p_unidade             TEXT,
  p_num_etiquetas       INTEGER  DEFAULT 1,
  p_observacoes         TEXT     DEFAULT NULL,
  p_responsavel_id      UUID     DEFAULT NULL,
  p_numero_nf           TEXT     DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_grupo_id           UUID    := uuid_generate_v4();
  v_insumo_codigo      TEXT;
  v_lote_codigo_base   TEXT;
  v_lote_codigo        TEXT;
  v_qr_code            TEXT;
  v_validade_calculada DATE;
  v_lote_id            UUID;
  v_mov_id             UUID;
  v_mov_codigo         TEXT;
  v_lotes_criados      JSONB   := '[]'::JSONB;
  v_qtd_por_etiqueta   DECIMAL;
  v_qtd_ultima         DECIMAL;
  i                    INTEGER;
  v_qtd_i              DECIMAL;
BEGIN
  IF p_num_etiquetas < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Número de etiquetas deve ser >= 1.');
  END IF;

  -- Busca o código do insumo para usar como prefixo
  SELECT codigo INTO v_insumo_codigo FROM insumos WHERE id = p_insumo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id, p_validade_original, p_data_recebimento
  );

  v_qtd_por_etiqueta := ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3);
  v_qtd_ultima := p_quantidade_recebida - (v_qtd_por_etiqueta * (p_num_etiquetas - 1));

  -- Código base: INS014-0001 (sequencial por insumo)
  v_lote_codigo_base := gerar_proximo_codigo(p_empresa_id, 'lotes', v_insumo_codigo);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  FOR i IN 1..p_num_etiquetas LOOP
    v_qtd_i := CASE WHEN i = p_num_etiquetas THEN v_qtd_ultima ELSE v_qtd_por_etiqueta END;

    -- Único: INS014-0001 | Múltiplos: INS014-0001.1/3, INS014-0001.2/3 …
    v_lote_codigo := CASE
      WHEN p_num_etiquetas = 1 THEN v_lote_codigo_base
      ELSE v_lote_codigo_base || '.' || i || '/' || p_num_etiquetas
    END;
    v_qr_code := 'QR-' || v_lote_codigo;

    INSERT INTO lotes (
      id, empresa_id, codigo, insumo_id, fornecedor_id,
      data_recebimento, data_fabricacao,
      validade_original, validade_pos_abertura,
      quantidade_recebida, unidade, quantidade_disponivel,
      recebido_por, qr_code, observacoes, numero_nf, lote_grupo_id
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes, p_numero_nf, v_grupo_id
    ) RETURNING id INTO v_lote_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, v_qtd_i, p_unidade::unidade_medida_enum);

    v_lotes_criados := v_lotes_criados || jsonb_build_object(
      'lote_id',    v_lote_id,
      'codigo',     v_lote_codigo,
      'qr_code',    v_qr_code,
      'quantidade', v_qtd_i
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok',    true,
    'lotes', v_lotes_criados,
    'lote_id',               (v_lotes_criados->0->>'lote_id')::UUID,
    'lote_codigo',           v_lotes_criados->0->>'codigo',
    'qr_code',               v_lotes_criados->0->>'qr_code',
    'validade_pos_abertura', v_validade_calculada,
    'lote_grupo_id',         v_grupo_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 2. Migração de dados — renomeia lotes de LOTE-XXXX para INSXXX-XXXX
-- Substitui o prefixo 'LOTE' pelo codigo do insumo, mantendo o resto intacto.
-- LOTE-0001     → INS014-0001
-- LOTE-0001.1/3 → INS014-0001.1/3
UPDATE lotes l
SET
  codigo  = i.codigo || SUBSTRING(l.codigo FROM 5),
  qr_code = 'QR-' || i.codigo || SUBSTRING(l.codigo FROM 5)
FROM insumos i
WHERE l.insumo_id = i.id
  AND l.codigo ~ '^LOTE-';

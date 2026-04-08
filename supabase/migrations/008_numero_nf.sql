-- ============================================================
-- Migration 008 — Número da Nota Fiscal no lote
-- ============================================================

ALTER TABLE lotes
  ADD COLUMN IF NOT EXISTS numero_nf VARCHAR(50);

-- Atualiza o RPC para aceitar e persistir p_numero_nf
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
  v_lote_codigo        TEXT;
  v_qr_code            TEXT;
  v_validade_calculada DATE;
  v_lote_id            UUID;
  v_mov_id             UUID;
  v_mov_codigo         TEXT;
  v_lotes_criados      JSONB := '[]'::JSONB;
  v_qtd_por_etiqueta   DECIMAL;
  v_qtd_ultima         DECIMAL;
  i                    INTEGER;
  v_qtd_i              DECIMAL;
BEGIN
  IF p_num_etiquetas < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Número de etiquetas deve ser >= 1.');
  END IF;

  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id,
    p_validade_original,
    p_data_recebimento
  );

  v_qtd_por_etiqueta := ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3);
  v_qtd_ultima := p_quantidade_recebida - (v_qtd_por_etiqueta * (p_num_etiquetas - 1));

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  FOR i IN 1..p_num_etiquetas LOOP
    v_qtd_i := CASE WHEN i = p_num_etiquetas THEN v_qtd_ultima ELSE v_qtd_por_etiqueta END;

    v_lote_codigo := gerar_proximo_codigo(p_empresa_id, 'lotes', 'LOTE');
    v_qr_code     := 'QR-' || v_lote_codigo;

    INSERT INTO lotes (
      id, empresa_id, codigo, insumo_id, fornecedor_id,
      data_recebimento, data_fabricacao,
      validade_original, validade_pos_abertura,
      quantidade_recebida, unidade, quantidade_disponivel,
      recebido_por, qr_code, observacoes, numero_nf
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes, p_numero_nf
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
    'lote_id',              (v_lotes_criados->0->>'lote_id')::UUID,
    'lote_codigo',          v_lotes_criados->0->>'codigo',
    'qr_code',              v_lotes_criados->0->>'qr_code',
    'validade_pos_abertura', v_validade_calculada
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

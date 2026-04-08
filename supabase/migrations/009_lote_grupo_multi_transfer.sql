-- ============================================================
-- Migration 009 — Lote grupo + transferência multi-sublote
-- Permite transferir N sublotes do mesmo lote de recebimento
-- para um único recipiente em uma só operação.
-- ============================================================

-- ── 1. Coluna lote_grupo_id ─────────────────────────────────
ALTER TABLE lotes
  ADD COLUMN IF NOT EXISTS lote_grupo_id UUID;

-- Popula lotes existentes: agrupa por (insumo, data, validade, fornecedor, minuto)
-- e usa o id do primeiro lote do grupo como referência
WITH grouped AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY
        insumo_id,
        data_recebimento,
        validade_original,
        COALESCE(fornecedor_id::text, ''),
        date_trunc('minute', created_at)
      ORDER BY created_at
    ) AS grupo_id
  FROM lotes
)
UPDATE lotes l
SET lote_grupo_id = g.grupo_id
FROM grouped g
WHERE l.id = g.id AND l.lote_grupo_id IS NULL;

-- ── 2. registrar_entrada_lote — popula lote_grupo_id ────────
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

  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id, p_validade_original, p_data_recebimento
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

-- ── 3. realizar_transferencia_multipla ──────────────────────
-- Transfere N sublotes do mesmo lote_grupo_id para um recipiente
-- em uma única transação atômica. RO-003: recipiente deve estar vazio.
CREATE OR REPLACE FUNCTION realizar_transferencia_multipla(
  p_lote_ids       UUID[],
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID
)
RETURNS JSONB AS $$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_lote_id       UUID;
  v_grupo_id      UUID;
  v_primeiro_id   UUID;
  v_qtd_total     DECIMAL := 0;
  v_unidade       unidade_medida_enum;
  v_insumo        insumos%ROWTYPE;
  v_validade_ep   DATE;
  v_estado_local  DECIMAL;
  v_estado_existe BOOLEAN := false;
  v_mov_codigo    TEXT;
  v_mov_id        UUID;
BEGIN
  -- Valida que há lotes
  IF array_length(p_lote_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhum sublote fornecido.');
  END IF;

  -- Primeira passagem: valida todos os lotes e coleta dados
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id AND empresa_id = p_empresa_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro', format('Lote %s não encontrado.', v_lote_id));
    END IF;
    IF v_lote.status != 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
    END IF;

    -- Valida que todos pertencem ao mesmo lote_grupo_id
    IF v_grupo_id IS NULL THEN
      v_grupo_id    := v_lote.lote_grupo_id;
      v_primeiro_id := v_lote_id;
      v_unidade     := v_lote.unidade;
    ELSE
      IF v_lote.lote_grupo_id IS DISTINCT FROM v_grupo_id THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          'Todos os sublotes devem pertencer ao mesmo lote de recebimento (mesmo lote_grupo_id).');
      END IF;
    END IF;

    v_qtd_total := v_qtd_total + v_lote.quantidade_disponivel;
  END LOOP;

  -- RO-003: recipiente deve estar vazio
  SELECT quantidade INTO v_estado_local FROM locais_estado_atual WHERE local_id = p_local_id;
  IF FOUND THEN
    v_estado_existe := true;
    IF COALESCE(v_estado_local, 0) > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'erro', 'REGRA DE OURO VIOLADA (RO-003): este recipiente já contém insumo. Zere antes de abastecer com novo lote.'
      );
    END IF;
  END IF;

  -- Calcula validade EP via shelf_life do insumo
  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;
  v_validade_ep := CASE
    WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
    THEN CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura
    ELSE NULL
  END;

  -- Cria movimentação única para toda a operação
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  -- Segunda passagem: executa a transferência de cada sublote
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id;

    -- Item de movimentação (quantidade antes de zerar)
    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, p_local_id, v_lote.quantidade_disponivel, v_lote.unidade);

    -- Zera o sublote no EC (transferência é sempre total — RO-002)
    UPDATE lotes
    SET quantidade_disponivel = 0,
        status = 'esgotado'::status_lote_enum
    WHERE id = v_lote_id;
  END LOOP;

  -- Upsert locais_estado_atual com quantidade combinada
  -- lote_id de referência = primeiro sublote escaneado
  IF v_estado_existe THEN
    UPDATE locais_estado_atual
    SET lote_id            = v_primeiro_id,
        quantidade         = v_qtd_total,
        unidade            = v_unidade,
        data_transferencia = CURRENT_DATE,
        validade_ep        = v_validade_ep,
        atualizado_em      = NOW(),
        atualizado_por     = p_responsavel_id
    WHERE local_id = p_local_id;
  ELSE
    INSERT INTO locais_estado_atual
      (local_id, lote_id, quantidade, unidade, data_transferencia, validade_ep, atualizado_por)
    VALUES
      (p_local_id, v_primeiro_id, v_qtd_total, v_unidade, CURRENT_DATE, v_validade_ep, p_responsavel_id);
  END IF;

  RETURN jsonb_build_object(
    'ok',            true,
    'movimentacao_id', v_mov_id,
    'codigo',        v_mov_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

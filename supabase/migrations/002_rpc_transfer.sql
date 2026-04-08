-- ============================================================
-- MISCHAOS — RPC FUNCTIONS
-- Funções atômicas para transferência e reembalagem
-- Executar APÓS o schema principal (001_schema.sql)
-- ============================================================

-- ============================================================
-- HELPER: gerar próximo código sequencial
-- ============================================================
CREATE OR REPLACE FUNCTION gerar_proximo_codigo(
  p_empresa_id UUID,
  p_tabela TEXT,    -- 'lotes', 'movimentacoes', 'reembalagens', 'perdas_insumo'
  p_prefixo TEXT    -- 'LOTE', 'MOV', 'REMB', 'PERDA'
)
RETURNS TEXT AS $$
DECLARE
  v_max INTEGER;
  v_codigo TEXT;
BEGIN
  EXECUTE format(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(codigo FROM %L) AS INTEGER)), 0)
     FROM %I
     WHERE empresa_id = $1 AND codigo LIKE %L',
    length(p_prefixo) + 2,  -- após "PREFIXO-"
    p_tabela,
    p_prefixo || '-%'
  ) INTO v_max USING p_empresa_id;

  v_codigo := p_prefixo || '-' || LPAD((v_max + 1)::TEXT, 4, '0');
  RETURN v_codigo;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: realizar_transferencia
-- Transfere lote do EC para recipiente EP atomicamente.
-- Enforça RO-001 (atomicidade), RO-002 (total), RO-003 (1 lote/recipiente)
-- ============================================================
CREATE OR REPLACE FUNCTION realizar_transferencia(
  p_lote_id        UUID,
  p_local_id       UUID,
  p_quantidade     DECIMAL,
  p_responsavel_id UUID,
  p_empresa_id     UUID
)
RETURNS JSONB AS $$
DECLARE
  v_validacao    JSONB;
  v_lote         lotes%ROWTYPE;
  v_local        locais%ROWTYPE;
  v_estado       locais_estado_atual%ROWTYPE;
  v_mov_codigo   TEXT;
  v_mov_id       UUID;
BEGIN
  -- 1. Busca lote
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  -- 2. Valida quantidade disponível
  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object(
      'ok', false,
      'erro', format('Quantidade insuficiente. Disponível: %s %s', v_lote.quantidade_disponivel, v_lote.unidade)
    );
  END IF;

  -- 3. Valida local destino (RO-003)
  v_validacao := validar_transferencia_para_local(p_local_id, p_lote_id, p_quantidade);
  IF NOT (v_validacao->>'ok')::BOOLEAN THEN
    RETURN v_validacao;
  END IF;

  -- 4. Busca local
  SELECT * INTO v_local FROM locais WHERE id = p_local_id;

  -- 5. Decrementa quantidade do lote
  UPDATE lotes
  SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
      status = CASE
        WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'esgotado'::status_lote_enum
        ELSE status
      END
  WHERE id = p_lote_id;

  -- 6. Upsert locais_estado_atual
  SELECT * INTO v_estado FROM locais_estado_atual WHERE local_id = p_local_id;
  IF FOUND THEN
    UPDATE locais_estado_atual
    SET lote_id      = p_lote_id,
        quantidade   = COALESCE(quantidade, 0) + p_quantidade,
        unidade      = v_lote.unidade,
        atualizado_em = NOW(),
        atualizado_por = p_responsavel_id
    WHERE local_id = p_local_id;
  ELSE
    INSERT INTO locais_estado_atual (local_id, lote_id, quantidade, unidade, atualizado_por)
    VALUES (p_local_id, p_lote_id, p_quantidade, v_lote.unidade, p_responsavel_id);
  END IF;

  -- 7. Cria movimentação
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, NULL, p_local_id, p_quantidade, v_lote.unidade);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: realizar_reembalagem
-- Transforma embalagem original em sub-unidades para o EP.
-- Casos: Nutella → sacos 625g, DDL topping → sacos 600g, Stikadinho → porcionamento
-- ============================================================
CREATE OR REPLACE FUNCTION realizar_reembalagem(
  p_lote_id          UUID,
  p_tipo_resultado   TEXT,       -- 'saco_confeitar', 'porcionamento'
  p_tamanho_porcao   DECIMAL,    -- 625, 600, ou NULL para porcionamento total
  p_qtd_unidades     INTEGER,    -- quantos sacos/unidades gerar
  p_quantidade_total DECIMAL,    -- total de gramas/kg utilizados do lote
  p_responsavel_id   UUID,
  p_empresa_id       UUID,
  p_local_destino_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_insumo        insumos%ROWTYPE;
  v_remb_codigo   TEXT;
  v_remb_id       UUID;
  v_mov_codigo    TEXT;
  v_mov_id        UUID;
  v_unidade_id    UUID;
  v_qr_code       TEXT;
  v_sobra         DECIMAL;
  v_peso_total    DECIMAL;
  v_qr_codes      JSONB := '[]'::JSONB;
  i               INTEGER;
BEGIN
  -- 1. Busca lote e insumo
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  -- 2. Valida quantidade
  IF v_lote.quantidade_disponivel * 1000 < p_quantidade_total AND v_lote.unidade = 'kg' THEN
    -- quantidade_total em gramas, lote em kg
    NULL;
  END IF;

  -- Normaliza: converte kg→g se necessário para cálculo
  v_peso_total := CASE
    WHEN v_lote.unidade = 'kg' THEN p_quantidade_total / 1000
    ELSE p_quantidade_total
  END;

  IF v_lote.quantidade_disponivel < v_peso_total THEN
    RETURN jsonb_build_object(
      'ok', false,
      'erro', format('Quantidade insuficiente. Disponível: %s %s', v_lote.quantidade_disponivel, v_lote.unidade)
    );
  END IF;

  -- 3. Calcula sobra
  IF p_tamanho_porcao IS NOT NULL THEN
    v_sobra := p_quantidade_total - (p_tamanho_porcao * p_qtd_unidades);
  ELSE
    v_sobra := 0;
  END IF;

  -- 4. Registra reembalagem
  v_remb_codigo := gerar_proximo_codigo(p_empresa_id, 'reembalagens', 'REMB');
  INSERT INTO reembalagens (
    empresa_id, codigo, lote_id, insumo_id, responsavel_id,
    quantidade_utilizada, unidade_utilizada,
    tipo_resultado, tamanho_porcao, unidade_porcao,
    quantidade_unidades_geradas, peso_total_gerado, sobra, local_destino_id
  ) VALUES (
    p_empresa_id, v_remb_codigo, p_lote_id, v_lote.insumo_id, p_responsavel_id,
    p_quantidade_total, 'g',
    p_tipo_resultado,
    COALESCE(p_tamanho_porcao, p_quantidade_total),
    'g',
    p_qtd_unidades,
    COALESCE(p_tamanho_porcao * p_qtd_unidades, p_quantidade_total),
    GREATEST(v_sobra, 0),
    p_local_destino_id
  ) RETURNING id INTO v_remb_id;

  -- 5. Gera lotes_unidades para cada sub-unidade
  FOR i IN 1..p_qtd_unidades LOOP
    v_unidade_id := uuid_generate_v4();
    v_qr_code := 'QR-' || v_remb_codigo || '-U' || LPAD(i::TEXT, 2, '0');

    INSERT INTO lotes_unidades (id, lote_id, codigo, tipo_unidade, peso_volume, unidade, status, local_atual_id, qr_code)
    VALUES (
      v_unidade_id,
      p_lote_id,
      v_remb_codigo || '-U' || LPAD(i::TEXT, 2, '0'),
      p_tipo_resultado,
      COALESCE(p_tamanho_porcao, p_quantidade_total),
      'g',
      'no_estoque_produtivo',
      p_local_destino_id,
      v_qr_code
    );

    v_qr_codes := v_qr_codes || jsonb_build_object(
      'id', v_unidade_id,
      'codigo', v_remb_codigo || '-U' || LPAD(i::TEXT, 2, '0'),
      'qr_code', v_qr_code,
      'peso_g', COALESCE(p_tamanho_porcao, p_quantidade_total)
    );
  END LOOP;

  -- 6. Decrementa lote (convertendo g→kg se necessário)
  UPDATE lotes
  SET quantidade_disponivel = quantidade_disponivel - v_peso_total,
      status = CASE
        WHEN quantidade_disponivel - v_peso_total <= 0 THEN 'esgotado'::status_lote_enum
        ELSE status
      END
  WHERE id = p_lote_id;

  -- 7. Movimentação de reembalagem
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'reembalagem', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, p_local_destino_id, p_quantidade_total, 'g');

  RETURN jsonb_build_object(
    'ok', true,
    'reembalagem_id', v_remb_id,
    'codigo', v_remb_codigo,
    'unidades_geradas', p_qtd_unidades,
    'sobra_g', GREATEST(v_sobra, 0),
    'qr_codes', v_qr_codes
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: registrar_entrada_lote
-- Cria lote + movimentação de entrada atomicamente
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_entrada_lote(
  p_empresa_id          UUID,
  p_insumo_id           UUID,
  p_fornecedor_id       UUID,
  p_data_recebimento    DATE,
  p_data_fabricacao     DATE,
  p_validade_original   DATE,
  p_quantidade_recebida DECIMAL,
  p_unidade             TEXT,
  p_observacoes         TEXT,
  p_responsavel_id      UUID
)
RETURNS JSONB AS $$
DECLARE
  v_lote_codigo        TEXT;
  v_qr_code            TEXT;
  v_validade_calculada DATE;
  v_lote_id            UUID;
  v_mov_codigo         TEXT;
  v_mov_id             UUID;
BEGIN
  -- 1. Calcula validade pós-abertura
  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id,
    p_validade_original,
    p_data_recebimento
  );

  -- 2. Gera código do lote
  v_lote_codigo := gerar_proximo_codigo(p_empresa_id, 'lotes', 'LOTE');
  v_qr_code := 'QR-' || v_lote_codigo;

  -- 3. Insere lote
  INSERT INTO lotes (
    id, empresa_id, codigo, insumo_id, fornecedor_id,
    data_recebimento, data_fabricacao,
    validade_original, validade_pos_abertura,
    quantidade_recebida, unidade, quantidade_disponivel,
    recebido_por, qr_code, observacoes
  ) VALUES (
    uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
    p_data_recebimento, p_data_fabricacao,
    p_validade_original, v_validade_calculada,
    p_quantidade_recebida, p_unidade::unidade_medida_enum, p_quantidade_recebida,
    p_responsavel_id, v_qr_code, p_observacoes
  ) RETURNING id INTO v_lote_id;

  -- 4. Cria movimentação de entrada
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
  VALUES (v_mov_id, v_lote_id, p_quantidade_recebida, p_unidade::unidade_medida_enum);

  RETURN jsonb_build_object(
    'ok', true,
    'lote_id', v_lote_id,
    'lote_codigo', v_lote_codigo,
    'qr_code', v_qr_code,
    'validade_pos_abertura', v_validade_calculada
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: fechar_sessao_producao
-- Fecha sessão atomicamente: atualiza consumos, movimentações, locais
-- ============================================================
CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,  -- [{ficha_id, quantidade_produzida, quantidade_perdida}]
  p_locais         JSONB,  -- [{local_id, lote_id, quantidade_final}]
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao     sessoes_producao%ROWTYPE;
  v_sku        JSONB;
  v_local_rec  JSONB;
  v_qtd_ini    DECIMAL;
  v_consumo    DECIMAL;
  v_teorico    DECIMAL;
  v_mov_codigo TEXT;
  v_mov_id     UUID;
BEGIN
  -- 1. Valida sessão
  SELECT * INTO v_sessao FROM sessoes_producao
  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  -- 2. Atualiza SKUs produzidos
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    UPDATE sessoes_producao_skus
    SET quantidade_produzida = (v_sku->>'quantidade_produzida')::INTEGER,
        quantidade_perdida   = (v_sku->>'quantidade_perdida')::INTEGER
    WHERE sessao_id = p_sessao_id
      AND ficha_tecnica_id = (v_sku->>'ficha_id')::UUID;
  END LOOP;

  -- 3. Atualiza locais: consumo real, desvio, estado atual
  FOR v_local_rec IN SELECT * FROM jsonb_array_elements(p_locais) LOOP
    SELECT quantidade_inicial INTO v_qtd_ini
    FROM sessoes_producao_locais
    WHERE sessao_id = p_sessao_id
      AND local_id = (v_local_rec->>'local_id')::UUID
      AND lote_id  = (v_local_rec->>'lote_id')::UUID;

    v_consumo := v_qtd_ini - (v_local_rec->>'quantidade_final')::DECIMAL;

    SELECT consumo_teorico INTO v_teorico
    FROM sessoes_producao_locais
    WHERE sessao_id = p_sessao_id
      AND local_id = (v_local_rec->>'local_id')::UUID
      AND lote_id  = (v_local_rec->>'lote_id')::UUID;

    UPDATE sessoes_producao_locais
    SET quantidade_final = (v_local_rec->>'quantidade_final')::DECIMAL,
        consumo_real     = v_consumo,
        desvio           = v_consumo - COALESCE(v_teorico, 0)
    WHERE sessao_id = p_sessao_id
      AND local_id  = (v_local_rec->>'local_id')::UUID
      AND lote_id   = (v_local_rec->>'lote_id')::UUID;

    -- Decrementa lote
    UPDATE lotes
    SET quantidade_disponivel = GREATEST(quantidade_disponivel - v_consumo, 0),
        status = CASE
          WHEN GREATEST(quantidade_disponivel - v_consumo, 0) <= 0 THEN 'esgotado'::status_lote_enum
          ELSE status
        END
    WHERE id = (v_local_rec->>'lote_id')::UUID;

    -- Atualiza locais_estado_atual
    UPDATE locais_estado_atual
    SET quantidade  = (v_local_rec->>'quantidade_final')::DECIMAL,
        atualizado_em = NOW(),
        atualizado_por = p_responsavel_id
    WHERE local_id = (v_local_rec->>'local_id')::UUID;

    -- Movimentação de consumo
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, sessao_producao_id)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'consumo_producao', p_responsavel_id, p_sessao_id)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
    SELECT v_mov_id, (v_local_rec->>'lote_id')::UUID, (v_local_rec->>'local_id')::UUID,
           v_consumo, unidade
    FROM lotes WHERE id = (v_local_rec->>'lote_id')::UUID;
  END LOOP;

  -- 4. Fecha sessão
  UPDATE sessoes_producao
  SET status            = 'fechada',
      fechada_por       = p_responsavel_id,
      data_fechamento   = NOW(),
      observacoes_fechamento = p_observacoes
  WHERE id = p_sessao_id;

  RETURN jsonb_build_object('ok', true, 'sessao_id', p_sessao_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: registrar_perda_insumo
-- Registra perda + movimentação atomicamente
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_perda_insumo(
  p_empresa_id     UUID,
  p_lote_id        UUID,
  p_insumo_id      UUID,
  p_local_id       UUID,
  p_quantidade     DECIMAL,
  p_unidade        TEXT,
  p_motivo         TEXT,
  p_descricao      TEXT,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_perda_codigo TEXT;
  v_perda_id     UUID;
  v_mov_codigo   TEXT;
  v_mov_id       UUID;
  v_lote         lotes%ROWTYPE;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Quantidade a descartar maior que disponível.');
  END IF;

  -- Registra perda
  v_perda_codigo := gerar_proximo_codigo(p_empresa_id, 'perdas_insumo', 'PERDA');
  INSERT INTO perdas_insumo (
    empresa_id, codigo, lote_id, insumo_id, local_id,
    quantidade, unidade, motivo, descricao, responsavel_id
  ) VALUES (
    p_empresa_id, v_perda_codigo, p_lote_id, p_insumo_id, p_local_id,
    p_quantidade, p_unidade::unidade_medida_enum,
    p_motivo::motivo_perda_enum, p_descricao, p_responsavel_id
  ) RETURNING id INTO v_perda_id;

  -- Decrementa lote
  UPDATE lotes
  SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
      status = CASE
        WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'descartado'::status_lote_enum
        ELSE status
      END
  WHERE id = p_lote_id;

  -- Movimentação
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'perda_insumo', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, p_local_id, p_quantidade, p_unidade::unidade_medida_enum);

  RETURN jsonb_build_object('ok', true, 'perda_id', v_perda_id, 'codigo', v_perda_codigo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

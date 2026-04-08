-- ============================================================
-- Migration 004 — Melhorias Sprint Feedback
-- 1. tamanho_embalagem em insumos
-- 2. validade_ep / data_transferencia em locais_estado_atual
-- 3. Fix race condition em gerar_proximo_codigo
-- 4. registrar_entrada_lote com suporte a fracionamento
-- 5. realizar_transferencia calcula validade_ep
-- 6. v_estoque_consolidado reescrita (fix estoque zerado)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Novos campos
-- ------------------------------------------------------------
ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS tamanho_embalagem DECIMAL(10,3);

ALTER TABLE locais_estado_atual
  ADD COLUMN IF NOT EXISTS data_transferencia DATE,
  ADD COLUMN IF NOT EXISTS validade_ep DATE;

-- ------------------------------------------------------------
-- 2. Fix: gerar_proximo_codigo — advisory lock para evitar
--    race condition (duplicate key em QR codes)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION gerar_proximo_codigo(
  p_empresa_id UUID,
  p_tabela     TEXT,
  p_prefixo    TEXT
)
RETURNS TEXT AS $$
DECLARE
  v_max    INTEGER;
  v_codigo TEXT;
BEGIN
  -- Lock exclusivo por (empresa, tabela) para serializar geração de códigos
  PERFORM pg_advisory_xact_lock(
    ('x' || md5(p_empresa_id::text || p_tabela))::bit(64)::bigint
  );

  EXECUTE format(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(codigo FROM %L) AS INTEGER)), 0)
     FROM %I
     WHERE empresa_id = $1 AND codigo LIKE %L',
    length(p_prefixo) + 2,
    p_tabela,
    p_prefixo || '-%'
  ) INTO v_max USING p_empresa_id;

  v_codigo := p_prefixo || '-' || LPAD((v_max + 1)::TEXT, 4, '0');
  RETURN v_codigo;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 3. registrar_entrada_lote — com fracionamento em N etiquetas
--    Remove p_data_fabricacao (sempre NULL agora)
--    Adiciona p_num_etiquetas (padrão 1)
--    Retorna array de lotes criados
-- ------------------------------------------------------------
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
  p_responsavel_id      UUID     DEFAULT NULL
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
  -- Valida número de etiquetas
  IF p_num_etiquetas < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Número de etiquetas deve ser >= 1.');
  END IF;

  -- Calcula validade pós-abertura (mantida para compatibilidade na etiqueta)
  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id,
    p_validade_original,
    p_data_recebimento
  );

  -- Calcula quantidade por etiqueta (distribui uniformemente, última recebe o resto)
  v_qtd_por_etiqueta := ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3);
  v_qtd_ultima := p_quantidade_recebida - (v_qtd_por_etiqueta * (p_num_etiquetas - 1));

  -- Cria uma movimentação de entrada para o lote
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  -- Cria N lotes
  FOR i IN 1..p_num_etiquetas LOOP
    v_qtd_i := CASE WHEN i = p_num_etiquetas THEN v_qtd_ultima ELSE v_qtd_por_etiqueta END;

    v_lote_codigo := gerar_proximo_codigo(p_empresa_id, 'lotes', 'LOTE');
    v_qr_code     := 'QR-' || v_lote_codigo;

    INSERT INTO lotes (
      id, empresa_id, codigo, insumo_id, fornecedor_id,
      data_recebimento, data_fabricacao,
      validade_original, validade_pos_abertura,
      quantidade_recebida, unidade, quantidade_disponivel,
      recebido_por, qr_code, observacoes
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes
    ) RETURNING id INTO v_lote_id;

    -- Item da movimentação de entrada
    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, v_qtd_i, p_unidade::unidade_medida_enum);

    v_lotes_criados := v_lotes_criados || jsonb_build_object(
      'lote_id',   v_lote_id,
      'codigo',    v_lote_codigo,
      'qr_code',   v_qr_code,
      'quantidade', v_qtd_i
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok',    true,
    'lotes', v_lotes_criados,
    -- Compat: expõe o primeiro lote no nível raiz para não quebrar código antigo
    'lote_id',             (v_lotes_criados->0->>'lote_id')::UUID,
    'lote_codigo',         v_lotes_criados->0->>'codigo',
    'qr_code',             v_lotes_criados->0->>'qr_code',
    'validade_pos_abertura', v_validade_calculada
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 4. realizar_transferencia — calcula e salva validade_ep
-- ------------------------------------------------------------
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
  v_insumo       insumos%ROWTYPE;
  v_local        locais%ROWTYPE;
  v_estado       locais_estado_atual%ROWTYPE;
  v_mov_codigo   TEXT;
  v_mov_id       UUID;
  v_validade_ep  DATE;
BEGIN
  -- 1. Busca lote
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  -- 2. Busca insumo (para shelf_life_dias_pos_abertura)
  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  -- 3. Valida quantidade disponível
  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object(
      'ok', false,
      'erro', format('Quantidade insuficiente. Disponível: %s %s', v_lote.quantidade_disponivel, v_lote.unidade)
    );
  END IF;

  -- 4. Valida local destino (RO-003)
  v_validacao := validar_transferencia_para_local(p_local_id, p_lote_id, p_quantidade);
  IF NOT (v_validacao->>'ok')::BOOLEAN THEN
    RETURN v_validacao;
  END IF;

  -- 5. Busca local
  SELECT * INTO v_local FROM locais WHERE id = p_local_id;

  -- 6. Calcula validade EP = hoje + shelf_life_dias
  v_validade_ep := CASE
    WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
    THEN CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura
    ELSE NULL
  END;

  -- 7. Decrementa quantidade do lote (EC)
  UPDATE lotes
  SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
      status = CASE
        WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'esgotado'::status_lote_enum
        ELSE status
      END
  WHERE id = p_lote_id;

  -- 8. Upsert locais_estado_atual (EP), com validade_ep calculada
  SELECT * INTO v_estado FROM locais_estado_atual WHERE local_id = p_local_id;
  IF FOUND THEN
    UPDATE locais_estado_atual
    SET lote_id           = p_lote_id,
        quantidade        = COALESCE(quantidade, 0) + p_quantidade,
        unidade           = v_lote.unidade,
        data_transferencia = CURRENT_DATE,
        validade_ep       = v_validade_ep,
        atualizado_em     = NOW(),
        atualizado_por    = p_responsavel_id
    WHERE local_id = p_local_id;
  ELSE
    INSERT INTO locais_estado_atual
      (local_id, lote_id, quantidade, unidade, data_transferencia, validade_ep, atualizado_por)
    VALUES
      (p_local_id, p_lote_id, p_quantidade, v_lote.unidade, CURRENT_DATE, v_validade_ep, p_responsavel_id);
  END IF;

  -- 9. Cria movimentação
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, NULL, p_local_id, p_quantidade, v_lote.unidade);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo,
    'validade_ep', v_validade_ep
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 5. v_estoque_consolidado — reescrita com CTEs
--    Fix: lotes recém-recebidos agora aparecem no EC
--    EC = lotes.quantidade_disponivel (decrementado na transferência)
--    EP = locais_estado_atual.quantidade
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_estoque_consolidado AS
WITH ec AS (
  SELECT
    l.insumo_id,
    l.empresa_id,
    SUM(l.quantidade_disponivel) AS qtd
  FROM lotes l
  WHERE l.status = 'ativo'
  GROUP BY l.insumo_id, l.empresa_id
),
ep AS (
  SELECT
    l.insumo_id,
    SUM(lea.quantidade) AS qtd
  FROM locais_estado_atual lea
  JOIN lotes l ON l.id = lea.lote_id
  GROUP BY l.insumo_id
)
SELECT
  i.empresa_id,
  i.id                   AS insumo_id,
  i.codigo               AS insumo_codigo,
  i.nome                 AS insumo_nome,
  i.unidade_medida,
  i.estoque_minimo,
  COALESCE(ec.qtd, 0)    AS qtd_estoque_central,
  COALESCE(ep.qtd, 0)    AS qtd_estoque_produtivo,
  COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0) AS qtd_total,
  (
    COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0)
  ) < COALESCE(i.estoque_minimo, 0)            AS alerta_reposicao
FROM insumos i
LEFT JOIN ec ON ec.insumo_id = i.id AND ec.empresa_id = i.empresa_id
LEFT JOIN ep ON ep.insumo_id = i.id;

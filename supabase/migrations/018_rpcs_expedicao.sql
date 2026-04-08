-- Migration 018: RPCs para lotes de produto e expedição

-- ============================================================
-- RPC: registrar_lote_produto
-- Cria um lote de produto acabado a partir de uma sessão fechada
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_lote_produto(
  p_empresa_id     UUID,
  p_produto_id     UUID,
  p_sessao_id      UUID,
  p_data_producao  DATE,
  p_quantidade     INTEGER,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_validade_dias INTEGER;
  v_validade      DATE;
  v_codigo        TEXT;
  v_qr_code       TEXT;
  v_lote_id       UUID;
BEGIN
  -- 1. Busca validade do produto
  SELECT validade_dias INTO v_validade_dias
  FROM produtos
  WHERE id = p_produto_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Produto não encontrado.');
  END IF;

  -- 2. Calcula validade
  IF v_validade_dias IS NOT NULL THEN
    v_validade := p_data_producao + v_validade_dias;
  ELSE
    -- Sem validade configurada: 1 ano por padrão
    v_validade := p_data_producao + 365;
  END IF;

  -- 3. Gera código
  v_codigo := gerar_proximo_codigo(p_empresa_id, 'lotes_produto', 'LPROD');
  v_qr_code := 'QR-' || v_codigo;

  -- 4. Insere lote
  INSERT INTO lotes_produto (
    empresa_id, codigo, produto_id, sessao_id,
    data_producao, validade,
    quantidade_produzida, quantidade_disponivel,
    status, qr_code
  )
  VALUES (
    p_empresa_id, v_codigo, p_produto_id, p_sessao_id,
    p_data_producao, v_validade,
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


-- ============================================================
-- RPC: criar_expedicao
-- Cria expedição e decrementa lotes de produto
-- ============================================================
CREATE OR REPLACE FUNCTION criar_expedicao(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_expedicao DATE,
  p_destinatario   TEXT,
  p_observacoes    TEXT,
  p_itens          JSONB  -- [{lote_produto_id, produto_id, quantidade}]
)
RETURNS JSONB AS $$
DECLARE
  v_codigo      TEXT;
  v_exp_id      UUID;
  v_item        JSONB;
  v_disponivel  INTEGER;
BEGIN
  -- 1. Validar quantidades
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    SELECT quantidade_disponivel INTO v_disponivel
    FROM lotes_produto
    WHERE id = (v_item->>'lote_produto_id')::UUID
      AND empresa_id = p_empresa_id
      AND status = 'ativo';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Lote ' || (v_item->>'lote_produto_id') || ' não encontrado ou inativo.');
    END IF;

    IF v_disponivel < (v_item->>'quantidade')::INTEGER THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Quantidade insuficiente no lote. Disponível: %s', v_disponivel));
    END IF;
  END LOOP;

  -- 2. Gera código
  v_codigo := gerar_proximo_codigo(p_empresa_id, 'expedicoes', 'EXP');

  -- 3. Cria expedição
  INSERT INTO expedicoes (
    empresa_id, codigo, data_expedicao, responsavel_id,
    destinatario, observacoes, status
  )
  VALUES (
    p_empresa_id, v_codigo, p_data_expedicao, p_responsavel_id,
    p_destinatario, p_observacoes, 'expedida'
  )
  RETURNING id INTO v_exp_id;

  -- 4. Cria itens e decrementa lotes
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO expedicoes_itens (expedicao_id, lote_produto_id, produto_id, quantidade)
    VALUES (
      v_exp_id,
      (v_item->>'lote_produto_id')::UUID,
      (v_item->>'produto_id')::UUID,
      (v_item->>'quantidade')::INTEGER
    );

    UPDATE lotes_produto
    SET quantidade_disponivel = quantidade_disponivel - (v_item->>'quantidade')::INTEGER,
        status = CASE
          WHEN quantidade_disponivel - (v_item->>'quantidade')::INTEGER <= 0
            THEN 'esgotado'::status_lote_produto_enum
          ELSE status
        END
    WHERE id = (v_item->>'lote_produto_id')::UUID;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'expedicao_id', v_exp_id,
    'codigo', v_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- Atualiza fechar_sessao_producao para auto-criar lote de produto
-- ============================================================
CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,
  p_locais         JSONB,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao              sessoes_producao%ROWTYPE;
  v_sku                 JSONB;
  v_local_rec           JSONB;
  v_qtd_ini             DECIMAL;
  v_consumo             DECIMAL;
  v_teorico             DECIMAL;
  v_mov_codigo          TEXT;
  v_mov_id              UUID;
  v_soma_consumo_real    DECIMAL := 0;
  v_soma_consumo_teorico DECIMAL := 0;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_insumos        DECIMAL(8,4) := 0;
  v_fator_produto        DECIMAL(8,4) := 0;
  -- auto lote produto
  v_ficha_id             UUID;
  v_produto_id           UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
BEGIN
  -- 1. Valida sessão
  SELECT * INTO v_sessao FROM sessoes_producao
  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  -- 2. Busca peso_medio_g e planejado da versão
  SELECT ftv.peso_medio_g, sps.quantidade_planejada, sps.ficha_tecnica_id
  INTO v_peso_medio_g, v_qtd_planejada, v_ficha_id
  FROM sessoes_producao_skus sps
  JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
  WHERE sps.sessao_id = p_sessao_id
  LIMIT 1;

  -- 3. Atualiza SKUs
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_qtd_perdida_proc    := COALESCE((v_sku->>'quantidade_perdida')::INTEGER, 0);
    v_qtd_descartada_gram := COALESCE((v_sku->>'quantidade_descartada_gramatura')::INTEGER, 0);
    v_peso_descartado_g   := COALESCE((v_sku->>'peso_descartado_gramatura_g')::DECIMAL, 0);
    v_qtd_produzida       := GREATEST(v_qtd_planejada - v_qtd_perdida_proc - v_qtd_descartada_gram, 0);

    UPDATE sessoes_producao_skus
    SET quantidade_produzida              = v_qtd_produzida,
        quantidade_perdida                = v_qtd_perdida_proc,
        quantidade_descartada_gramatura   = v_qtd_descartada_gram,
        peso_descartado_gramatura_g       = NULLIF(v_peso_descartado_g, 0)
    WHERE sessao_id = p_sessao_id
      AND ficha_tecnica_id = (v_sku->>'ficha_id')::UUID;
  END LOOP;

  -- 4. Atualiza locais
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

    UPDATE lotes
    SET quantidade_disponivel = GREATEST(quantidade_disponivel - v_consumo, 0),
        status = CASE
          WHEN GREATEST(quantidade_disponivel - v_consumo, 0) <= 0 THEN 'esgotado'::status_lote_enum
          ELSE status
        END
    WHERE id = (v_local_rec->>'lote_id')::UUID;

    UPDATE locais_estado_atual
    SET quantidade     = (v_local_rec->>'quantidade_final')::DECIMAL,
        atualizado_em  = NOW(),
        atualizado_por = p_responsavel_id
    WHERE local_id = (v_local_rec->>'local_id')::UUID;

    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, sessao_producao_id)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'consumo_producao', p_responsavel_id, p_sessao_id)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
    SELECT v_mov_id, (v_local_rec->>'lote_id')::UUID, (v_local_rec->>'local_id')::UUID,
           v_consumo, unidade
    FROM lotes WHERE id = (v_local_rec->>'lote_id')::UUID;

    v_soma_consumo_real    := v_soma_consumo_real + v_consumo;
    v_soma_consumo_teorico := v_soma_consumo_teorico + COALESCE(v_teorico, 0);
  END LOOP;

  -- 5. Calcula fatores de perda
  IF v_soma_consumo_teorico > 0 THEN
    v_fator_insumos := ((v_soma_consumo_real - v_soma_consumo_teorico) / v_soma_consumo_teorico) * 100;
  END IF;

  IF v_qtd_planejada > 0 THEN
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      v_fator_produto := (
        (v_qtd_perdida_proc::DECIMAL * v_peso_medio_g + v_peso_descartado_g)
        / (v_qtd_planejada::DECIMAL * v_peso_medio_g)
      ) * 100;
    ELSE
      v_fator_produto := (
        (v_qtd_perdida_proc + v_qtd_descartada_gram)::DECIMAL
        / v_qtd_planejada::DECIMAL
      ) * 100;
    END IF;
  END IF;

  -- 6. Fecha sessão
  UPDATE sessoes_producao
  SET status                   = 'fechada',
      fechada_por              = p_responsavel_id,
      data_fechamento          = NOW(),
      observacoes_fechamento   = p_observacoes,
      fator_perda_insumos      = v_fator_insumos,
      fator_perda_produto      = v_fator_produto
  WHERE id = p_sessao_id;

  -- 7. Auto-criar lote de produto se existe produto vinculado à ficha
  IF v_ficha_id IS NOT NULL AND v_qtd_produzida > 0 THEN
    SELECT id INTO v_produto_id
    FROM produtos
    WHERE ficha_tecnica_id = v_ficha_id
      AND empresa_id = p_empresa_id
      AND ativo = true
    LIMIT 1;

    IF FOUND THEN
      v_lote_result := registrar_lote_produto(
        p_empresa_id, v_produto_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'fator_perda_insumos', v_fator_insumos,
    'fator_perda_produto', v_fator_produto,
    'lote_produto', COALESCE(v_lote_result, '{}'::JSONB)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

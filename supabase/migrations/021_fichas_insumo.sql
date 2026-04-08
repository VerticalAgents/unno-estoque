-- ============================================================
-- Migration 021 — Fichas Técnicas de Insumos (Produção Própria)
-- Permite criar fichas que produzem insumos (ex: doce de leite caseiro)
-- em vez de produtos acabados.
-- ============================================================

-- 1. Novos campos em fichas_tecnicas
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'produto'
  CHECK (tipo IN ('produto', 'insumo'));

ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS insumo_resultado_id UUID REFERENCES insumos(id);

-- ============================================================
-- 2. RPC: registrar_lote_insumo_producao
-- Cria lote de insumo a partir de sessão de produção
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_lote_insumo_producao(
  p_empresa_id     UUID,
  p_insumo_id      UUID,
  p_sessao_id      UUID,
  p_data_producao  DATE,
  p_quantidade     DECIMAL,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_insumo         insumos%ROWTYPE;
  v_codigo         TEXT;
  v_validade_orig  DATE;
  v_validade_pa    DATE;
  v_qr_code        TEXT;
  v_lote_id        UUID;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado');
  END IF;

  -- Código do lote usando o prefixo do insumo
  v_codigo := gerar_proximo_codigo(p_empresa_id, 'lotes', v_insumo.codigo);

  -- Validade: produção própria = data_producao + shelf_life
  v_validade_orig := p_data_producao + COALESCE(v_insumo.shelf_life_dias_pos_abertura, 30);
  v_validade_pa := v_validade_orig;

  -- QR code
  v_qr_code := v_codigo || '|' || p_data_producao::TEXT;

  -- Insere lote
  INSERT INTO lotes (
    id, empresa_id, codigo, insumo_id, data_recebimento,
    validade_original, validade_pos_abertura,
    quantidade_recebida, unidade, quantidade_disponivel,
    status, recebido_por, qr_code, etiqueta_impressa, observacoes
  ) VALUES (
    gen_random_uuid(), p_empresa_id, v_codigo, p_insumo_id, p_data_producao,
    v_validade_orig, v_validade_pa,
    p_quantidade, v_insumo.unidade_medida, p_quantidade,
    'ativo', p_responsavel_id, v_qr_code, false,
    'Produção própria - Sessão ' || (SELECT codigo FROM sessoes_producao WHERE id = p_sessao_id)
  )
  RETURNING id INTO v_lote_id;

  -- Movimentação de entrada
  DECLARE
    v_mov_codigo TEXT;
    v_mov_id     UUID;
  BEGIN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, data_hora, responsavel_id, sessao_producao_id, observacoes)
    VALUES (gen_random_uuid(), p_empresa_id, v_mov_codigo, 'entrada', NOW(), p_responsavel_id, p_sessao_id,
            'Entrada por produção própria')
    RETURNING id INTO v_mov_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, p_quantidade, v_insumo.unidade_medida);
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'lote_id', v_lote_id,
    'codigo', v_codigo,
    'validade', v_validade_pa,
    'qr_code', v_qr_code
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 3. Atualiza criar_ficha_tecnica para aceitar tipo + insumo_resultado
-- ============================================================
CREATE OR REPLACE FUNCTION criar_ficha_tecnica(
  p_empresa_id         UUID,
  p_responsavel_id     UUID,
  p_codigo             TEXT,
  p_nome               TEXT,
  p_descricao          TEXT DEFAULT NULL,
  p_notas              TEXT DEFAULT '',
  p_rendimento_fornada INTEGER DEFAULT 1,
  p_peso_medio_g       DECIMAL DEFAULT NULL,
  p_itens              JSONB DEFAULT '[]',
  p_tipo               TEXT DEFAULT 'produto',
  p_insumo_resultado_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_ficha_id  UUID;
  v_versao_id UUID;
  v_item      JSONB;
BEGIN
  -- Valida código único
  IF EXISTS (SELECT 1 FROM fichas_tecnicas WHERE empresa_id = p_empresa_id AND codigo = p_codigo) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código já existe.');
  END IF;

  -- Insere ficha
  INSERT INTO fichas_tecnicas (empresa_id, codigo, nome, descricao, versao_atual, ativo, tipo, insumo_resultado_id)
  VALUES (p_empresa_id, p_codigo, p_nome, p_descricao, 1, true, p_tipo, p_insumo_resultado_id)
  RETURNING id INTO v_ficha_id;

  -- Insere versão 1
  INSERT INTO fichas_tecnicas_versoes (ficha_id, versao, criado_por, notas_alteracao, ativa, rendimento_fornada, peso_medio_g)
  VALUES (v_ficha_id, 1, p_responsavel_id, p_notas, true, p_rendimento_fornada, p_peso_medio_g)
  RETURNING id INTO v_versao_id;

  -- Insere itens
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade, observacoes)
    VALUES (
      v_versao_id,
      (v_item->>'insumo_id')::UUID,
      (v_item->>'quantidade')::DECIMAL,
      (v_item->>'unidade')::unidade_medida_enum,
      v_item->>'observacoes'
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'ficha_id', v_ficha_id, 'versao_id', v_versao_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. Atualiza fechar_sessao_producao para suportar fichas de insumo
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
  v_ficha_id             UUID;
  v_produto_id           UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  -- novo: tipo da ficha
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
BEGIN
  -- 1. Valida sessão
  SELECT * INTO v_sessao FROM sessoes_producao
  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  -- 2. Busca dados da ficha/versão
  SELECT ftv.peso_medio_g, sps.quantidade_planejada, sps.ficha_tecnica_id
  INTO v_peso_medio_g, v_qtd_planejada, v_ficha_id
  FROM sessoes_producao_skus sps
  JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
  WHERE sps.sessao_id = p_sessao_id
  LIMIT 1;

  -- Busca tipo da ficha
  SELECT tipo, insumo_resultado_id INTO v_tipo_ficha, v_insumo_resultado_id
  FROM fichas_tecnicas WHERE id = v_ficha_id;

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

  -- 7. Auto-criar resultado baseado no tipo da ficha
  IF v_ficha_id IS NOT NULL AND v_qtd_produzida > 0 THEN

    IF v_tipo_ficha = 'insumo' AND v_insumo_resultado_id IS NOT NULL THEN
      -- NOVO: Ficha de insumo → cria lote de insumo
      v_lote_result := registrar_lote_insumo_producao(
        p_empresa_id, v_insumo_resultado_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
    ELSE
      -- Fluxo original: ficha de produto → cria lote_produto
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
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'fator_perda_insumos', v_fator_insumos,
    'fator_perda_produto', v_fator_produto,
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'tipo_ficha', COALESCE(v_tipo_ficha, 'produto')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

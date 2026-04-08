-- Migration 016: Corrige cálculo do consumo_teórico e fechar_sessao_producao
--
-- Bug: abrir_sessao_producao calculava consumo_teorico = qty_item * rendimento * multiplicador
-- A ficha técnica armazena quantidade POR FORNADA (não por unidade).
-- Correto: consumo_teorico = qty_item * multiplicador
--
-- Também: fechar_sessao_producao agora:
--   1. Calcula quantidade_produzida = planejado - perdida - descartada_gramatura
--   2. Usa peso_medio_g para fator de perda baseado em peso quando disponível

-- ============================================================
-- RPC: abrir_sessao_producao (fix consumo_teorico)
-- ============================================================
CREATE OR REPLACE FUNCTION abrir_sessao_producao(
  p_empresa_id      UUID,
  p_responsavel_id  UUID,
  p_data_producao   DATE,
  p_ficha_tecnica_id UUID,
  p_ficha_versao_id  UUID,
  p_multiplicador    INTEGER DEFAULT 1,
  p_observacoes      TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao_codigo      TEXT;
  v_sessao_id          UUID;
  v_sku_id             UUID;
  v_rendimento         INTEGER;
  v_qtd_planejada      INTEGER;
  v_item               RECORD;
  v_local              RECORD;
  v_locais_vinculados  INTEGER := 0;
  v_consumo_teorico    DECIMAL;
  v_primeiro_local     BOOLEAN;
BEGIN
  -- 1. Valida que não há sessão aberta
  IF EXISTS (
    SELECT 1 FROM sessoes_producao
    WHERE empresa_id = p_empresa_id AND status = 'aberta'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Já existe uma sessão aberta. Feche-a antes de abrir uma nova.');
  END IF;

  -- 2. Busca rendimento da versão
  SELECT rendimento_fornada INTO v_rendimento
  FROM fichas_tecnicas_versoes
  WHERE id = p_ficha_versao_id AND ativa = true;

  IF NOT FOUND OR v_rendimento IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Versão da ficha não encontrada ou sem rendimento cadastrado.');
  END IF;

  v_qtd_planejada := v_rendimento * p_multiplicador;

  -- 3. Gera código incremental
  v_sessao_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  -- 4. Cria sessão
  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, observacoes_abertura
  )
  VALUES (
    p_empresa_id, v_sessao_codigo, p_data_producao, 'aberta',
    p_responsavel_id, NOW(), p_observacoes
  )
  RETURNING id INTO v_sessao_id;

  -- 5. Cria SKU
  INSERT INTO sessoes_producao_skus (
    sessao_id, ficha_tecnica_id, ficha_versao_id,
    quantidade_planejada, multiplicador
  )
  VALUES (
    v_sessao_id, p_ficha_tecnica_id, p_ficha_versao_id,
    v_qtd_planejada, p_multiplicador
  )
  RETURNING id INTO v_sku_id;

  -- 6. Para cada insumo da ficha, auto-vincula recipientes EP com estoque
  --    consumo_teorico = quantidade_da_ficha (por fornada) * numero_de_fornadas
  FOR v_item IN
    SELECT fti.insumo_id, fti.quantidade AS qtd_por_fornada
    FROM fichas_tecnicas_itens fti
    WHERE fti.versao_id = p_ficha_versao_id
  LOOP
    -- FIX: quantidade na ficha é POR FORNADA, não por unidade produzida
    v_consumo_teorico := v_item.qtd_por_fornada * p_multiplicador;
    v_primeiro_local := true;

    FOR v_local IN
      SELECT l.id AS local_id, lea.lote_id, lea.quantidade AS qtd_disponivel
      FROM locais l
      JOIN locais_estado_atual lea ON lea.local_id = l.id
      WHERE l.empresa_id = p_empresa_id
        AND l.tipo = 'estoque_produtivo'
        AND l.insumo_id = v_item.insumo_id
        AND lea.quantidade > 0
        AND lea.lote_id IS NOT NULL
      ORDER BY l.nome ASC
    LOOP
      INSERT INTO sessoes_producao_locais (
        sessao_id, local_id, insumo_id, lote_id,
        quantidade_inicial,
        consumo_teorico
      )
      VALUES (
        v_sessao_id,
        v_local.local_id,
        v_item.insumo_id,
        v_local.lote_id,
        v_local.qtd_disponivel,
        CASE WHEN v_primeiro_local THEN v_consumo_teorico ELSE 0 END
      );

      v_locais_vinculados := v_locais_vinculados + 1;
      v_primeiro_local := false;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', v_sessao_id,
    'codigo', v_sessao_codigo,
    'quantidade_planejada', v_qtd_planejada,
    'locais_vinculados', v_locais_vinculados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- RPC: fechar_sessao_producao (v3 — produzida calculada, perda em peso)
-- ============================================================
CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,  -- [{ficha_id, quantidade_perdida, quantidade_descartada_gramatura, peso_descartado_gramatura_g}]
  p_locais         JSONB,  -- [{local_id, lote_id, quantidade_final}]
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
  -- fator de perda
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
BEGIN
  -- 1. Valida sessão
  SELECT * INTO v_sessao FROM sessoes_producao
  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  -- 2. Busca peso_medio_g e planejado da versão
  SELECT ftv.peso_medio_g, sps.quantidade_planejada
  INTO v_peso_medio_g, v_qtd_planejada
  FROM sessoes_producao_skus sps
  JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
  WHERE sps.sessao_id = p_sessao_id
  LIMIT 1;

  -- 3. Atualiza SKUs — produzida calculada server-side
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

  -- 4. Atualiza locais: consumo real, desvio, estado atual
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
    SET quantidade     = (v_local_rec->>'quantidade_final')::DECIMAL,
        atualizado_em  = NOW(),
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

    v_soma_consumo_real    := v_soma_consumo_real + v_consumo;
    v_soma_consumo_teorico := v_soma_consumo_teorico + COALESCE(v_teorico, 0);
  END LOOP;

  -- 5. Calcula fator de perda de insumos
  IF v_soma_consumo_teorico > 0 THEN
    v_fator_insumos := ((v_soma_consumo_real - v_soma_consumo_teorico) / v_soma_consumo_teorico) * 100;
  END IF;

  -- 6. Calcula fator de perda de produto
  --    Com peso_medio_g: usa peso real descartado vs peso total esperado
  --    Sem peso_medio_g: usa contagem de unidades
  IF v_qtd_planejada > 0 THEN
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      -- Peso perdido = (unidades processo × peso_médio) + peso_real_descartado_gramatura
      -- Peso esperado total = planejado × peso_médio
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

  -- 7. Fecha sessão
  UPDATE sessoes_producao
  SET status                   = 'fechada',
      fechada_por              = p_responsavel_id,
      data_fechamento          = NOW(),
      observacoes_fechamento   = p_observacoes,
      fator_perda_insumos      = v_fator_insumos,
      fator_perda_produto      = v_fator_produto
  WHERE id = p_sessao_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'fator_perda_insumos', v_fator_insumos,
    'fator_perda_produto', v_fator_produto
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

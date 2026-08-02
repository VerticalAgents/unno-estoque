-- ============================================================
-- Migration 035 — Transferência parcial e com mistura
--
-- Revoga RO-002 (lote inteiro) e RO-003 (recipiente vazio) nas duas RPCs de
-- transferência. Passa a gravar em `locais_lotes` (migration 034), então um
-- recipiente pode acumular vários lotes do mesmo insumo.
--
-- O QUE CONTINUA TRAVADO
--   • insumo diferente do recipiente
--   • MARCA diferente — agora comparada também com a marca do CONTEÚDO ATUAL,
--     não só com a marca configurada no recipiente. Um pote sem marca fixa que
--     já tenha lote da marca X não aceita lote da marca Y.
--   • quantidade maior que o saldo do lote
--   • capacidade do recipiente (agora é aviso, não bloqueio — a balança manda)
--
-- `validar_transferencia_para_local` deixa de checar RO-003; fica como
-- validação de tipo de local e passa a devolver o que já existe no pote, para
-- a tela avisar antes de confirmar.
-- ============================================================

-- ── Validação: sem RO-003, com info do conteúdo atual ───────
CREATE OR REPLACE FUNCTION validar_transferencia_para_local(
  p_local_id   UUID,
  p_lote_id    UUID,
  p_quantidade DECIMAL
)
RETURNS JSONB AS $$
DECLARE
  v_local        locais%ROWTYPE;
  v_lote         lotes%ROWTYPE;
  v_total_atual  DECIMAL;
  v_qtd_lotes    INTEGER;
  v_marca_conteudo UUID;
BEGIN
  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.tipo = 'estoque_central' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Não é possível transferir para o Estoque Central por este fluxo.');
  END IF;

  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  -- Insumo do recipiente
  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_lote.insumo_id THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este recipiente é dedicado a outro insumo.');
  END IF;

  -- Conteúdo atual do pote
  SELECT COALESCE(SUM(ll.quantidade), 0),
         COUNT(*) FILTER (WHERE ll.quantidade > 0),
         (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1]
    INTO v_total_atual, v_qtd_lotes, v_marca_conteudo
    FROM locais_lotes ll
    JOIN lotes lo ON lo.id = ll.lote_id
   WHERE ll.local_id = p_local_id AND ll.quantidade > 0;

  -- MARCA: contra a marca configurada no recipiente e contra o que já está dentro
  IF v_lote.marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
     AND v_lote.marca_id <> v_local.marca_id THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Marca do lote incompatível com o recipiente.');
  END IF;

  IF v_lote.marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
     AND v_lote.marca_id <> v_marca_conteudo THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este recipiente já contém lote de outra marca. Não é permitido misturar marcas.');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'quantidade_atual', v_total_atual,
    'lotes_no_recipiente', COALESCE(v_qtd_lotes, 0),
    'vai_misturar', COALESCE(v_qtd_lotes, 0) > 0,
    -- aviso, não bloqueio: quem manda é a balança
    'excede_capacidade', (v_local.capacidade_max IS NOT NULL
                          AND v_total_atual + p_quantidade > v_local.capacidade_max)
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Helper: coloca (ou soma) um lote dentro de um recipiente.
-- Centraliza o upsert para as duas RPCs de transferência não divergirem.
-- ============================================================
CREATE OR REPLACE FUNCTION abastecer_recipiente(
  p_local_id    UUID,
  p_lote_id     UUID,
  p_quantidade  DECIMAL,
  p_unidade     unidade_medida_enum,
  p_validade_ep DATE
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO locais_lotes (local_id, lote_id, quantidade, unidade, data_transferencia, validade_ep)
  VALUES (p_local_id, p_lote_id, p_quantidade, p_unidade, CURRENT_DATE, p_validade_ep)
  ON CONFLICT (local_id, lote_id) DO UPDATE SET
    quantidade         = locais_lotes.quantidade + EXCLUDED.quantidade,
    data_transferencia = CURRENT_DATE,
    -- validade do lote no pote: a mais restritiva entre a que já tinha e a nova
    validade_ep        = LEAST(
                           COALESCE(locais_lotes.validade_ep, EXCLUDED.validade_ep),
                           COALESCE(EXCLUDED.validade_ep, locais_lotes.validade_ep)
                         ),
    updated_at         = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- realizar_transferencia — parcial e com mistura
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
  v_validacao   JSONB;
  v_lote        lotes%ROWTYPE;
  v_insumo      insumos%ROWTYPE;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_validade_ep DATE;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe uma quantidade maior que zero.');
  END IF;

  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Quantidade insuficiente. Disponível: %s %s',
             v_lote.quantidade_disponivel, v_lote.unidade));
  END IF;

  v_validacao := validar_transferencia_para_local(p_local_id, p_lote_id, p_quantidade);
  IF NOT (v_validacao->>'ok')::BOOLEAN THEN
    RETURN v_validacao;
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;
  v_validade_ep := CASE
    WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
    THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
    ELSE v_lote.validade_original
  END;

  -- Baixa parcial no EC: só esgota o lote se realmente zerou (revoga RO-002)
  UPDATE lotes
     SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
         status = CASE
           WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'esgotado'::status_lote_enum
           ELSE status
         END
   WHERE id = p_lote_id;

  PERFORM abastecer_recipiente(p_local_id, p_lote_id, p_quantidade, v_lote.unidade, v_validade_ep);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens
    (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, NULL, p_local_id, p_quantidade, v_lote.unidade);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo,
    'validade_ep', v_validade_ep,
    'misturou', (v_validacao->>'vai_misturar')::BOOLEAN,
    'lote_esgotado', (v_lote.quantidade_disponivel - p_quantidade) <= 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- realizar_transferencia_multipla — sublotes do mesmo recebimento
-- Mantém a exigência de mesmo lote_grupo_id; tira RO-003.
-- Sublotes continuam indo inteiros: são embalagens fechadas.
-- ============================================================
CREATE OR REPLACE FUNCTION realizar_transferencia_multipla(
  p_lote_ids       UUID[],
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID
)
RETURNS JSONB AS $$
DECLARE
  v_lote        lotes%ROWTYPE;
  v_lote_id     UUID;
  v_grupo_id    UUID;
  v_qtd_total   DECIMAL := 0;
  v_insumo      insumos%ROWTYPE;
  v_validade_ep DATE;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_validacao   JSONB;
  v_misturou    BOOLEAN := false;
BEGIN
  IF array_length(p_lote_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhum sublote fornecido.');
  END IF;

  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id AND empresa_id = p_empresa_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro', format('Lote %s não encontrado.', v_lote_id));
    END IF;
    IF v_lote.status <> 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
    END IF;

    IF v_grupo_id IS NULL THEN
      v_grupo_id := v_lote.lote_grupo_id;
    ELSIF v_lote.lote_grupo_id IS DISTINCT FROM v_grupo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Todos os sublotes devem pertencer ao mesmo lote de recebimento.');
    END IF;

    v_qtd_total := v_qtd_total + v_lote.quantidade_disponivel;
  END LOOP;

  -- Valida com o primeiro sublote (mesma marca e insumo para todos do grupo)
  v_validacao := validar_transferencia_para_local(p_local_id, p_lote_ids[1], v_qtd_total);
  IF NOT (v_validacao->>'ok')::BOOLEAN THEN
    RETURN v_validacao;
  END IF;
  v_misturou := (v_validacao->>'vai_misturar')::BOOLEAN;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id;

    v_validade_ep := CASE
      WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
      THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
      ELSE v_lote.validade_original
    END;

    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, p_local_id, v_lote.quantidade_disponivel, v_lote.unidade);

    PERFORM abastecer_recipiente(
      p_local_id, v_lote_id, v_lote.quantidade_disponivel, v_lote.unidade, v_validade_ep
    );

    UPDATE lotes
       SET quantidade_disponivel = 0,
           status = 'esgotado'::status_lote_enum
     WHERE id = v_lote_id;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo,
    'quantidade_total', v_qtd_total,
    'misturou', v_misturou
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

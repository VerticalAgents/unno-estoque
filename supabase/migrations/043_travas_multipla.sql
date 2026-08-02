-- ============================================================
-- Migration 043 — Travas também na transferência de sublotes
--
-- A 041 pôs as travas em `realizar_transferencia` (lote único), mas a tela de
-- transferência chama `realizar_transferencia_multipla` — que é o caminho de
-- verdade, o dos sublotes lidos por QR. Sem isso as travas não pegariam nada
-- no uso real.
--
-- Duas das cinco travas se aplicam aqui. `segundo_lote_aberto` não: o fluxo de
-- sublotes leva embalagens inteiras, nunca deixa lote pela metade.
-- ============================================================

DROP FUNCTION IF EXISTS realizar_transferencia_multipla(UUID[], UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION realizar_transferencia_multipla(
  p_lote_ids       UUID[],
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID,
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote        lotes%ROWTYPE;
  v_lote_id     UUID;
  v_grupo_id    UUID;
  v_qtd_total   DECIMAL := 0;
  v_insumo      insumos%ROWTYPE;
  v_local       locais%ROWTYPE;
  v_validade_ep DATE;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_total_atual DECIMAL;
  v_marca_conteudo UUID;
  v_trava       JSONB;
  v_contexto    JSONB;
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

  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_lote.insumo_id THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este recipiente é dedicado a outro insumo.');
  END IF;

  SELECT COALESCE(SUM(ll.quantidade), 0),
         (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1]
    INTO v_total_atual, v_marca_conteudo
    FROM locais_lotes ll
    JOIN lotes lo ON lo.id = ll.lote_id
   WHERE ll.local_id = p_local_id AND ll.quantidade > 0;

  v_contexto := jsonb_build_object(
    'lotes', array_length(p_lote_ids, 1), 'recipiente', v_local.nome, 'quantidade', v_qtd_total
  );

  -- TRAVA: marca diferente
  IF (v_lote.marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
      AND v_lote.marca_id <> v_local.marca_id)
     OR (v_lote.marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
         AND v_lote.marca_id <> v_marca_conteudo) THEN
    v_trava := avaliar_trava(p_empresa_id, 'marca_diferente', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'marca_diferente',
        'mensagem', 'Este recipiente é de outra marca. Misturar marcas compromete a rastreabilidade.');
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'marca_diferente',
                              v_contexto, p_justificativa);
  END IF;

  -- TRAVA: excede capacidade
  IF v_local.capacidade_max IS NOT NULL
     AND v_total_atual + v_qtd_total > v_local.capacidade_max THEN
    v_trava := avaliar_trava(p_empresa_id, 'excede_capacidade', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'excede_capacidade',
        'mensagem', format('Passa da capacidade do recipiente (%s de %s).',
                           ROUND(v_total_atual + v_qtd_total, 3), v_local.capacidade_max));
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'excede_capacidade',
                              v_contexto, p_justificativa);
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
          p_responsavel_id, p_justificativa)
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

    UPDATE lotes SET quantidade_disponivel = 0, status = 'esgotado'::status_lote_enum
     WHERE id = v_lote_id;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo,
    'quantidade_total', v_qtd_total,
    'misturou', v_total_atual > 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Migration 037 — Contagem física com recipientes misturados
--
-- `aplicar_contagem` escrevia `locais_estado_atual.quantidade` direto. Isso
-- agora é o RESUMO de `locais_lotes` (migration 034) e é recalculado por
-- trigger — ou seja, o valor escrito à mão seria descartado no próximo
-- movimento, e a composição do pote se perderia.
--
-- Pior: contar um pote e marcá-lo como "vazio" apagaria a informação de quais
-- lotes estavam ali, quebrando a rastreabilidade das produções do dia.
--
-- Passa a ajustar `locais_lotes`, redistribuindo a diferença entre os lotes na
-- mesma proporção do rateio de consumo. A composição sobrevive à contagem.
-- ============================================================

-- ── Helper: ajusta o total do recipiente preservando a proporção ─────────
CREATE OR REPLACE FUNCTION ajustar_conteudo_recipiente(
  p_local_id   UUID,
  p_novo_total DECIMAL
)
RETURNS VOID AS $$
DECLARE
  v_total_atual DECIMAL;
BEGIN
  SELECT COALESCE(SUM(quantidade), 0) INTO v_total_atual
    FROM locais_lotes WHERE local_id = p_local_id;

  IF p_novo_total <= 0 THEN
    -- Pote vazio: zera os lotes mas mantém as linhas, para o histórico da
    -- sessão continuar sabendo o que havia ali.
    UPDATE locais_lotes SET quantidade = 0 WHERE local_id = p_local_id;
    RETURN;
  END IF;

  IF v_total_atual <= 0 THEN
    -- Contou peso num pote que o sistema achava vazio. Não há como saber de
    -- qual lote é; não inventa vínculo. Fica registrado no resumo e a
    -- diferença aparece como divergência de contagem.
    RETURN;
  END IF;

  UPDATE locais_lotes
     SET quantidade = ROUND(quantidade * (p_novo_total / v_total_atual), 3)
   WHERE local_id = p_local_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION ajustar_conteudo_recipiente IS
  'Ajusta o total de um recipiente para o valor contado, mantendo a proporção '
  'entre os lotes que estão dentro dele.';

-- ── aplicar_contagem: ramo EP agora passa pelo helper ───────
CREATE OR REPLACE FUNCTION aplicar_contagem(
  p_contagem_id UUID,
  p_usuario_id  UUID
)
RETURNS JSONB AS $$
DECLARE
  v_contagem   contagens%ROWTYPE;
  v_ec_lote    RECORD;
  v_ep_local   RECORD;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
  v_local_rec  locais%ROWTYPE;
  v_novo_total DECIMAL;
BEGIN
  SELECT * INTO v_contagem FROM contagens WHERE id = p_contagem_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Contagem não encontrada');
  END IF;

  IF v_contagem.status != 'finalizada' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Contagem deve estar finalizada para ser aplicada');
  END IF;

  IF v_contagem.tipo = 'ec' THEN
    FOR v_ec_lote IN
      SELECT cel.lote_id, cel.qtd_lote, ci.insumo_id
        FROM contagem_ec_lotes cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND cel.encontrado = false
    LOOP
      UPDATE lotes
         SET status = 'descartado', quantidade_disponivel = 0, updated_at = now()
       WHERE id = v_ec_lote.lote_id;

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem: lote não encontrado no EC')
      RETURNING id INTO v_mov_id;

      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
      SELECT v_mov_id, v_ec_lote.lote_id, v_ec_lote.qtd_lote, i.unidade_medida
        FROM insumos i WHERE i.id = v_ec_lote.insumo_id;
    END LOOP;

  ELSIF v_contagem.tipo = 'ep' THEN
    FOR v_ep_local IN
      SELECT cel.local_id, cel.status_fisico, cel.qtd_liquida, ci.insumo_id
        FROM contagem_ep_locais cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND cel.escaneado = true
    LOOP
      SELECT * INTO v_local_rec FROM locais WHERE id = v_ep_local.local_id;

      v_novo_total := CASE v_ep_local.status_fisico
        WHEN 'cheio' THEN COALESCE(v_local_rec.capacidade_max, 0)
        WHEN 'vazio' THEN 0
        ELSE COALESCE(v_ep_local.qtd_liquida, 0)   -- 'usado'
      END;

      -- Redistribui entre os lotes do pote; o trigger atualiza o resumo
      PERFORM ajustar_conteudo_recipiente(v_ep_local.local_id, v_novo_total);

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem EP: ajuste recipiente ' || v_local_rec.nome);
    END LOOP;
  END IF;

  UPDATE contagens
     SET status = 'aplicada', aplicada_at = now()
   WHERE id = p_contagem_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

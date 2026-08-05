-- ============================================================
-- Migration 071 — Aplicar contagem só mexe no que foi conferido
--
-- Armadilha grave, que só aparece quando se encerra uma contagem no meio:
-- `aplicar_contagem` descartava TODO lote com `encontrado = false`, sem olhar
-- se o insumo chegou a ser contado. Insumo que ninguém abriu tem todos os
-- lotes com `encontrado = false` — ou seja, aplicar uma contagem parcial
-- descartaria o estoque inteiro dos insumos que nem foram visitados.
--
-- Com 20 insumos e 65 lotes, encerrar no quinto e aplicar zeraria 15 insumos.
-- Nada na tela avisava.
--
-- Agora só entram os insumos com `status = 'finalizado'`: contado é o que a
-- pessoa declarou ter conferido. O que não foi conferido fica exatamente como
-- estava — que é a única leitura honesta de "não contei isso".
--
-- O ramo EP já era seguro por outro caminho (filtra `escaneado = true`), mas
-- ganha o mesmo filtro para as duas metades lerem igual.
-- ============================================================

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
  v_descartados INTEGER := 0;
  v_ajustados   INTEGER := 0;
  v_ignorados   INTEGER := 0;
BEGIN
  SELECT * INTO v_contagem FROM contagens WHERE id = p_contagem_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Contagem não encontrada');
  END IF;

  IF v_contagem.status <> 'finalizada' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Contagem deve estar finalizada para ser aplicada');
  END IF;

  -- Quantos insumos ficaram de fora, para a tela poder dizer.
  SELECT COUNT(*) INTO v_ignorados
    FROM contagem_insumos
   WHERE contagem_id = p_contagem_id AND status <> 'finalizado';

  IF v_contagem.tipo = 'ec' THEN
    FOR v_ec_lote IN
      SELECT cel.lote_id, cel.qtd_lote, ci.insumo_id
        FROM contagem_ec_lotes cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND ci.status = 'finalizado'      -- <- o conserto
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

      v_descartados := v_descartados + 1;
    END LOOP;

  ELSIF v_contagem.tipo = 'ep' THEN
    FOR v_ep_local IN
      SELECT cel.local_id, cel.status_fisico, cel.qtd_liquida, ci.insumo_id
        FROM contagem_ep_locais cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND ci.status = 'finalizado'
         AND cel.escaneado = true
    LOOP
      SELECT * INTO v_local_rec FROM locais WHERE id = v_ep_local.local_id;

      v_novo_total := CASE v_ep_local.status_fisico
        WHEN 'cheio' THEN COALESCE(v_local_rec.capacidade_max, 0)
        WHEN 'vazio' THEN 0
        ELSE COALESCE(v_ep_local.qtd_liquida, 0)
      END;

      PERFORM ajustar_conteudo_recipiente(v_ep_local.local_id, v_novo_total);

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem EP: ajuste recipiente ' || v_local_rec.nome);

      v_ajustados := v_ajustados + 1;
    END LOOP;
  END IF;

  UPDATE contagens
     SET status = 'aplicada', aplicada_at = now()
   WHERE id = p_contagem_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lotes_descartados', v_descartados,
    'recipientes_ajustados', v_ajustados,
    'insumos_nao_conferidos', v_ignorados);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION aplicar_contagem IS
  'Aplica ao estoque o que foi conferido. Insumo que não chegou a ser '
  'finalizado na contagem não é tocado — antes, encerrar no meio e aplicar '
  'descartava o estoque de tudo que não tinha sido visitado.';

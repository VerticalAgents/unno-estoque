-- ============================================================
-- Migration 070 — A contagem passa a seguir a ordem dos insumos
--
-- `iniciar_contagem` percorria os insumos com `ORDER BY i.id` — e `id` é um
-- UUID, ou seja, ordem aleatória. Quem conta ia de INS014 para INS003 e depois
-- para INS020, sem lógica nenhuma, atravessando o estoque de um lado para o
-- outro a cada insumo. Numa contagem de 20 insumos isso é caminhada à toa e
-- convite a pular item.
--
-- Passa a usar `chave_natural(i.codigo)` (migration 053), que é a mesma
-- ordenação usada no resto do sistema: INS2 antes de INS10.
--
-- Os recipientes de cada insumo também: `ORDER BY loc.nome` deixava "Pote #10"
-- antes de "Pote #2".
--
-- Contagens JÁ CRIADAS não se reordenam sozinhas — a ordem delas está gravada
-- em `contagem_insumos`. Por isso a tela também ordena na exibição, o que
-- conserta as antigas.
-- ============================================================

CREATE OR REPLACE FUNCTION iniciar_contagem(
  p_empresa_id UUID,
  p_tipo TEXT,
  p_usuario_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_contagem_id UUID;
  v_item_id UUID;
  v_insumo RECORD;
  v_lote RECORD;
  v_local RECORD;
  v_qtd_teorica DECIMAL;
  v_existing UUID;
BEGIN
  SELECT id INTO v_existing
  FROM contagens
  WHERE empresa_id = p_empresa_id
    AND tipo = p_tipo
    AND status = 'em_andamento'
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Já existe uma contagem em andamento do tipo ' || p_tipo,
      'contagem_id', v_existing);
  END IF;

  INSERT INTO contagens (empresa_id, tipo, iniciada_por)
  VALUES (p_empresa_id, p_tipo, p_usuario_id)
  RETURNING id INTO v_contagem_id;

  IF p_tipo = 'ec' THEN
    FOR v_insumo IN
      SELECT DISTINCT i.id AS insumo_id, i.codigo
      FROM insumos i
      JOIN lotes l ON l.insumo_id = i.id AND l.status = 'ativo' AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY chave_natural(i.codigo)
    LOOP
      SELECT COALESCE(SUM(quantidade_disponivel), 0) INTO v_qtd_teorica
      FROM lotes
      WHERE insumo_id = v_insumo.insumo_id
        AND empresa_id = p_empresa_id
        AND status = 'ativo';

      INSERT INTO contagem_insumos (contagem_id, insumo_id, qtd_teorica)
      VALUES (v_contagem_id, v_insumo.insumo_id, v_qtd_teorica)
      RETURNING id INTO v_item_id;

      FOR v_lote IN
        SELECT id, codigo, quantidade_disponivel
        FROM lotes
        WHERE insumo_id = v_insumo.insumo_id
          AND empresa_id = p_empresa_id
          AND status = 'ativo'
        ORDER BY chave_natural(codigo)
      LOOP
        INSERT INTO contagem_ec_lotes (contagem_insumo_id, lote_id, lote_codigo, qtd_lote)
        VALUES (v_item_id, v_lote.id, v_lote.codigo, v_lote.quantidade_disponivel);
      END LOOP;
    END LOOP;

  ELSIF p_tipo = 'ep' THEN
    FOR v_insumo IN
      SELECT DISTINCT i.id AS insumo_id, i.codigo
      FROM insumos i
      JOIN locais l ON l.insumo_id = i.id AND l.tipo = 'estoque_produtivo'
                   AND l.ativo = true AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY chave_natural(i.codigo)
    LOOP
      SELECT COALESCE(SUM(lea.quantidade), 0) INTO v_qtd_teorica
      FROM locais loc
      JOIN locais_estado_atual lea ON lea.local_id = loc.id
      WHERE loc.insumo_id = v_insumo.insumo_id
        AND loc.tipo = 'estoque_produtivo'
        AND loc.ativo = true
        AND loc.empresa_id = p_empresa_id;

      INSERT INTO contagem_insumos (contagem_id, insumo_id, qtd_teorica)
      VALUES (v_contagem_id, v_insumo.insumo_id, v_qtd_teorica)
      RETURNING id INTO v_item_id;

      FOR v_local IN
        SELECT loc.id, loc.nome, loc.peso_tara, COALESCE(lea.quantidade, 0) AS qtd_atual
        FROM locais loc
        LEFT JOIN locais_estado_atual lea ON lea.local_id = loc.id
        WHERE loc.insumo_id = v_insumo.insumo_id
          AND loc.tipo = 'estoque_produtivo'
          AND loc.ativo = true
          AND loc.empresa_id = p_empresa_id
        ORDER BY chave_natural(loc.nome)
      LOOP
        INSERT INTO contagem_ep_locais (contagem_insumo_id, local_id, local_nome, qtd_estado_atual, peso_tara)
        VALUES (v_item_id, v_local.id, v_local.nome, v_local.qtd_atual, COALESCE(v_local.peso_tara, 0));
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'contagem_id', v_contagem_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION iniciar_contagem IS
  'Abre uma contagem e pré-popula o que se espera encontrar, na ordem natural '
  'dos códigos de insumo — quem conta anda pelo estoque numa direção só.';

-- ============================================================
-- Migration 080 — Contagem: dois defeitos, e o segundo é grave
--
-- 1. INICIAR CONTAGEM ESTAVA QUEBRADO DESDE A 070. Aquela migration trocou a
--    ordenação para `ORDER BY chave_natural(i.codigo)` num `SELECT DISTINCT`,
--    e o Postgres não aceita ordenar por expressão que não está na lista do
--    SELECT quando há DISTINCT. Resultado: **nenhuma contagem nova podia ser
--    criada**, nem EC nem EP — erro 42P10 na cara de quem clicasse. Passou
--    despercebido porque havia uma contagem em andamento o tempo todo, e o
--    caminho que trava é justamente o de começar outra.
--
--    Conserto: a chave entra na lista do SELECT com um nome, e o ORDER BY usa
--    o nome. O DISTINCT não muda de significado — `i.id` já era único.
--
-- 2. CONTAGEM SEM NADA PARA CONTAR NASCIA MESMO ASSIM. A contagem era criada
--    antes de procurar o que contar. Sem lote ativo (EC) ou sem recipiente com
--    insumo (EP), ela nascia vazia e "em andamento": a tela abria sem itens, o
--    botão passava a recusar ("Já existe uma contagem em andamento") e a pessoa
--    ficava presa numa sessão fantasma sem saber como cancelar. Pior num
--    cliente novo, que é justamente quem ainda não tem lote nenhum.
--
--    Conserto: se nada foi inserido, a contagem recém-criada é apagada e a
--    função devolve o motivo. Apagar depois, em vez de contar antes, evita
--    repetir as duas consultas (diferentes para EC e EP) só para saber se há o
--    que fazer.
-- ============================================================

CREATE OR REPLACE FUNCTION iniciar_contagem(
  p_empresa_id UUID,
  p_tipo       TEXT,
  p_usuario_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_contagem_id UUID;
  v_item_id     UUID;
  v_insumo      RECORD;
  v_lote        RECORD;
  v_local       RECORD;
  v_qtd_teorica DECIMAL;
  v_existing    UUID;
  v_itens       INTEGER;
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
      SELECT DISTINCT i.id AS insumo_id, i.codigo, chave_natural(i.codigo) AS ordem
      FROM insumos i
      JOIN lotes l ON l.insumo_id = i.id AND l.status = 'ativo' AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY ordem
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
      SELECT DISTINCT i.id AS insumo_id, i.codigo, chave_natural(i.codigo) AS ordem
      FROM insumos i
      JOIN locais l ON l.insumo_id = i.id AND l.tipo = 'estoque_produtivo'
                   AND l.ativo = true AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY ordem
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

  SELECT count(*) INTO v_itens FROM contagem_insumos WHERE contagem_id = v_contagem_id;

  IF v_itens = 0 THEN
    DELETE FROM contagens WHERE id = v_contagem_id;
    RETURN jsonb_build_object('ok', false, 'erro', CASE
      WHEN p_tipo = 'ec'
        THEN 'Não há nada para contar no estoque central: nenhum lote ativo. '
          || 'Registre um recebimento (ou faça a abertura de estoque) antes.'
      ELSE 'Não há nada para contar no estoque produtivo: nenhum recipiente com '
        || 'insumo definido. Cadastre os recipientes em Recipientes antes.'
    END);
  END IF;

  RETURN jsonb_build_object('ok', true, 'contagem_id', v_contagem_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

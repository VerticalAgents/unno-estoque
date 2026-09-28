-- ============================================================
-- Migration 121 — embalagem fechada volta cheia
--
-- O PEDIDO DO LUCCA, em 28/09/2026: o fechamento da sessão só tinha "Acabou" e
-- "Ainda tem". Para um balde LACRADO não havia resposta — a equipe teria de
-- pesar balde fechado. A tela ganha o botão "Fechado", que declara a
-- embalagem cheia, com a quantidade original dela.
--
-- ------ Por que a função precisa mudar -----------------------
--
-- O consumo teórico sai dos recipientes pela FILA, não pelo que a equipe
-- abriu. Na SESS-0044 a fila "esvaziou" o balde de doce de leite 0001.21 e
-- deixou 1,05 kg no 0001.22 — sem saber se foram esses os abertos. Quando o
-- balde que a fila zerou está lacrado, "Fechado" precisa DEVOLVER os 4,8 kg a
-- ele.
--
-- Só que esta função chamava `ajustar_conteudo_recipiente`, e ela não faz nada
-- quando o sistema acha o recipiente vazio (migration 112: "não há como saber
-- de qual lote é; não inventa vínculo"). O "Fechado" morreria em silêncio,
-- e o mesmo já valia para "Ainda tem" num balde que a fila tinha zerado.
--
-- Aqui não há o que inventar: embalagem do fornecedor tem UM lote, o
-- `origem_lote_id`. Então, quando o sistema acha a embalagem vazia e a resposta
-- diz que tem, o conteúdo volta pelo `abastecer_recipiente`, com esse lote.
--
-- ------ O movimento passa a registrar aumento ----------------
--
-- O item do movimento só sabia registrar o que SAIU (local_origem_id). A
-- quantidade de uma embalagem que voltou a encher virava item de 0. Agora o
-- aumento entra como item com local_destino_id — e item de zero não é mais
-- gravado.
--
-- Parte do corpo em produção (pg_get_functiondef em 28/09/2026), não da
-- migration 111.

CREATE OR REPLACE FUNCTION public.registrar_embalagens_encerradas(p_sessao_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_item        RECORD;
  v_local       locais%ROWTYPE;
  v_lote        RECORD;
  v_tinha       DECIMAL;
  v_fator       DECIMAL;
  v_qtd         DECIMAL;
  v_validade_ep DATE;
  v_erros       TEXT[] := '{}';
  v_mov_id      UUID;
  v_mov_codigo  TEXT;
  v_encerradas  INTEGER := 0;
  v_parciais    INTEGER := 0;
  v_diferenca   DECIMAL := 0;
  v_linha       RECORD;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'encerradas', 0, 'ainda_tem', 0,
                              'diferenca_total', 0);
  END IF;

  -- ── Conferência: nada é escrito antes de tudo passar ──────
  -- Uma chamada que falha no meio deixaria metade das embalagens encerradas e
  -- o operador sem saber quais.
  FOR v_item IN
    SELECT (e->>'local_id')::UUID AS local_id,
           ROUND(COALESCE((e->>'restante')::DECIMAL, 0), 3) AS restante
      FROM jsonb_array_elements(p_itens) e
  LOOP
    SELECT * INTO v_local
      FROM locais WHERE id = v_item.local_id AND empresa_id = p_empresa_id;

    IF NOT FOUND THEN
      v_erros := v_erros || 'Embalagem não encontrada.';
      CONTINUE;
    END IF;

    IF NOT v_local.efemero THEN
      v_erros := v_erros || format(
        '%s é um recipiente da cozinha, não uma embalagem do fornecedor. '
        'Recipiente não se encerra: ele é pesado no reabastecimento.', v_local.nome);
      CONTINUE;
    END IF;

    IF NOT v_local.ativo THEN
      v_erros := v_erros || format('%s já foi encerrada antes.', v_local.nome);
      CONTINUE;
    END IF;

    IF v_item.restante < 0 THEN
      v_erros := v_erros || format('%s: sobra negativa não existe.', v_local.nome);
    END IF;

    IF v_local.capacidade_max IS NOT NULL
       AND v_item.restante > v_local.capacidade_max + 0.001 THEN
      v_erros := v_erros || format(
        '%s: sobrou %s, mais do que a embalagem comporta (%s).',
        v_local.nome, qtd_legivel(v_item.restante), qtd_legivel(v_local.capacidade_max));
    END IF;

    -- Voltar a encher uma embalagem que o sistema acha vazia exige saber o
    -- lote dela. Toda embalagem do fornecedor tem; a trava é para a que não.
    IF v_item.restante > 0 AND v_local.origem_lote_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM locais_lotes
                        WHERE local_id = v_item.local_id AND quantidade > 0) THEN
      v_erros := v_erros || format(
        '%s: o sistema acha que está vazia e não sabe de qual lote ela é.', v_local.nome);
    END IF;
  END LOOP;

  IF array_length(v_erros, 1) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', array_to_string(v_erros, E'\n'));
  END IF;

  -- ── Escrita ───────────────────────────────────────────────
  -- Um movimento só para a operação inteira: é o fechamento de uma sessão, não
  -- sete acontecimentos separados.
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                             sessao_producao_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
          p_responsavel_id, p_sessao_id,
          'Embalagens do fornecedor conferidas no fechamento da produção.')
  RETURNING id INTO v_mov_id;

  FOR v_item IN
    SELECT (e->>'local_id')::UUID AS local_id,
           ROUND(COALESCE((e->>'restante')::DECIMAL, 0), 3) AS restante
      FROM jsonb_array_elements(p_itens) e
  LOOP
    SELECT * INTO v_local FROM locais WHERE id = v_item.local_id;

    SELECT COALESCE(SUM(quantidade), 0) INTO v_tinha
      FROM locais_lotes WHERE local_id = v_item.local_id;

    IF v_tinha <= 0 AND v_item.restante > 0 THEN
      -- O sistema acha vazia, a equipe diz que tem (lacrada, ou a fila tirou
      -- dela o que saiu de outra). Volta com o lote de origem; a validade é a
      -- que a embalagem já tinha no pote, e na falta dela a de aberto do lote.
      SELECT unidade, validade_pos_abertura INTO v_lote
        FROM lotes WHERE id = v_local.origem_lote_id;

      SELECT validade_ep INTO v_validade_ep
        FROM locais_lotes
       WHERE local_id = v_item.local_id AND lote_id = v_local.origem_lote_id;

      PERFORM abastecer_recipiente(
        v_item.local_id, v_local.origem_lote_id, v_item.restante, v_lote.unidade,
        COALESCE(v_validade_ep, v_lote.validade_pos_abertura));

      UPDATE locais
         SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW()
       WHERE id = v_item.local_id;

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_local.origem_lote_id, v_item.local_id,
              v_item.restante, v_lote.unidade);

      v_parciais := v_parciais + 1;
      CONTINUE;
    END IF;

    -- O item do movimento sai ANTES do ajuste: depois dele as quantidades já
    -- são as novas, e a diferença por lote não teria mais de onde ser lida.
    -- Fator < 1: saiu da embalagem. Fator > 1: voltou para ela.
    v_fator := CASE WHEN v_tinha > 0 THEN v_item.restante / v_tinha ELSE 0 END;

    FOR v_linha IN
      SELECT ll.lote_id, ll.quantidade, ll.unidade
        FROM locais_lotes ll
       WHERE ll.local_id = v_item.local_id AND ll.quantidade > 0
    LOOP
      v_qtd := ROUND(v_linha.quantidade * ABS(1 - v_fator), 3);
      CONTINUE WHEN v_qtd <= 0;

      IF v_fator < 1 THEN
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
        VALUES (v_mov_id, v_linha.lote_id, v_item.local_id, v_qtd, v_linha.unidade);
      ELSE
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_mov_id, v_linha.lote_id, v_item.local_id, v_qtd, v_linha.unidade);
      END IF;
    END LOOP;

    PERFORM ajustar_conteudo_recipiente(v_item.local_id, v_item.restante);

    IF v_item.restante <= 0 THEN
      -- Foi para o lixo: não pode continuar aparecendo como ponto de consumo.
      -- Desativa, não exclui — `movimentacoes_itens` aponta para esta linha e o
      -- histórico da produção precisa continuar legível.
      UPDATE locais SET ativo = false, updated_at = NOW() WHERE id = v_item.local_id;
      v_encerradas := v_encerradas + 1;
    ELSE
      v_parciais := v_parciais + 1;
    END IF;

    v_diferenca := v_diferenca + GREATEST(v_tinha - v_item.restante, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao',    v_mov_codigo,
    'encerradas',      v_encerradas,
    'ainda_tem',       v_parciais,
    'diferenca_total', ROUND(v_diferenca, 3)
  );
END;
$function$;

REVOKE ALL ON FUNCTION registrar_embalagens_encerradas(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_embalagens_encerradas(UUID, UUID, UUID, JSONB)
  TO authenticated, service_role;

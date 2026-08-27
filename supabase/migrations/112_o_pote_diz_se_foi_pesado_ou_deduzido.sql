-- ============================================================
-- Migration 108 — o pote diz se o numero dele foi pesado ou deduzido
--
-- O sistema sabe QUANTO a producao consome: sai da receita, e esta certo. De
-- qual pote saiu, ele nao sabe -- distribui pela fila, raspando um pote antes
-- de abrir o proximo.
--
-- Em 27/08/2026 a fila zerou o "Pote G Farinha de Trigo #2", que ninguem tinha
-- tocado. Ele passou dois dias mostrando 0 kg com 9,930 kg dentro, e so
-- apareceu quando o Lucca subiu os tres potes na balanca para conferir.
--
-- Errar a distribuicao e inevitavel enquanto a balanca nao disser de qual pote
-- saiu. O que nao pode e o chute ter a mesma cara de uma medicao: quem olhou
-- "0 kg" nao tinha como saber que aquilo era deducao.
--
-- ── Duas colunas, e o que mexe em cada uma ───────────────────
--
--   conteudo_estimado      o desconto teorico da sessao liga
--   conteudo_conferido_em  a pesagem desliga, e grava quando foi
--
-- Comeca NULL para todos os potes: nao sabemos quando cada um foi pesado pela
-- ultima vez, e inventar uma data seria repetir o erro que esta migration
-- conserta.
--
-- Transferencia nao mexe em nenhuma das duas. Ela adiciona uma quantidade
-- conhecida, mas nao diz nada sobre o que ja havia no pote -- se o que estava
-- la era chute, continua sendo.
--
-- As tres funcoes partiram de `pg_get_functiondef` -- ver CLAUDE.md.
-- ============================================================

ALTER TABLE locais ADD COLUMN IF NOT EXISTS conteudo_estimado BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE locais ADD COLUMN IF NOT EXISTS conteudo_conferido_em TIMESTAMPTZ;

COMMENT ON COLUMN locais.conteudo_estimado IS
  'true quando o conteudo atual do recipiente saiu do desconto teorico da '
  'sessao, e nao de uma pesagem. O total consumido esta certo; de qual pote '
  'saiu e distribuicao por fila, e a fila erra.';

COMMENT ON COLUMN locais.conteudo_conferido_em IS
  'Quando este recipiente foi pesado pela ultima vez. NULL = nunca, ou antes '
  'de existir este registro.';

CREATE OR REPLACE FUNCTION public.aplicar_teorico_nos_recipientes(p_sessao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao       sessoes_producao%ROWTYPE;
  v_local_id     UUID;
  v_linha        RECORD;
  v_lote         RECORD;
  v_mov_saida    UUID;
  v_mov_volta    UUID;
  v_mov_codigo   TEXT;
  v_delta        DECIMAL;
  v_move         DECIMAL;
  v_tem          DECIMAL;
  v_total_saiu   DECIMAL := 0;
  v_total_voltou DECIMAL := 0;
  v_potes        INTEGER := 0;
  v_mexeu        BOOLEAN;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao WHERE id = p_sessao_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;

  FOR v_local_id IN
    SELECT DISTINCT local_id FROM sessoes_producao_locais WHERE sessao_id = p_sessao_id
  LOOP
    -- Uma movimentação por pote e por sentido, criada só quando há o que
    -- registrar: com o teórico enfileirado a maioria dos potes fica em zero, e
    -- criar movimentação para eles encheria o histórico de registros vazios.
    v_mov_saida := NULL;
    v_mov_volta := NULL;
    v_mexeu     := FALSE;

    FOR v_linha IN
      SELECT spl.id, spl.lote_id,
             LEAST(COALESCE(spl.consumo_teorico, 0),
                   spl.quantidade_inicial + spl.quantidade_reposta) AS alvo,
             spl.consumo_aplicado AS aplicado
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_local_id
    LOOP
      v_delta := ROUND(v_linha.alvo - v_linha.aplicado, 3);
      CONTINUE WHEN v_delta = 0;

      SELECT l.unidade, l.validade_original INTO v_lote FROM lotes l WHERE l.id = v_linha.lote_id;

      IF v_delta > 0 THEN
        -- Sai do pote. Nunca além do que há lá dentro: se o teórico for maior,
        -- o insumo acabou no meio e alguém abasteceu — e agora a recarga chama
        -- `reaplicar_teorico_do_insumo`, que traz o resto para cá.
        SELECT COALESCE(quantidade, 0) INTO v_tem
          FROM locais_lotes WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;
        v_move := LEAST(v_delta, COALESCE(v_tem, 0));
        CONTINUE WHEN v_move <= 0;

        UPDATE locais_lotes
           SET quantidade = quantidade - v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        IF v_mov_saida IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'consumo_producao',
                  v_sessao.aberta_por, p_sessao_id,
                  'Consumo previsto da sessão, baixado na abertura.')
          RETURNING id INTO v_mov_saida;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
        VALUES (v_mov_saida, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado + v_move WHERE id = v_linha.id;

        v_total_saiu := v_total_saiu + v_move;
        v_mexeu := TRUE;

      ELSE
        -- O plano diminuiu: devolve ao pote o que não vai mais ser usado.
        v_move := -v_delta;

        UPDATE locais_lotes
           SET quantidade = quantidade + v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        -- A linha pode ter sumido no caminho (uma contagem que zerou o pote,
        -- por exemplo). O helper recria em vez de a devolução evaporar.
        IF NOT FOUND THEN
          PERFORM abastecer_recipiente(v_local_id, v_linha.lote_id, v_move,
                                       v_lote.unidade, v_lote.validade_original);
        END IF;

        IF v_mov_volta IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'ajuste_inventario',
                  v_sessao.aberta_por, p_sessao_id,
                  'Plano da sessão diminuiu: insumo devolvido ao recipiente.')
          RETURNING id INTO v_mov_volta;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_mov_volta, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado - v_move WHERE id = v_linha.id;

        v_total_voltou := v_total_voltou + v_move;
        v_mexeu := TRUE;
      END IF;
    END LOOP;

    IF v_mexeu THEN
      v_potes := v_potes + 1;

      -- O numero deste pote passou a ser CHUTE.
      --
      -- O sistema sabe quanto a receita consome; de qual pote saiu, nao sabe --
      -- ele distribui pela fila. Em 27/08/2026 a fila zerou o Pote G Farinha de
      -- Trigo #2, que ninguem tinha tocado: ficou dois dias mostrando zero com
      -- 9,930 kg dentro, e so apareceu quando o Lucca subiu o pote na balanca.
      --
      -- Errar a distribuicao e inevitavel. O que nao pode e o chute ter a mesma
      -- cara de uma medicao -- quem olha "0 kg" precisa saber se aquilo foi
      -- pesado ou deduzido.
      UPDATE locais SET conteudo_estimado = TRUE WHERE id = v_local_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'saiu',       ROUND(v_total_saiu, 3),
    'devolvido',  ROUND(v_total_voltou, 3),
    'recipientes', v_potes
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ajustar_conteudo_recipiente(p_local_id uuid, p_novo_total numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_total_atual DECIMAL;
BEGIN
  -- Alguem pos o pote na balanca: o que era estimativa vira fato. Vale mesmo
  -- quando o ajuste nao consegue mexer no conteudo (pote que o sistema achava
  -- vazio) -- a pesagem aconteceu de qualquer forma, e a data dela informa.
  UPDATE locais
     SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW()
   WHERE id = p_local_id;

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
$function$
;

CREATE OR REPLACE FUNCTION public.abrir_estoque_inicial(p_empresa_id uuid, p_responsavel_id uuid, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_item        JSONB;
  v_balde       JSONB;
  v_insumo      insumos%ROWTYPE;
  v_local       locais%ROWTYPE;
  v_validade    DATE;
  v_prateleira  NUMERIC;
  v_embalagens  INTEGER;
  v_baldes_tot  NUMERIC;
  v_qtd         NUMERIC;
  v_obs         TEXT;
  v_res         JSONB;
  v_lote_id     UUID;
  v_grupo_id    UUID;
  v_validade_ep DATE;
  v_etiquetas   JSONB := '[]'::JSONB;
  v_n_lotes     INTEGER := 0;
  v_n_baldes    INTEGER := 0;
  v_total       NUMERIC := 0;
BEGIN
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhum item informado.');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    SELECT * INTO v_insumo
      FROM insumos
     WHERE id = (v_item->>'insumo_id')::UUID
       AND empresa_id = p_empresa_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Insumo %s nao encontrado nesta empresa.', v_item->>'insumo_id'));
    END IF;

    v_prateleira := COALESCE((v_item->>'quantidade_prateleira')::NUMERIC, 0);
    IF v_prateleira < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s: quantidade na prateleira nao pode ser negativa.', v_insumo.nome));
    END IF;

    FOR v_balde IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'baldes', '[]'::JSONB))
    LOOP
      SELECT * INTO v_local
        FROM locais
       WHERE id = (v_balde->>'local_id')::UUID
         AND empresa_id = p_empresa_id;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: recipiente nao encontrado.', v_insumo.nome));
      END IF;

      IF v_local.insumo_id IS DISTINCT FROM v_insumo.id THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('O recipiente %s nao e de %s.', v_local.nome, v_insumo.nome));
      END IF;

      v_qtd := COALESCE((v_balde->>'quantidade')::NUMERIC, 0);
      IF v_qtd < 0 THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: quantidade negativa.', v_local.nome));
      END IF;

      -- A capacidade do recipiente NAO recusa mais a abertura.
      --
      -- Ela e uma estimativa nossa, digitada no cadastro; o peso na balanca e
      -- o fato. Quando o operador poe 19 kg num pote anotado como 17, quem
      -- esta errado e o cadastro. Recusar aqui obrigava a mentir o peso para
      -- conseguir salvar -- e e o peso que vira estoque.
      --
      -- A tela avisa em ambar e deixa seguir. Fica so a recusa de quantidade
      -- negativa, acima, que e impossivel e nao estimativa.
    END LOOP;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    SELECT * INTO v_insumo FROM insumos WHERE id = (v_item->>'insumo_id')::UUID;

    v_prateleira := COALESCE((v_item->>'quantidade_prateleira')::NUMERIC, 0);
    v_embalagens := GREATEST(COALESCE((v_item->>'embalagens')::INTEGER, 1), 1);

    SELECT COALESCE(SUM(COALESCE((b->>'quantidade')::NUMERIC, 0)), 0)
      INTO v_baldes_tot
      FROM jsonb_array_elements(COALESCE(v_item->'baldes', '[]'::JSONB)) b;

    CONTINUE WHEN v_prateleira <= 0 AND v_baldes_tot <= 0;

    v_validade := COALESCE(NULLIF(v_item->>'validade', '')::DATE, CURRENT_DATE + 3650);

    v_obs := COALESCE(NULLIF(v_item->>'observacoes', ''), 'Saldo de abertura do estoque');

    IF v_prateleira > 0 THEN
      v_res := registrar_entrada_lote(
        p_empresa_id, v_insumo.id,
        NULLIF(v_item->>'fornecedor_id', '')::UUID,
        CURRENT_DATE, v_validade, v_prateleira,
        v_insumo.unidade_medida::TEXT, v_embalagens,
        v_obs, p_responsavel_id, NULL,
        NULLIF(v_item->>'marca_id', '')::UUID);

      IF NOT (v_res->>'ok')::BOOLEAN THEN
        RAISE EXCEPTION 'Falha ao criar o lote de %: %', v_insumo.nome, v_res->>'erro';
      END IF;

      -- Marcar pelos ids que a entrada devolveu, e nao por `lote_grupo_id`:
      -- `registrar_entrada_lote` nunca devolveu esse campo, entao v_grupo_id
      -- ficava NULL e o UPDATE nao acertava linha nenhuma. O saldo de abertura
      -- da prateleira vinha nascendo sem marca desde sempre -- passando por
      -- compra normal no relatorio, e invisivel para quem quisesse desfazer.
      v_grupo_id := (v_res->>'lote_grupo_id')::UUID;
      UPDATE lotes SET origem = 'inventario_inicial'
       WHERE id IN (SELECT (e->>'lote_id')::UUID
                      FROM jsonb_array_elements(v_res->'lotes') e);

      v_etiquetas := v_etiquetas || (v_res->'lotes');
      v_n_lotes := v_n_lotes + v_embalagens;
      v_total := v_total + v_prateleira;
    END IF;

    IF v_baldes_tot > 0 THEN
      v_res := registrar_entrada_lote(
        p_empresa_id, v_insumo.id,
        NULLIF(v_item->>'fornecedor_id', '')::UUID,
        CURRENT_DATE, v_validade, v_baldes_tot,
        v_insumo.unidade_medida::TEXT, 1,
        'Saldo de abertura - conteudo ja nos recipientes', p_responsavel_id, NULL,
        NULLIF(v_item->>'marca_id', '')::UUID);

      IF NOT (v_res->>'ok')::BOOLEAN THEN
        RAISE EXCEPTION 'Falha ao criar o lote de %: %', v_insumo.nome, v_res->>'erro';
      END IF;

      -- `lote_id` e o PRIMEIRO lote da entrada, e a entrada pode ter criado
      -- varios: registrar_entrada_lote fatia pelo tamanho da embalagem.
      v_lote_id := (v_res->>'lote_id')::UUID;
      UPDATE lotes SET origem = 'inventario_inicial'
       WHERE id IN (SELECT (e->>'lote_id')::UUID
                      FROM jsonb_array_elements(v_res->'lotes') e);

      v_validade_ep := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_validade)
        ELSE v_validade
      END;

      FOR v_balde IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'baldes', '[]'::JSONB))
      LOOP
        v_qtd := COALESCE((v_balde->>'quantidade')::NUMERIC, 0);
        CONTINUE WHEN v_qtd <= 0;

        PERFORM abastecer_recipiente(
          (v_balde->>'local_id')::UUID, v_lote_id, v_qtd,
          v_insumo.unidade_medida, v_validade_ep);

        -- A abertura pesa cada pote na bancada: isto e medicao, nao estimativa.
        UPDATE locais
           SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW()
         WHERE id = (v_balde->>'local_id')::UUID;

        v_n_baldes := v_n_baldes + 1;
      END LOOP;

      -- Todo o conteudo destes lotes esta nos baldes: no estoque central nao
      -- fica nada. Zera TODOS os lotes que a entrada criou.
      --
      -- Antes descontava `v_baldes_tot` de um lote so, o primeiro. Quando o
      -- conteudo dos baldes passava de uma embalagem, a entrada fatiava --
      -- 12,5 kg com fardo de 10 viram um lote de 10 e outro de 2,5 -- e a
      -- conta virava 10 menos 12,5. O `chk_quantidade` recusava, e a abertura
      -- inteira morria depois de meia hora de digitacao.
      UPDATE lotes
         SET quantidade_disponivel = 0,
             status = 'esgotado'::status_lote_enum
       WHERE id IN (SELECT (e->>'lote_id')::UUID
                      FROM jsonb_array_elements(v_res->'lotes') e);

      v_total := v_total + v_baldes_tot;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'lotes', v_etiquetas,
    'lotes_criados', v_n_lotes,
    'recipientes_abastecidos', v_n_baldes,
    'quantidade_total', ROUND(v_total, 3));
END;
$function$
;

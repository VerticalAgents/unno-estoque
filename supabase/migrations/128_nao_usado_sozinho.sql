-- ============================================================
-- Migration 128 — "Não foi usado" sem reabastecimento junto
--
-- A 125 só aceitava "Não foi usado" junto de um pote que recebesse insumo,
-- porque a função exigia embalagem bipada. No fim do dia o pote intocado não
-- precisa de nada, e a declaração ficava sem ter como ser feita.
--
-- Parte do corpo em produção (pg_get_functiondef em 29/09/2026).

CREATE OR REPLACE FUNCTION public.registrar_abastecimento(p_empresa_id uuid, p_responsavel_id uuid, p_insumo_id uuid, p_potes jsonb, p_lotes jsonb, p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_insumo       insumos%ROWTYPE;
  v_p            RECORD;
  v_l            RECORD;
  v_colocado     DECIMAL := 0;
  v_consumido    DECIMAL := 0;
  v_perda        DECIMAL;
  v_mov_id       UUID;
  v_mov_codigo   TEXT;
  v_perda_mov_id UUID;
  v_perda_cod    TEXT;
  v_falta        DECIMAL;
  v_leva         DECIMAL;
  v_validade_ep  DATE;
  v_perda_resta  DECIMAL;
  v_perda_lote   DECIMAL;
  v_n            INTEGER;
  v_i            INTEGER := 0;
  v_potes_txt    TEXT;
  -- Folga de balança
  v_folga_pct    DECIMAL;
  v_excesso      DECIMAL := 0;
  v_folga        DECIMAL;
  v_aviso        DECIMAL;
  v_sobra_total  DECIMAL;
  v_ceder        DECIMAL;
  v_ceder_resta  DECIMAL;
  v_ceder_lote   DECIMAL;
  v_ajustes      JSONB := '[]'::JSONB;
  v_potes_cedem  DECIMAL := 0;
  -- Acerto de balde
  v_acerto_mov   UUID;
  v_sistema      DECIMAL;
  v_acerto       DECIMAL;
  v_acerto_total DECIMAL := 0;
  v_acertos      JSONB := '[]'::JSONB;
  v_resta        DECIMAL;
  v_fatia        DECIMAL;
  v_orfao        DECIMAL := 0;
  v_lote_orfao   UUID;
  -- Correção de lote (a embalagem tinha mais)
  v_corr_resta   DECIMAL;
  v_corr_lote    DECIMAL;
  v_correcoes    JSONB := '[]'::JSONB;
  v_corr_total   DECIMAL := 0;
  -- Embalagem que ninguém pesou
  v_atribuir     DECIMAL;
  -- Pote que não foi usado (migration 125)
  v_volta_mov    UUID;
  v_dev          RECORD;
  v_nao_usados   JSONB := '[]'::JSONB;
  -- Só "Não foi usado", sem nada entrando (migration 128)
  v_so_decl      BOOLEAN;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  IF jsonb_array_length(COALESCE(p_potes, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe o que entrou em pelo menos um recipiente.');
  END IF;
  -- Sem lote bipado só vale se TODO pote da chamada for "Não foi usado" sem
  -- receber nada — conferido lá embaixo, depois que o `colocou` é calculado.
  v_so_decl := jsonb_array_length(COALESCE(p_lotes, '[]'::JSONB)) = 0;

  -- Limpa antes de criar: uma validação que retorna cedo não chega ao fim da
  -- função, e a temporária sobreviveria para a próxima chamada da mesma sessão.
  DROP TABLE IF EXISTS _ab_lotes;
  DROP TABLE IF EXISTS _ab_potes;

  -- Fotografia do estado ANTES de qualquer escrita. Sem ela, a distribuição da
  -- perda leria saldos já baixados e daria zero.
  CREATE TEMP TABLE _ab_lotes ON COMMIT DROP AS
  SELECT l.id, l.codigo, l.unidade, l.status, l.insumo_id,
         l.validade_original, l.validade_pos_abertura,
         l.quantidade_disponivel                                  AS saldo,
         -- Sem COALESCE de propósito: sobra ausente é NULL, e NULL não é zero.
         -- Zero afirma "a embalagem foi esvaziada"; NULL diz "ninguém pesou".
         ROUND((e->>'sobra')::DECIMAL, 3)                          AS sobra,
         ROUND(l.quantidade_disponivel
               - ROUND((e->>'sobra')::DECIMAL, 3), 3)              AS gasto,
         ((e->>'sobra') IS NULL)                                   AS nao_pesada,
         0::DECIMAL                                                AS distribuido,
         0::DECIMAL                                                AS correcao
    FROM jsonb_array_elements(p_lotes) e
    JOIN lotes l ON l.id = (e->>'lote_id')::UUID AND l.empresa_id = p_empresa_id;

  -- O pote agora traz as DUAS pesagens. `colocou` deixa de depender do que o
  -- sistema supunha e vira subtração de duas medições.
  CREATE TEMP TABLE _ab_potes ON COMMIT DROP AS
  SELECT (e->>'local_id')::UUID                            AS local_id,
         ROUND(COALESCE((e->>'antes')::DECIMAL, 0), 3)     AS antes,
         ROUND(COALESCE((e->>'depois')::DECIMAL, 0), 3)    AS depois,
         COALESCE(e->>'medido', 'pesado')                  AS medido,
         ROUND(COALESCE((e->>'depois')::DECIMAL, 0)
               - COALESCE((e->>'antes')::DECIMAL, 0), 3)   AS colocou,
         ROW_NUMBER() OVER ()                              AS ordem,
         COALESCE((e->>'nao_usado')::BOOLEAN, FALSE)       AS nao_usado,
         ((e->>'depois') IS NULL)                          AS sem_depois,
         0::DECIMAL                                        AS devolver
    FROM jsonb_array_elements(p_potes) e;

  -- ══════════════════════════════════════════════════════════
  -- "NÃO FOI USADO" (migration 125, pedido do Lucca em 28/09/2026)
  --
  -- O consumo teórico sai dos potes pela FILA, não pelo que a equipe abriu:
  -- um pote intocado pode estar "vazio" no sistema. Até aqui o único jeito de
  -- dizer isso era pesar o antes — e pesar pote intocado toma tempo.
  --
  -- O pote marcado volta ao que tinha na ÚLTIMA PESAGEM: o `antes` deixa de
  -- ser digitado e vira "o que o sistema tem + o que o teórico tirou dele
  -- desde então". A devolução em si (nos mesmos lotes) acontece lá embaixo,
  -- no acerto de balde; aqui só se calcula, porque nada pode ser escrito antes
  -- das conferências passarem.
  --
  -- Sem `depois`, o pote vai só como declaração: depois = antes, colocou 0.
  -- ══════════════════════════════════════════════════════════
  UPDATE _ab_potes p
     SET devolver = COALESCE((SELECT SUM(c.quantidade)
                                FROM consumo_teorico_desde_pesagem(p.local_id) c), 0)
   WHERE p.nao_usado;

  UPDATE _ab_potes p
     SET antes = ROUND(COALESCE((SELECT SUM(ll.quantidade) FROM locais_lotes ll
                                  WHERE ll.local_id = p.local_id), 0) + p.devolver, 3)
   WHERE p.nao_usado;

  UPDATE _ab_potes SET depois = antes WHERE nao_usado AND sem_depois;

  -- Pesou um pouco MENOS do que a última pesagem: duas balanças nunca fecham
  -- no grama. Até 2% (a folga da tela) conta como "não recebeu nada" e o
  -- número da balança manda. Mais do que isso é pote que foi usado — recusa
  -- lá embaixo.
  UPDATE _ab_potes
     SET antes = depois
   WHERE nao_usado AND depois < antes AND antes - depois <= ROUND(antes * 0.02, 3);

  UPDATE _ab_potes SET colocou = ROUND(depois - antes, 3) WHERE nao_usado;

  -- ══════════════════════════════════════════════════════════
  -- "NÃO FOI USADO" SOZINHO (migration 128, pedido do Lucca em 29/09/2026)
  --
  -- O reabastecimento começa antes de a produção do dia acabar: o #1 é
  -- recarregado às 14h, e só no fim do dia se sabe que o #3 ficou intocado.
  -- Aí o #3 não precisa de insumo nenhum — e exigir uma embalagem bipada
  -- travava a única coisa que havia para dizer.
  -- ══════════════════════════════════════════════════════════
  IF v_so_decl AND EXISTS (SELECT 1 FROM _ab_potes WHERE NOT nao_usado OR colocou > 0) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Escaneie os lotes que foram usados.');
  END IF;

  IF (SELECT COUNT(*) FROM _ab_lotes) <> jsonb_array_length(p_lotes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  FOR v_l IN SELECT * FROM _ab_lotes LOOP
    IF v_l.insumo_id <> p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s é de outro insumo.', v_l.codigo));
    END IF;
    IF v_l.status <> 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s não está ativo (%s).', v_l.codigo, v_l.status));
    END IF;
    IF v_l.sobra IS NOT NULL THEN
      IF v_l.sobra < 0 THEN
        RETURN jsonb_build_object('ok', false, 'erro', 'A sobra não pode ser negativa.');
      END IF;
      IF v_l.sobra > v_l.saldo + 0.001 THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('Sobra de %s no lote %s, que tinha %s. Confira a balança.',
                 qtd_legivel(v_l.sobra), v_l.codigo, qtd_legivel(v_l.saldo)));
      END IF;
    END IF;
  END LOOP;

  FOR v_p IN SELECT * FROM _ab_potes LOOP
    IF v_p.antes < 0 OR v_p.depois < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Peso negativo não existe.');
    END IF;
    IF v_p.nao_usado THEN
      IF (SELECT conteudo_conferido_em FROM locais WHERE id = v_p.local_id) IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', format(
          '%s nunca foi pesado, então não há "última pesagem" para voltar. Pese o antes.',
          (SELECT nome FROM locais WHERE id = v_p.local_id)));
      END IF;
      IF v_p.colocou < 0 THEN
        RETURN jsonb_build_object('ok', false, 'erro', format(
          '%s pesou %s, menos do que os %s da última pesagem — então ele foi usado. '
          'Desmarque "Não foi usado" e pese o antes.',
          (SELECT nome FROM locais WHERE id = v_p.local_id),
          qtd_legivel(v_p.depois), qtd_legivel(v_p.antes)));
      END IF;
    ELSIF COALESCE(v_p.colocou, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O recipiente terminou com %s e começou com %s — não recebeu nada. '
               'Confira a balança ou tire-o da lista.',
               qtd_legivel(v_p.depois), qtd_legivel(v_p.antes)));
    END IF;
    PERFORM 1 FROM locais l
     WHERE l.id = v_p.local_id AND l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo' AND l.ativo
       AND (l.insumo_id IS NULL OR l.insumo_id = p_insumo_id);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Um dos recipientes não existe ou é de outro insumo.');
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(colocou), 0) INTO v_colocado  FROM _ab_potes;
  -- Só os pesados entram aqui: SUM ignora NULL, e é isso que se quer.
  SELECT COALESCE(SUM(gasto),   0) INTO v_consumido FROM _ab_lotes;

  -- ==========================================================
  -- A EMBALAGEM QUE NINGUÉM PESOU
  --
  -- Ninguém põe um fardo de 25 kg na balança para devolvê-lo à prateleira. A
  -- tela perguntava "zerou ou sobrou quanto?" e só deixava seguir por "Zerou"
  -- quem não tinha o número — e "Zerou" manda para o lixo tudo o que não
  -- entrou no pote.
  --
  -- Entre 24 e 27/08/2026 isso escreveu 47 kg de insumo como desperdício. O
  -- caso extremo foi a Essência de Doce de Leite: 9,944 kg de perda numa
  -- recarga só, para encher um pote de 1,5 kg a partir de uma embalagem de 15.
  --
  -- Agora existe a terceira resposta, e ela chega como sobra NULL. Quem
  -- responde por essas embalagens é a balança do POTE, que mediu de verdade:
  -- o que entrou nos recipientes e não veio das embalagens pesadas saiu daqui.
  -- FEFO, esvaziando a mais velha antes de abrir a próxima — a mesma ordem da
  -- distribuição lá embaixo, para o resultado ser sempre explicável.
  --
  -- O saldo que resta é DEDUZIDO, não medido, e o lote sai marcado como tal
  -- (saldo_estimado). É a mesma distinção que a 112 fez para o pote: o chute
  -- não pode ter a mesma cara de uma medição.
  --
  -- Se ainda faltar depois de esgotar todas, o excedente segue para a correção
  -- de lote ("a embalagem tinha mais"), que já existia mais abaixo.
  -- ==========================================================
  IF EXISTS (SELECT 1 FROM _ab_lotes WHERE nao_pesada) THEN
    v_atribuir := ROUND(v_colocado - v_consumido, 3);

    FOR v_l IN
      SELECT * FROM _ab_lotes WHERE nao_pesada
       ORDER BY validade_pos_abertura, codigo
    LOOP
      v_leva := GREATEST(LEAST(v_atribuir, v_l.saldo), 0);

      UPDATE _ab_lotes
         SET gasto = v_leva,
             sobra = ROUND(v_l.saldo - v_leva, 3)
       WHERE id = v_l.id;

      v_atribuir := ROUND(v_atribuir - v_leva, 3);
    END LOOP;

    SELECT COALESCE(SUM(gasto), 0) INTO v_consumido FROM _ab_lotes;
  END IF;

  IF v_consumido <= 0 AND NOT v_so_decl THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'As sobras declaradas dizem que nada saiu das embalagens.');
  END IF;

  -- ══════════════════════════════════════════════════════════
  -- ACERTO DE BALDE — a balança de antes contra o saldo do sistema
  --
  -- Acontece ANTES de somar o que entrou: o que se está corrigindo é o estado
  -- de partida do pote. Rateado entre os lotes que estão lá dentro, na
  -- proporção de cada um (regra da casa), com o último fechando a conta.
  -- ══════════════════════════════════════════════════════════
  FOR v_p IN SELECT * FROM _ab_potes ORDER BY ordem LOOP
    -- "Não foi usado": devolve o que o teórico tirou, NOS MESMOS LOTES, antes
    -- de comparar. Depois disso o sistema bate com o `antes` e o acerto fica
    -- zero (ou a pequena diferença de balança aceita acima).
    IF v_p.nao_usado AND v_p.devolver > 0 THEN
      FOR v_dev IN SELECT * FROM consumo_teorico_desde_pesagem(v_p.local_id) LOOP
        PERFORM abastecer_recipiente(v_p.local_id, v_dev.lote_id, v_dev.quantidade,
                                     v_dev.unidade, v_dev.validade_ep);

        IF v_volta_mov IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
          VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
                  p_responsavel_id,
                  'Recipiente declarado "não foi usado" no reabastecimento: volta ao '
                  'que tinha na última pesagem.')
          RETURNING id INTO v_volta_mov;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_volta_mov, v_dev.lote_id, v_p.local_id, v_dev.quantidade, v_dev.unidade);
      END LOOP;

      v_nao_usados := v_nao_usados || jsonb_build_object(
        'local_id', v_p.local_id, 'devolvido', v_p.devolver);
    END IF;

    SELECT COALESCE(SUM(quantidade), 0) INTO v_sistema
      FROM locais_lotes WHERE local_id = v_p.local_id;

    v_acerto := ROUND(v_p.antes - v_sistema, 3);
    CONTINUE WHEN ABS(v_acerto) < 0.001;

    IF v_acerto < 0 OR v_sistema > 0 THEN
      -- Há conteúdo a quem atribuir: rateia entre os lotes do pote.
      v_resta := v_acerto;
      SELECT COUNT(*) INTO v_n FROM locais_lotes
       WHERE local_id = v_p.local_id AND quantidade > 0;

      v_i := 0;
      FOR v_l IN
        SELECT ll.lote_id, ll.quantidade, ll.unidade
          FROM locais_lotes ll
         WHERE ll.local_id = v_p.local_id AND ll.quantidade > 0
         ORDER BY ll.quantidade DESC, ll.lote_id
      LOOP
        v_i := v_i + 1;
        IF v_i = v_n THEN
          v_fatia := v_resta;
        ELSE
          v_fatia := ROUND(v_acerto * (v_l.quantidade / NULLIF(v_sistema, 0)), 3);
        END IF;
        CONTINUE WHEN COALESCE(v_fatia, 0) = 0;

        -- Nunca abaixo de zero: o rateio pode pedir mais do que a linha tem.
        v_fatia := GREATEST(v_fatia, -v_l.quantidade);

        UPDATE locais_lotes
           SET quantidade = quantidade + v_fatia, updated_at = NOW()
         WHERE local_id = v_p.local_id AND lote_id = v_l.lote_id;

        IF v_acerto_mov IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
          VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
                  p_responsavel_id,
                  'A balança discordou do saldo do recipiente na hora de recarregar.')
          RETURNING id INTO v_acerto_mov;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
        VALUES (v_acerto_mov, v_l.lote_id,
                CASE WHEN v_fatia < 0 THEN v_p.local_id END,
                CASE WHEN v_fatia > 0 THEN v_p.local_id END,
                ABS(v_fatia), v_l.unidade);

        v_resta := v_resta - v_fatia;
      END LOOP;
    ELSE
      -- Pote que o sistema dá como vazio e a balança acusa conteúdo. Não há
      -- lote a quem atribuir; vai para o que está entrando agora, e fica
      -- registrado como exceção — recusar a recarga no meio do turno seria
      -- pior do que atribuir com ressalva.
      v_orfao := v_orfao + v_acerto;
    END IF;

    v_acerto_total := v_acerto_total + v_acerto;
    v_acertos := v_acertos || jsonb_build_object(
      'local_id', v_p.local_id,
      'esperado', v_sistema,
      'medido',   v_p.antes,
      'acerto',   v_acerto);
  END LOOP;

  -- ══════════════════════════════════════════════════════════
  -- FOLGA DE BALANÇA — agora uma escolha, e desligada por padrão
  -- ══════════════════════════════════════════════════════════
  SELECT folga_balanca_pct INTO v_folga_pct
    FROM configuracoes_sistema WHERE empresa_id = p_empresa_id;

  v_excesso := ROUND(v_colocado - v_consumido, 3);

  IF v_excesso > 0 THEN
    -- A folga só existe se alguém a ligou. O AVISO, esse continua com 1% mesmo
    -- desligada: ele não é sobre tolerância de balança, é sobre embalagem que
    -- ficou sem bipar — e isso vale a pena pegar de qualquer jeito.
    v_folga := ROUND(v_consumido * COALESCE(v_folga_pct, 0) / 100.0, 3);
    v_aviso := ROUND(v_consumido * COALESCE(NULLIF(v_folga_pct, 0), 1) / 100.0, 3);

    -- A RECUSA SAIU (migration 123, pedido do Lucca em 28/09/2026). A tela
    -- pedia explicação acima de 2% e o banco recusava acima de 1%: entre os
    -- dois, o abastecimento morria sem campo para explicar — 0,17 kg em 10 kg
    -- travou o processo inteiro. O excesso continua registrado; só não
    -- bloqueia mais.

    -- Dentro da folga (quando ligada), a sobra cede: é ruído de duas balanças e
    -- não vale discussão. Fora dela, a sobra fica EXATAMENTE como foi digitada.
    IF v_excesso <= v_folga AND v_folga > 0 THEN
      SELECT COALESCE(SUM(sobra), 0) INTO v_sobra_total FROM _ab_lotes;
      v_ceder := LEAST(v_excesso, v_sobra_total);

      IF v_ceder > 0 THEN
        v_ceder_resta := v_ceder;
        SELECT COUNT(*) INTO v_n FROM _ab_lotes WHERE sobra > 0;
        v_i := 0;

        FOR v_l IN
          SELECT * FROM _ab_lotes WHERE sobra > 0 ORDER BY validade_pos_abertura, codigo
        LOOP
          v_i := v_i + 1;
          IF v_i = v_n THEN
            v_ceder_lote := LEAST(v_ceder_resta, v_l.sobra);
          ELSE
            v_ceder_lote := LEAST(ROUND(v_ceder * (v_l.sobra / v_sobra_total), 3),
                                  v_ceder_resta, v_l.sobra);
          END IF;
          CONTINUE WHEN COALESCE(v_ceder_lote, 0) <= 0;

          UPDATE _ab_lotes
             SET sobra = sobra - v_ceder_lote,
                 gasto = gasto + v_ceder_lote
           WHERE id = v_l.id;

          v_ajustes := v_ajustes || jsonb_build_object(
            'codigo',          v_l.codigo,
            'sobra_declarada', v_l.sobra,
            'sobra_ajustada',  ROUND(v_l.sobra - v_ceder_lote, 3));

          v_ceder_resta := v_ceder_resta - v_ceder_lote;
        END LOOP;

        SELECT COALESCE(SUM(gasto), 0) INTO v_consumido FROM _ab_lotes;
      END IF;
    END IF;

    -- ────────────────────────────────────────────────────────
    -- O que sobrou de excesso: A EMBALAGEM TINHA MAIS DO QUE O REGISTRADO.
    --
    -- Sem isto o conteúdo apareceria no pote vindo do nada — e o pote receberia
    -- menos do que a balança marcou, porque a distribuição só tem `gasto` para
    -- distribuir. Rateio proporcional ao gasto; exato quando é um lote só, que
    -- é o caso comum.
    -- ────────────────────────────────────────────────────────
    v_corr_resta := ROUND(v_colocado - v_consumido, 3);

    IF v_corr_resta > 0 THEN
      v_corr_total := v_corr_resta;
      SELECT COUNT(*) INTO v_n FROM _ab_lotes WHERE gasto > 0;
      v_i := 0;

      FOR v_l IN
        SELECT * FROM _ab_lotes WHERE gasto > 0 ORDER BY validade_pos_abertura, codigo
      LOOP
        v_i := v_i + 1;
        IF v_i = v_n THEN
          v_corr_lote := v_corr_resta;
        ELSE
          v_corr_lote := LEAST(
            ROUND(v_corr_total * (v_l.gasto / NULLIF(v_consumido, 0)), 3), v_corr_resta);
        END IF;
        CONTINUE WHEN COALESCE(v_corr_lote, 0) <= 0;

        UPDATE _ab_lotes
           SET gasto = gasto + v_corr_lote, correcao = correcao + v_corr_lote
         WHERE id = v_l.id;

        v_correcoes := v_correcoes || jsonb_build_object(
          'codigo', v_l.codigo, 'a_mais', v_corr_lote);

        v_corr_resta := v_corr_resta - v_corr_lote;
      END LOOP;

      SELECT COALESCE(SUM(gasto), 0) INTO v_consumido FROM _ab_lotes;
    END IF;

    v_potes_cedem := ROUND(GREATEST(v_colocado - v_consumido, 0), 3);
    v_i := 0;
  END IF;

  v_perda := GREATEST(ROUND(v_consumido - v_colocado, 3), 0);

  -- Só declaração: nada entrou, e um movimento de transferência vazio só
  -- encheria o histórico. A devolução já tem o movimento dela.
  IF NOT v_so_decl THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
            p_responsavel_id, p_justificativa)
    RETURNING id INTO v_mov_id;
  END IF;

  -- Qual lote foi para qual pote não é perguntado: na prática é um lote só, e
  -- os potes rodam todos na produção seguinte. Regra fixa (FEFO) para o
  -- resultado ser sempre explicável.
  FOR v_p IN SELECT * FROM _ab_potes ORDER BY ordem LOOP
    v_falta := v_p.colocou;

    FOR v_l IN
      SELECT * FROM _ab_lotes
       WHERE gasto - distribuido > 0
       ORDER BY validade_pos_abertura, codigo
    LOOP
      EXIT WHEN v_falta <= 0;
      v_leva := LEAST(v_falta, v_l.gasto - v_l.distribuido);
      CONTINUE WHEN v_leva <= 0;

      v_validade_ep := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_l.validade_original)
        ELSE v_l.validade_original
      END;

      PERFORM abastecer_recipiente(v_p.local_id, v_l.id, v_leva, v_l.unidade, v_validade_ep);

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_l.id, v_p.local_id, v_leva, v_l.unidade);

      UPDATE _ab_lotes SET distribuido = distribuido + v_leva WHERE id = v_l.id;
      v_falta := v_falta - v_leva;

      IF v_lote_orfao IS NULL THEN v_lote_orfao := v_l.id; END IF;
    END LOOP;
  END LOOP;

  -- O conteúdo órfão (pote que o sistema dava como vazio) entra pelo lote que
  -- acabou de ser despejado, e a ressalva fica registrada.
  IF v_orfao > 0 AND v_lote_orfao IS NOT NULL THEN
    SELECT * INTO v_l FROM _ab_lotes WHERE id = v_lote_orfao;
    PERFORM abastecer_recipiente(
      (SELECT local_id FROM _ab_potes ORDER BY ordem LIMIT 1),
      v_lote_orfao, v_orfao, v_l.unidade, v_l.validade_original);

    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'acerto_sem_lote',
      jsonb_build_object('quantidade', v_orfao, 'lote', v_l.codigo),
      COALESCE(NULLIF(trim(p_justificativa), ''),
               'O recipiente tinha conteúdo que o sistema não conhecia.'));
  END IF;

  UPDATE lotes l
     SET quantidade_disponivel = a.sobra,
         -- Pesou: o número é firme e a data registra quando. Não pesou: o
         -- número saiu da conta, e quem olhar precisa saber disso.
         saldo_estimado     = a.nao_pesada,
         saldo_conferido_em = CASE WHEN a.nao_pesada
                                   THEN l.saldo_conferido_em ELSE NOW() END,
         -- A embalagem tinha mais do que a nota dizia: o recebido sobe junto,
         -- senão o lote passaria a dever quantidade a si mesmo.
         quantidade_recebida = l.quantidade_recebida + a.correcao,
         status = CASE WHEN a.sobra <= 0 THEN 'esgotado'::status_lote_enum ELSE l.status END
    FROM _ab_lotes a
   WHERE l.id = a.id;

  -- INSERT direto de propósito: registrar_perda_insumo desconta do lote, e o
  -- saldo acima já é o medido. Chamá-la subtrairia a perda duas vezes.
  IF v_perda > 0 THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'perda_insumo', p_responsavel_id,
            'Diferença entre o que saiu das embalagens e o que entrou nos recipientes.')
    RETURNING id INTO v_perda_mov_id;

    v_perda_resta := v_perda;
    SELECT COUNT(*) INTO v_n FROM _ab_lotes WHERE gasto > 0;
    v_i := 0;

    FOR v_l IN
      SELECT * FROM _ab_lotes WHERE gasto > 0 ORDER BY validade_pos_abertura, codigo
    LOOP
      v_i := v_i + 1;
      IF v_i = v_n THEN
        v_perda_lote := v_perda_resta;
      ELSE
        v_perda_lote := LEAST(ROUND(v_perda * (v_l.gasto / v_consumido), 3), v_perda_resta);
      END IF;
      CONTINUE WHEN COALESCE(v_perda_lote, 0) <= 0;

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, quantidade, unidade)
      VALUES (v_perda_mov_id, v_l.id, v_perda_lote, v_l.unidade);

      v_perda_resta := v_perda_resta - v_perda_lote;
    END LOOP;
  END IF;

  SELECT string_agg(l.nome, ', ' ORDER BY l.nome) INTO v_potes_txt
    FROM _ab_potes p JOIN locais l ON l.id = p.local_id;

  -- Todo pote daqui saiu PESADO (ou declarado intocado desde a última
  -- pesagem): o número dele é medição. Antes da 125 isto não era gravado, e a
  -- "última pesagem" ficava na contagem — o "Não foi usado" devolveria um
  -- consumo que o reabastecimento já tinha zerado.
  --
  -- Vem ANTES do reaplicar: o que ele tirar agora é consumo depois desta
  -- pesagem (mesmo NOW(), por isso o `>=` em consumo_teorico_desde_pesagem).
  UPDATE locais
     SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW(), updated_at = NOW()
   WHERE id IN (SELECT local_id FROM _ab_potes);

  -- O teórico pendente da sessão aberta desce do que acabou de chegar. Sem
  -- isto o balde só pode ser recarregado uma vez por sessão (migration 108).
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao', v_mov_codigo,
    'colocado',     ROUND(v_colocado, 3),
    'consumido',    ROUND(v_consumido, 3),
    'perda',        v_perda,
    'recipientes',  v_potes_txt,
    'acerto_balde', ROUND(v_acerto_total, 3),
    'acertos',      v_acertos,
    'correcoes',    v_correcoes,
    'ajustes',      v_ajustes,
    'potes_cedem',  v_potes_cedem,
    'nao_usados',   v_nao_usados
  );
END;
$function$;

REVOKE ALL ON FUNCTION registrar_abastecimento(UUID, UUID, UUID, JSONB, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_abastecimento(UUID, UUID, UUID, JSONB, JSONB, TEXT)
  TO authenticated, service_role;

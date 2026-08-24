-- ============================================================
-- Migration 108 — o teórico alcança o que chega no meio da sessão
--
-- O DEFEITO. O consumo teórico da sessão é debitado de uma vez, na abertura
-- (migration 085). Depois disso o número do balde não desce mais. Recarrega-se
-- uma vez e o sistema passa a mostrar o balde cheio enquanto a produção o
-- esvazia; na segunda recarga a tela diz "Cheio" e não deixa fazer nada.
--
-- Na prática o sistema só servia a quem tivesse balde sobrando para o dia
-- inteiro — e nem sempre dá.
--
-- A CAUSA, PRECISA. Duas funções limitam cada pote a `quantidade_inicial`, que
-- é a foto do pote na ABERTURA:
--
--   • `redistribuir_teorico_sequencial` enfileira o teórico só até o que havia;
--   • `aplicar_teorico_nos_recipientes` tem `LEAST(consumo_teorico,
--     quantidade_inicial)` como teto do que pode sair.
--
-- O que entra depois da abertura é invisível para as duas.
--
-- O MESMO DEFEITO, DE OUTRO JEITO: a embalagem do fornecedor que chega no meio
-- do dia (o balde de doce de leite) nasce como ponto de consumo efêmero, não é
-- vinculada à sessão aberta e nunca é debitada. O estoque dela sobe no sistema,
-- dia após dia, acima do real.
--
-- ── O desenho ────────────────────────────────────────────────
--
-- `quantidade_inicial` NÃO muda de significado: continua sendo a foto da
-- abertura, e o fechamento e os relatórios dependem disso. O que passou a
-- existir depois ganha coluna própria, e as duas funções passam a somar as
-- duas.
--
-- A conta de quanto foi reposto não precisa de histórico de movimentação:
--
--   reposto = (o que há no pote agora) + (o que a sessão já tirou) - (o que
--             havia na abertura)
--
-- Na abertura dá zero; depois de a sessão consumir, continua zero; depois de
-- uma recarga de R, dá exatamente R. E se uma contagem corrigir o pote para
-- baixo, a capacidade cai junto — que é o certo.
--
-- Ambas as funções partiram de `pg_get_functiondef` — ver CLAUDE.md.
-- ============================================================

ALTER TABLE sessoes_producao_locais
  ADD COLUMN IF NOT EXISTS quantidade_reposta DECIMAL NOT NULL DEFAULT 0;

COMMENT ON COLUMN sessoes_producao_locais.quantidade_reposta IS
  'O que entrou neste (recipiente, lote) DEPOIS da abertura da sessão. '
  'Somado a quantidade_inicial, é o quanto de teórico esta linha pode absorver. '
  'quantidade_inicial continua sendo a foto da abertura e não é tocada.';

-- ============================================================
-- redistribuir_teorico_sequencial — a fila passa a contar a recarga
--
-- Única mudança: todo lugar que perguntava "quanto este pote tinha na
-- abertura" passa a perguntar "quanto já passou por este pote nesta sessão".
-- ============================================================
CREATE OR REPLACE FUNCTION public.redistribuir_teorico_sequencial(p_sessao_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_insumo     RECORD;
  v_pote       RECORD;
  v_linha      RECORD;
  v_restante   DECIMAL;
  v_cota_pote  DECIMAL;
  v_cota_linha DECIMAL;
  v_acumulado  DECIMAL;
  v_potes      INTEGER;
  v_linhas     INTEGER;
  v_tocadas    INTEGER := 0;
BEGIN
  FOR v_insumo IN
    SELECT insumo_id, SUM(consumo_teorico) AS total
      FROM sessoes_producao_locais
     WHERE sessao_id = p_sessao_id
     GROUP BY insumo_id
    HAVING SUM(consumo_teorico) > 0
  LOOP
    v_restante := v_insumo.total;

    SELECT COUNT(*) INTO v_potes FROM (
      SELECT spl.local_id
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.insumo_id = v_insumo.insumo_id
       GROUP BY spl.local_id
      HAVING SUM(spl.quantidade_inicial + spl.quantidade_reposta) > 0
    ) t;

    CONTINUE WHEN v_potes = 0;

    FOR v_pote IN
      SELECT spl.local_id,
             SUM(spl.quantidade_inicial + spl.quantidade_reposta) AS no_pote
        FROM sessoes_producao_locais spl
        JOIN locais l  ON l.id  = spl.local_id
        LEFT JOIN lotes lo ON lo.id = spl.lote_id
       WHERE spl.sessao_id = p_sessao_id AND spl.insumo_id = v_insumo.insumo_id
       GROUP BY spl.local_id, l.nome
      HAVING SUM(spl.quantidade_inicial + spl.quantidade_reposta) > 0
       ORDER BY MIN(lo.validade_pos_abertura) NULLS LAST, chave_natural(l.nome)
    LOOP
      v_potes := v_potes - 1;

      -- O último da fila leva o que faltar, mesmo que passe do que tem dentro:
      -- é assim que a soma dos teóricos continua igual à necessidade real.
      IF v_potes = 0 THEN
        v_cota_pote := GREATEST(v_restante, 0);
      ELSE
        v_cota_pote := GREATEST(LEAST(v_restante, v_pote.no_pote), 0);
      END IF;

      v_restante := v_restante - v_cota_pote;

      SELECT COUNT(*) INTO v_linhas
        FROM sessoes_producao_locais
       WHERE sessao_id = p_sessao_id AND local_id = v_pote.local_id
         AND insumo_id = v_insumo.insumo_id;

      v_acumulado := 0;

      FOR v_linha IN
        SELECT spl.id,
               (spl.quantidade_inicial + spl.quantidade_reposta) AS passou
          FROM sessoes_producao_locais spl
         WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_pote.local_id
           AND spl.insumo_id = v_insumo.insumo_id
         ORDER BY (spl.quantidade_inicial + spl.quantidade_reposta) DESC, spl.id
      LOOP
        v_linhas := v_linhas - 1;

        -- Dentro do pote, proporcional; a última linha fecha o arredondamento.
        IF v_linhas = 0 THEN
          v_cota_linha := v_cota_pote - v_acumulado;
        ELSE
          v_cota_linha := ROUND(v_cota_pote * (v_linha.passou / v_pote.no_pote), 3);
        END IF;

        UPDATE sessoes_producao_locais
           SET consumo_teorico = GREATEST(v_cota_linha, 0)
         WHERE id = v_linha.id;

        v_acumulado := v_acumulado + v_cota_linha;
        v_tocadas   := v_tocadas + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_tocadas;
END;
$function$;

-- ============================================================
-- aplicar_teorico_nos_recipientes — o teto sobe junto
--
-- Única mudança: `LEAST(consumo_teorico, quantidade_inicial)` vira
-- `LEAST(consumo_teorico, quantidade_inicial + quantidade_reposta)`. É este
-- teto que travava a segunda recarga.
-- ============================================================
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

    IF v_mexeu THEN v_potes := v_potes + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'saiu',       ROUND(v_total_saiu, 3),
    'devolvido',  ROUND(v_total_voltou, 3),
    'recipientes', v_potes
  );
END;
$function$;

-- ============================================================
-- reaplicar_teorico_do_insumo — chamada depois de todo abastecimento
--
-- Só faz alguma coisa quando há sessão ABERTA com teórico pendente daquele
-- insumo. Sem pendência, sai calada: recarregar um balde fora de produção não
-- pode consumir nada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reaplicar_teorico_do_insumo(
  p_empresa_id UUID,
  p_insumo_id  UUID
) RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 -- `extensions` junto de propósito: é lá que mora o uuid-ossp no Supabase, e
 -- o search_path fixado aqui vale também para as funções chamadas por esta.
 -- Sem ele, `aplicar_teorico_nos_recipientes` quebra em `uuid_generate_v4()` —
 -- e quebrou, no primeiro teste com sessão aberta de verdade.
 SET search_path = public, extensions
AS $function$
DECLARE
  v_sessao_id  UUID;
  v_sessoes    INTEGER := 0;
  v_aplicacao  JSONB;
  v_saiu       DECIMAL := 0;
  v_pendente   DECIMAL;
  v_linha      RECORD;
  v_leva       DECIMAL;
  v_ultima     UUID;
BEGIN
  FOR v_sessao_id IN
    SELECT s.id
      FROM sessoes_producao s
      JOIN sessoes_producao_locais spl ON spl.sessao_id = s.id
     WHERE s.empresa_id = p_empresa_id
       AND s.status = 'aberta'::status_sessao_enum
       AND spl.insumo_id = p_insumo_id
     GROUP BY s.id
    HAVING SUM(spl.consumo_teorico) > SUM(spl.consumo_aplicado)
  LOOP
    -- 1. O que existe hoje no EP daquele insumo e ainda não tem linha na
    --    sessão. É o caso da embalagem do fornecedor que chegou no meio do
    --    dia: ponto de consumo que não existia na abertura.
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id,
      quantidade_inicial, quantidade_reposta, consumo_teorico, consumo_aplicado
    )
    SELECT v_sessao_id, ll.local_id, p_insumo_id, ll.lote_id, 0, ll.quantidade, 0, 0
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
      JOIN lotes  lo ON lo.id = ll.lote_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND lo.insumo_id = p_insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    -- 2. Quanto entrou depois da abertura, por linha.
    --
    --    reposto = o que há no pote agora + o que a sessão já tirou dele
    --              - o que havia na abertura
    --
    --    Sem histórico de movimentação e auto-corrigível: se uma contagem
    --    baixar o pote, a capacidade da linha cai junto.
    UPDATE sessoes_producao_locais spl
       SET quantidade_reposta = GREATEST(
             ROUND(COALESCE(ll.quantidade, 0) + spl.consumo_aplicado
                   - spl.quantidade_inicial, 3), 0)
      FROM (SELECT local_id, lote_id, quantidade FROM locais_lotes) ll
     WHERE spl.sessao_id = v_sessao_id
       AND spl.insumo_id = p_insumo_id
       AND ll.local_id = spl.local_id
       AND ll.lote_id  = spl.lote_id;

    -- 3. Enfileira SÓ O PENDENTE, sem tocar no que já foi consumido.
    --
    -- Aqui NÃO se chama `redistribuir_teorico_sequencial`: ela refaz a fila
    -- inteira a partir do total, e com isso pode transferir a dívida de um pote
    -- para outro. `aplicar_teorico_nos_recipientes` leria essa mudança como
    -- "o plano diminuiu" e DEVOLVERIA insumo ao pote de onde já tinha saído —
    -- insumo que na vida real já virou brownie. Medido num teste: 6,8 kg
    -- entraram num pote e o saldo dele terminou zerado, com a diferença
    -- "devolvida" a um pote vizinho.
    --
    -- A regra que evita isso: `consumo_teorico` de cada linha nunca desce
    -- abaixo de `consumo_aplicado`. O que já aconteceu é fato; só o pendente
    -- se redistribui.
    SELECT SUM(consumo_teorico) - SUM(consumo_aplicado) INTO v_pendente
      FROM sessoes_producao_locais
     WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id;

    IF COALESCE(v_pendente, 0) > 0 THEN
      -- Congela o que já foi consumido…
      UPDATE sessoes_producao_locais
         SET consumo_teorico = consumo_aplicado
       WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id;

      -- …e reparte o pendente pelo que existe HOJE nos potes, na mesma ordem
      -- da fila da abertura: validade primeiro, depois o número do pote.
      FOR v_linha IN
        SELECT spl.id, COALESCE(ll.quantidade, 0) AS tem
          FROM sessoes_producao_locais spl
          JOIN locais l ON l.id = spl.local_id
          LEFT JOIN lotes lo ON lo.id = spl.lote_id
          LEFT JOIN locais_lotes ll
                 ON ll.local_id = spl.local_id AND ll.lote_id = spl.lote_id
         WHERE spl.sessao_id = v_sessao_id AND spl.insumo_id = p_insumo_id
         ORDER BY lo.validade_pos_abertura NULLS LAST, chave_natural(l.nome), spl.id
      LOOP
        v_ultima := v_linha.id;
        EXIT WHEN v_pendente <= 0;

        v_leva := LEAST(v_pendente, v_linha.tem);
        CONTINUE WHEN v_leva <= 0;

        UPDATE sessoes_producao_locais
           SET consumo_teorico = consumo_teorico + v_leva
         WHERE id = v_linha.id;

        v_pendente := ROUND(v_pendente - v_leva, 3);
      END LOOP;

      -- O que não coube em pote nenhum fica pendurado na última linha, para a
      -- soma dos teóricos continuar igual à necessidade da ficha. É o mesmo
      -- princípio do "último da fila leva o resto" da abertura.
      IF v_pendente > 0 AND v_ultima IS NOT NULL THEN
        UPDATE sessoes_producao_locais
           SET consumo_teorico = consumo_teorico + v_pendente
         WHERE id = v_ultima;
      END IF;
    END IF;

    v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

    v_saiu    := v_saiu + COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0);
    v_sessoes := v_sessoes + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sessoes', v_sessoes, 'saiu', ROUND(v_saiu, 3));
END;
$function$;

COMMENT ON FUNCTION reaplicar_teorico_do_insumo(UUID, UUID) IS
  'Depois de abastecer, faz o consumo teórico pendente da sessão aberta descer '
  'do insumo que acabou de chegar. Sem isto o balde só pode ser recarregado '
  'uma vez por sessão, e a embalagem do fornecedor que chega no meio do dia '
  'nunca é debitada.';

-- Função nova nasce executável por PUBLIC, o que inclui visitante sem login
-- (migration 098).
REVOKE ALL ON FUNCTION reaplicar_teorico_do_insumo(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reaplicar_teorico_do_insumo(UUID, UUID)
  TO authenticated, service_role;

-- ============================================================
-- Os dois chamadores que não são a tela de recarga
--
-- `registrar_abastecimento` ganha a chamada na 109, junto com a reescrita dela
-- — reproduzir 290 linhas aqui só para acrescentar uma seria pedir erro.
-- ============================================================

-- realizar_transferencia_multipla — definição viva (102), com a chamada no fim.
CREATE OR REPLACE FUNCTION public.realizar_transferencia_multipla(p_lote_ids uuid[], p_local_id uuid, p_responsavel_id uuid, p_empresa_id uuid, p_justificativa text DEFAULT NULL::text, p_sobra_origem numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lote        lotes%ROWTYPE;
  v_lote_id     UUID;
  v_insumo_id   UUID;
  v_marca_id    UUID;
  v_qtd_total   DECIMAL := 0;
  v_insumo      insumos%ROWTYPE;
  v_local       locais%ROWTYPE;
  v_validade_ep DATE;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_total_atual DECIMAL;
  v_marca_conteudo UUID;
  v_espaco      DECIMAL;
  v_restante    DECIMAL;
  v_leva        DECIMAL;
  v_colocado    DECIMAL := 0;
  v_sobras      JSONB := '[]'::JSONB;
  v_ultimo_id   UUID;
  v_declarado   BOOLEAN;
  v_trava       JSONB;
  v_contexto    JSONB;
BEGIN
  IF array_length(p_lote_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhum lote fornecido.');
  END IF;

  -- ── Conferência dos lotes ─────────────────────────────────
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id AND empresa_id = p_empresa_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro', format('Lote %s não encontrado.', v_lote_id));
    END IF;
    IF v_lote.status <> 'ativo' OR v_lote.quantidade_disponivel <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Lote %s não está disponível (status: %s).', v_lote.codigo, v_lote.status));
    END IF;

    -- Mesmo insumo (substitui a exigência de mesmo recebimento)
    IF v_insumo_id IS NULL THEN
      v_insumo_id := v_lote.insumo_id;
    ELSIF v_lote.insumo_id <> v_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Todos os lotes devem ser do mesmo insumo.');
    END IF;

    IF v_lote.marca_id IS NOT NULL THEN
      IF v_marca_id IS NULL THEN
        v_marca_id := v_lote.marca_id;
      ELSIF v_lote.marca_id <> v_marca_id THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          'Os lotes são de marcas diferentes e não podem ir juntos.');
      END IF;
    END IF;

    v_qtd_total := v_qtd_total + v_lote.quantidade_disponivel;
  END LOOP;

  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_insumo_id THEN
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

  -- ── TRAVA: marca diferente ────────────────────────────────
  IF (v_marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
      AND v_marca_id <> v_local.marca_id)
     OR (v_marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
         AND v_marca_id <> v_marca_conteudo) THEN
    v_trava := avaliar_trava(p_empresa_id, 'marca_diferente', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'marca_diferente',
        'mensagem', 'Este recipiente é de outra marca. Misturar marcas compromete a rastreabilidade.');
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'marca_diferente',
                              v_contexto, p_justificativa);
  END IF;

  -- ── TRAVA: fefo (rede de segurança) ───────────────────────
  -- validar_scan_lote já barra isso na leitura do QR e registra a exceção
  -- quando o operador justifica. Aqui é só para quem chegar por fora da tela;
  -- por isso não registra de novo — só recusa.
  IF EXISTS (
    SELECT 1 FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.insumo_id  = v_insumo_id
       AND l.status     = 'ativo'
       AND l.quantidade_disponivel > 0
       AND l.quantidade_disponivel < l.quantidade_recebida
       AND NOT (l.id = ANY(p_lote_ids))
  ) THEN
    v_trava := avaliar_trava(p_empresa_id, 'fefo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'fefo',
        'mensagem', 'Há um lote aberto deste insumo no estoque que não foi escaneado. '
                    'Ele precisa sair antes das embalagens fechadas.');
    END IF;
  END IF;

  -- ── Quanto realmente saiu da origem ───────────────────────
  --
  -- Antes quem decidia era a CAPACIDADE do pote: enchia até o número do
  -- cadastro e descontava isso do lote. Nenhuma balança entrava na conta, e o
  -- erro de cada passagem virava divida no saldo do lote — até o dia em que
  -- sobrava mais no fardo do que o sistema achava, e a transferencia travava.
  --
  -- Agora quem decide é o operador, declarando O QUE SOBROU NA ORIGEM: quantos
  -- pacotes ficaram no fardo, ou quanto o saco esta pesando. Sobra se enxerga;
  -- o que saiu se estima. E como o saldo do lote passa a ser reancorado a cada
  -- passagem, o erro nunca acumula.
  --
  -- A capacidade vira aviso, como na abertura de estoque: ela é estimativa
  -- nossa, e o que coube no pote é fato.
  v_declarado := p_sobra_origem IS NOT NULL;

  IF v_declarado THEN
    v_ultimo_id := p_lote_ids[array_length(p_lote_ids, 1)];

    IF p_sobra_origem < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'A sobra não pode ser negativa.');
    END IF;

    SELECT * INTO v_lote FROM lotes WHERE id = v_ultimo_id;

    IF p_sobra_origem > v_lote.quantidade_disponivel THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Sobrou mais do que havia: o lote %s tinha %s %s.',
               v_lote.codigo, ROUND(v_lote.quantidade_disponivel, 3), v_lote.unidade));
    END IF;

    v_restante := v_qtd_total - p_sobra_origem;
  ELSE
    v_restante := v_qtd_total;
  END IF;

  IF v_restante <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Nada saiu da origem: a sobra declarada é tudo o que havia.');
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_insumo_id;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
          p_responsavel_id, p_justificativa)
  RETURNING id INTO v_mov_id;

  -- ── Execução, na ordem em que os QR foram lidos ───────────
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id;

    v_leva := LEAST(v_lote.quantidade_disponivel, v_restante);

    IF v_leva <= 0 THEN
      -- Não coube nada deste lote: fica inteiro no estoque central.
      v_sobras := v_sobras || jsonb_build_object(
        'codigo', v_lote.codigo,
        'quantidade', ROUND(v_lote.quantidade_disponivel, 3));
      CONTINUE;
    END IF;

    v_validade_ep := CASE
      WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
      THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
      ELSE v_lote.validade_original
    END;

    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, p_local_id, v_leva, v_lote.unidade);

    PERFORM abastecer_recipiente(p_local_id, v_lote_id, v_leva, v_lote.unidade, v_validade_ep);

    UPDATE lotes
       SET quantidade_disponivel = quantidade_disponivel - v_leva,
           status = CASE
             WHEN quantidade_disponivel - v_leva <= 0 THEN 'esgotado'::status_lote_enum
             ELSE status
           END
     WHERE id = v_lote_id;

    IF v_lote.quantidade_disponivel - v_leva > 0 THEN
      v_sobras := v_sobras || jsonb_build_object(
        'codigo', v_lote.codigo,
        'quantidade', ROUND(v_lote.quantidade_disponivel - v_leva, 3));
    END IF;

    v_colocado := v_colocado + v_leva;
    v_restante := v_restante - v_leva;
  END LOOP;

  -- O teórico pendente da sessão aberta desce do que acabou de chegar.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, v_insumo_id);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id',   v_mov_id,
    'codigo',            v_mov_codigo,
    'quantidade_total',  ROUND(v_colocado, 3),
    'escaneado_total',   ROUND(v_qtd_total, 3),
    'volta_ao_estoque',  ROUND(v_qtd_total - v_colocado, 3),
    'sobras',            v_sobras,
    'recipiente_cheio',  v_local.capacidade_max IS NOT NULL
                         AND (v_total_atual + v_colocado) >= v_local.capacidade_max,
    'passou_da_capacidade', v_local.capacidade_max IS NOT NULL
                         AND (v_total_atual + v_colocado) > v_local.capacidade_max,
    'misturou',          v_total_atual > 0
  );
END;
$function$;

-- mover_embalagem_fornecedor — definição viva (073), com a chamada no fim.
CREATE OR REPLACE FUNCTION public.mover_embalagem_fornecedor(p_lote_id uuid, p_responsavel_id uuid, p_empresa_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lote      lotes%ROWTYPE;
  v_insumo    insumos%ROWTYPE;
  v_modo      modo_ep_enum;
  v_subtipo   TEXT;
  v_local_id  UUID;
  v_nome      TEXT;
  v_resultado JSONB;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF COALESCE(v_lote.quantidade_disponivel, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não tem saldo para mover.', v_lote.codigo));
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  SELECT c.modo_ep INTO v_modo
    FROM insumos_armazenamento_config c
   WHERE c.insumo_id = v_lote.insumo_id;

  IF v_modo IS NULL OR v_modo NOT IN ('embalagem_fornecedor', 'escolher') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s não é armazenado na embalagem do fornecedor. Escaneie o recipiente de destino.', v_insumo.nome));
  END IF;

  SELECT id INTO v_local_id
    FROM locais
   WHERE origem_lote_id = p_lote_id AND ativo
   LIMIT 1;

  IF v_local_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'local_id', v_local_id, 'ja_existia', true);
  END IF;

  v_subtipo := v_insumo.recipiente_subtipo;
  IF v_subtipo IS NULL OR v_subtipo NOT IN (
    'prateleira','balde','balde_fornecedor','caixa_plastica',
    'garrafa','garrafa_fornecedor','saco_confeitar','lata'
  ) THEN
    v_subtipo := 'balde_fornecedor';
  END IF;

  v_nome := v_insumo.nome || ' · ' || v_lote.codigo;

  INSERT INTO locais (
    empresa_id, nome, tipo, subtipo, insumo_id, marca_id,
    capacidade_max, unidade_capacidade, qr_code_fixo,
    origem_lote_id, efemero, ativo, observacoes
  ) VALUES (
    p_empresa_id, v_nome, 'estoque_produtivo', v_subtipo::subtipo_local_enum,
    v_lote.insumo_id, v_lote.marca_id,
    v_lote.quantidade_disponivel, v_lote.unidade,
    'QR-LOTE-' || v_lote.codigo,
    p_lote_id, true, true,
    'Embalagem do fornecedor — criada pela transferência do lote ' || v_lote.codigo
  ) RETURNING id INTO v_local_id;

  v_resultado := realizar_transferencia(
    p_lote_id, v_local_id, v_lote.quantidade_disponivel,
    p_responsavel_id, p_empresa_id
  );

  IF NOT (v_resultado->>'ok')::BOOLEAN THEN
    DELETE FROM locais WHERE id = v_local_id;
    RETURN v_resultado;
  END IF;

  -- É esta chamada que resolve a embalagem do fornecedor que chega no meio
  -- do dia: sem ela o balde novo entra cheio e nunca é debitado.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, v_lote.insumo_id);

  RETURN v_resultado
    || jsonb_build_object('local_id', v_local_id, 'local_nome', v_nome,
                          'quantidade', v_lote.quantidade_disponivel);
END;
$function$
;

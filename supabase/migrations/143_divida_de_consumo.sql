-- ============================================================
-- Migration 143 — o que faltou nos baldes vira dívida, não sai do central
--
-- Até aqui (137), no fechamento, o consumo que não achou insumo nos baldes
-- saía do estoque central, e o sistema escolhia o lote. Na semana de
-- 13/10/2026 a equipe abasteceu sem registrar a transferência, e o fechamento
-- deu como usados sacos que estavam na prateleira (acerto de 18/10/2026).
--
-- Regra nova (Lucca, 18/10/2026): o central só muda por transferência,
-- entrada ou contagem. O que faltou fica em consumo_pendente da sessão
-- fechada e sai dos BALDES quando o insumo entrar neles:
--   · transferência / embalagem do fornecedor / abastecimento por unidade:
--     desconta dos potes (quitar_divida_consumo, modo 'descontar');
--   · abastecimento pesado: a balança já mostra o que saiu, a dívida é quitada
--     sem tirar nada (modo 'pesagem');
--   · "Não foi usado" sozinho: não mexe.
-- Sessão cancelada apaga a dívida dela.
--
-- Efeito aceito: o saco despejado sem registro continua no central até a
-- próxima contagem.
-- ============================================================

CREATE OR REPLACE FUNCTION public.quitar_divida_consumo(p_empresa_id uuid, p_insumo_id uuid, p_modo text DEFAULT 'descontar'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
-- A dívida das sessões fechadas sai dos baldes quando o insumo entra neles.
--   'descontar' : transferência sem pesagem. Tira dos potes do estoque produtivo,
--                 na ordem dos potes, com movimento ligado à sessão devedora.
--   'pesagem'   : o pote foi pesado. A balança já mostra o que saiu: quita sem
--                 tirar nada.
--   'nao'       : não mexe (o "Não foi usado" sozinho).
DECLARE
  v_d        RECORD;
  v_p        RECORD;
  v_resta    DECIMAL;
  v_move     DECIMAL;
  v_mov      UUID;
  v_saiu     DECIMAL := 0;
  v_quitadas INTEGER := 0;
BEGIN
  IF p_modo = 'nao' THEN
    RETURN jsonb_build_object('saiu', 0, 'quitadas', 0);
  END IF;

  FOR v_d IN
    SELECT cp.id, cp.quantidade, cp.unidade, s.id AS sessao_id, s.codigo,
           COALESCE(s.fechada_por, s.aberta_por) AS resp
      FROM consumo_pendente cp
      JOIN sessoes_producao s ON s.id = cp.sessao_id
     WHERE cp.empresa_id = p_empresa_id AND cp.insumo_id = p_insumo_id
       AND cp.status = 'aberto' AND s.status = 'fechada'::status_sessao_enum
     ORDER BY s.data_producao, cp.criado_em
  LOOP
    IF p_modo = 'pesagem' THEN
      UPDATE consumo_pendente SET status = 'quitado', resolvido_em = NOW() WHERE id = v_d.id;
      v_quitadas := v_quitadas + 1;
      CONTINUE;
    END IF;

    v_resta := v_d.quantidade;
    v_mov   := NULL;

    FOR v_p IN
      SELECT ll.local_id, ll.lote_id, ll.quantidade AS tem
        FROM locais_lotes ll
        JOIN locais l  ON l.id = ll.local_id
        JOIN lotes  lo ON lo.id = ll.lote_id
       WHERE l.empresa_id = p_empresa_id
         AND l.tipo = 'estoque_produtivo'
         AND lo.insumo_id = p_insumo_id
         AND ll.quantidade > 0
       ORDER BY numero_do_pote(l.nome) NULLS LAST, chave_natural(l.nome),
                lo.validade_original, lo.codigo
    LOOP
      EXIT WHEN v_resta <= 0.0005;
      v_move := ROUND(LEAST(v_resta, v_p.tem), 3);
      CONTINUE WHEN v_move <= 0;

      UPDATE locais_lotes
         SET quantidade = quantidade - v_move, updated_at = NOW()
       WHERE local_id = v_p.local_id AND lote_id = v_p.lote_id;

      IF v_mov IS NULL THEN
        INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                   sessao_producao_id, observacoes)
        VALUES (uuid_generate_v4(), p_empresa_id,
                gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV'),
                'consumo_producao', v_d.resp, v_d.sessao_id,
                format('Dívida da %s: o que faltou nos baldes no fechamento, descontado quando o insumo chegou (migration 143).',
                       v_d.codigo))
        RETURNING id INTO v_mov;
      END IF;

      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
      VALUES (v_mov, v_p.lote_id, v_p.local_id, v_move, v_d.unidade);

      -- Deduzido, não pesado: o mesmo aviso de aplicar_teorico_nos_recipientes.
      UPDATE locais SET conteudo_estimado = TRUE WHERE id = v_p.local_id;

      v_resta := ROUND(v_resta - v_move, 3);
      v_saiu  := v_saiu + v_move;
    END LOOP;

    IF v_resta <= 0.005 THEN
      UPDATE consumo_pendente SET status = 'quitado', resolvido_em = NOW() WHERE id = v_d.id;
      v_quitadas := v_quitadas + 1;
    ELSE
      UPDATE consumo_pendente SET quantidade = v_resta WHERE id = v_d.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('saiu', ROUND(v_saiu, 3), 'quitadas', v_quitadas);
END;
$function$;
REVOKE ALL ON FUNCTION quitar_divida_consumo(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION quitar_divida_consumo(uuid, uuid, text) TO authenticated, service_role;

-- Ganha o terceiro parâmetro. Sem o DROP ficariam duas versões, e a chamada
-- de dois argumentos seria ambígua.
DROP FUNCTION IF EXISTS public.reaplicar_teorico_do_insumo(uuid, uuid);
CREATE OR REPLACE FUNCTION public.reaplicar_teorico_do_insumo(p_empresa_id uuid, p_insumo_id uuid, p_divida text DEFAULT 'descontar'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
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
  v_divida     DECIMAL;
  v_quitar     JSONB;
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
    UNION
    -- …e a sessão que abriu sem o insumo na produção (137).
    SELECT cp.sessao_id
      FROM consumo_pendente cp
      JOIN sessoes_producao s ON s.id = cp.sessao_id
     WHERE cp.empresa_id = p_empresa_id AND cp.insumo_id = p_insumo_id
       AND cp.status = 'aberto' AND s.status = 'aberta'::status_sessao_enum
  LOOP
    v_ultima := NULL;
    SELECT COALESCE(SUM(quantidade), 0) INTO v_divida
      FROM consumo_pendente
     WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id AND status = 'aberto';

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
    SELECT COALESCE(SUM(consumo_teorico) - SUM(consumo_aplicado), 0) + v_divida INTO v_pendente
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
         ORDER BY numero_do_pote(l.nome) NULLS LAST, chave_natural(l.nome), spl.id
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

    -- A dívida virou fila de pote: daqui em diante é linha comum da sessão.
    -- Sem pote nenhum (v_ultima nulo), ela continua pendente.
    IF v_divida > 0 AND v_ultima IS NOT NULL THEN
      UPDATE consumo_pendente
         SET status = 'quitado', resolvido_em = NOW()
       WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id AND status = 'aberto';
    END IF;

    v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

    v_saiu    := v_saiu + COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0);
    v_sessoes := v_sessoes + 1;
  END LOOP;

  -- A dívida das sessões JÁ FECHADAS (143): o insumo acabou de entrar nos
  -- baldes, e é dele que sai o que faltou no fechamento. Vem depois das sessões
  -- abertas, que consomem agora.
  v_quitar := quitar_divida_consumo(p_empresa_id, p_insumo_id, p_divida);

  RETURN jsonb_build_object('ok', true, 'sessoes', v_sessoes, 'saiu', ROUND(v_saiu, 3),
                            'divida', v_quitar);
END;
$function$;
REVOKE ALL ON FUNCTION reaplicar_teorico_do_insumo(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reaplicar_teorico_do_insumo(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fechar_sessao_producao(p_sessao_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_skus jsonb, p_observacoes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao               sessoes_producao%ROWTYPE;
  v_sku                  JSONB;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_produto        DECIMAL(8,4) := 0;
  v_ficha_id             UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
  v_potes                INTEGER := 0;
  -- Acumuladores da perda do dia, somando TODOS os produtos da sessão
  v_num_peso             DECIMAL := 0;
  v_den_peso             DECIMAL := 0;
  v_num_un               DECIMAL := 0;
  v_den_un               DECIMAL := 0;
  v_todos_com_peso       BOOLEAN := TRUE;
  v_lotes                JSONB   := '[]'::JSONB;
  v_primeiro_tipo        TEXT;
  -- Consumo que não passou pela produção (137): vira dívida (143)
  v_ec                   RECORD;
  v_avisos_ec            TEXT[] := '{}';
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  -- ══════════════════════════════════════════════════════════
  -- CADA PRODUTO RESPONDE POR SI
  --
  -- O planejado era lido UMA VEZ, com LIMIT 1, e servia para todos os produtos
  -- do dia. Num dia de um produto só ninguém percebe; num dia misto, o segundo
  -- produto recebia as unidades do primeiro.
  --
  -- Aconteceu na SESS-0028, de 27/08/2026: 28 formas de Tradicional e 12 de
  -- Doce de Leite, e o Doce de Leite saiu gravado com 1.680 unidades — que são
  -- as 28 formas do Tradicional. As 12 formas dão 720.
  --
  -- Era a PRIMEIRA sessão de dois produtos fechada pela tela; as anteriores
  -- entraram pela importação do histórico e não passaram por aqui.
  -- ══════════════════════════════════════════════════════════
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_ficha_id            := (v_sku->>'ficha_id')::UUID;
    v_qtd_perdida_proc    := COALESCE((v_sku->>'quantidade_perdida')::INTEGER, 0);
    v_qtd_descartada_gram := COALESCE((v_sku->>'quantidade_descartada_gramatura')::INTEGER, 0);
    v_peso_descartado_g   := COALESCE((v_sku->>'peso_descartado_gramatura_g')::DECIMAL, 0);

    -- O planejado e o peso médio DESTE produto, não os do primeiro da lista.
    SELECT sps.quantidade_planejada, ftv.peso_medio_g
      INTO v_qtd_planejada, v_peso_medio_g
      FROM sessoes_producao_skus sps
      JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
     WHERE sps.sessao_id = p_sessao_id AND sps.ficha_tecnica_id = v_ficha_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Um dos produtos informados não está nesta sessão.');
    END IF;

    v_qtd_produzida := GREATEST(
      COALESCE(v_qtd_planejada, 0) - v_qtd_perdida_proc - v_qtd_descartada_gram, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_produzida            = v_qtd_produzida,
           quantidade_perdida              = v_qtd_perdida_proc,
           quantidade_descartada_gramatura = v_qtd_descartada_gram,
           peso_descartado_gramatura_g     = NULLIF(v_peso_descartado_g, 0)
     WHERE sessao_id = p_sessao_id
       AND ficha_tecnica_id = v_ficha_id;

    -- A perda do dia soma a de todos os produtos. Antes o percentual saía do
    -- perdido do ÚLTIMO produto sobre o planejado do PRIMEIRO.
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      v_num_peso := v_num_peso
        + v_qtd_perdida_proc::DECIMAL * v_peso_medio_g + v_peso_descartado_g;
      v_den_peso := v_den_peso + COALESCE(v_qtd_planejada, 0)::DECIMAL * v_peso_medio_g;
    ELSE
      v_todos_com_peso := FALSE;
    END IF;
    v_num_un := v_num_un + v_qtd_perdida_proc + v_qtd_descartada_gram;
    v_den_un := v_den_un + COALESCE(v_qtd_planejada, 0);

    -- ── Lote resultante, POR PRODUTO ──────────────────────
    -- PRODUTO não vira lote aqui: o brownie ainda está na forma, e é a
    -- pós-produção que sabe quantos saíram inteiros (089). Sub-receita entra
    -- agora — ela não é desenformada. Antes só o primeiro produto da lista
    -- podia gerar lote; um dia com duas sub-receitas perdia a segunda.
    SELECT tipo, insumo_resultado_id INTO v_tipo_ficha, v_insumo_resultado_id
      FROM fichas_tecnicas WHERE id = v_ficha_id;
    v_primeiro_tipo := COALESCE(v_primeiro_tipo, v_tipo_ficha);

    IF v_qtd_produzida > 0 AND v_tipo_ficha = 'insumo'
       AND v_insumo_resultado_id IS NOT NULL THEN
      v_lote_result := registrar_lote_insumo_producao(
        p_empresa_id, v_insumo_resultado_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
      v_lotes := v_lotes || jsonb_build_array(v_lote_result);
    END IF;
  END LOOP;

  -- ── Recipientes: o estoque JÁ SAIU na abertura (085) ──────
  -- A chamada abaixo é rede de segurança, não a regra: numa sessão normal ela
  -- encontra tudo aplicado e não mexe em nada. Existe para as sessões que
  -- estavam abertas antes da 085, e para o caso de o teórico ter mudado sem
  -- passar por atualizar_plano_sessao.
  PERFORM aplicar_teorico_nos_recipientes(p_sessao_id);

  -- ── O que a produção não teve: vira DÍVIDA dos baldes (143) ──
  -- Até a 143 isto saía do estoque central, com o sistema escolhendo o lote
  -- (aberto primeiro, depois o que vence antes). Na semana de 13/10/2026 a
  -- equipe abasteceu os baldes sem registrar a transferência, e o fechamento
  -- deu como usados sacos que continuavam na prateleira: farinha 0012.1/5,
  -- choco 0003.5/6, ovo 0007.1/2, baunilha 0002.2/15. De qual saco saiu,
  -- ninguém sabe; o sistema chutava.
  --
  -- Regra do Lucca (18/10/2026): o central só muda por transferência, entrada
  -- ou contagem. O que faltou fica pendurado na sessão e sai dos BALDES quando
  -- o insumo entrar neles (quitar_divida_consumo, chamada pelo reaplicar).
  FOR v_ec IN
    SELECT x.insumo_id, i.nome, i.unidade_medida AS unidade, ROUND(SUM(x.q), 3) AS q
      FROM (
        SELECT insumo_id, quantidade AS q
          FROM consumo_pendente
         WHERE sessao_id = p_sessao_id AND status = 'aberto'
        UNION ALL
        SELECT insumo_id, SUM(consumo_teorico - consumo_aplicado)
          FROM sessoes_producao_locais
         WHERE sessao_id = p_sessao_id
         GROUP BY insumo_id
      ) x
      JOIN insumos i ON i.id = x.insumo_id
     GROUP BY x.insumo_id, i.nome, i.unidade_medida
    HAVING SUM(x.q) > 0.005
  LOOP
    INSERT INTO consumo_pendente (empresa_id, sessao_id, insumo_id, quantidade, unidade)
    VALUES (p_empresa_id, p_sessao_id, v_ec.insumo_id, v_ec.q, v_ec.unidade)
    ON CONFLICT (sessao_id, insumo_id) WHERE status = 'aberto'
    DO UPDATE SET quantidade = EXCLUDED.quantidade;

    v_avisos_ec := v_avisos_ec || format(
      'Ficou devendo %s %s de %s: sai dos baldes na próxima transferência.',
      replace(to_char(v_ec.q, 'FM999990.000'), '.', ','), v_ec.unidade::TEXT, v_ec.nome);
  END LOOP;

  SELECT COUNT(DISTINCT local_id) INTO v_potes
    FROM sessoes_producao_locais
   WHERE sessao_id = p_sessao_id AND consumo_aplicado > 0;

  -- Liquida as linhas com o que de fato saiu. Um único UPDATE cobre os potes
  -- usados e os intocados: nestes consumo_aplicado é zero, e a linha fecha com
  -- o que tinha em vez de ficar com quantidade_final nula.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial - consumo_aplicado,
         consumo_real     = consumo_aplicado,
         desvio           = 0
   WHERE sessao_id = p_sessao_id;

  -- ── Perda de produto: o dia inteiro, não o último produto ─
  -- Por peso quando TODOS os produtos têm peso médio cadastrado; senão por
  -- unidade, que é comparável entre si. Misturar grama com unidade no mesmo
  -- percentual daria um número que não quer dizer nada.
  IF v_todos_com_peso AND v_den_peso > 0 THEN
    v_fator_produto := (v_num_peso / v_den_peso) * 100;
  ELSIF v_den_un > 0 THEN
    v_fator_produto := (v_num_un / v_den_un) * 100;
  END IF;

  UPDATE sessoes_producao
     SET status                 = 'fechada',
         fechada_por            = p_responsavel_id,
         data_fechamento        = NOW(),
         observacoes_fechamento = p_observacoes,
         -- NULL, não zero: a perda de insumo não é mais medida aqui.
         fator_perda_insumos    = NULL,
         fator_perda_produto    = v_fator_produto
   WHERE id = p_sessao_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'recipientes_baixados', v_potes,
    'fator_perda_produto', v_fator_produto,
    -- `lote_resultado` fica no singular por compatibilidade: é o último criado.
    -- `lotes_resultado` traz todos, que é o que passa a existir num dia com
    -- mais de uma sub-receita.
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'lotes_resultado', v_lotes,
    'tipo_ficha', COALESCE(v_primeiro_tipo, 'produto'),
    'avisos', to_jsonb(v_avisos_ec)
  );
END;
$function$;

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
  --
  -- Dívida de sessão fechada (143): o pote acabou de ser PESADO, e a pesagem já
  -- mostra o que a produção tirou dele sem registro. Descontar a dívida de novo
  -- deixaria o pote abaixo do que a balança disse: a pesagem quita. O "Não foi
  -- usado" sozinho (sem lote) não mexe na dívida: o pote devolvido não é o que
  -- ficou devendo.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id,
                                      CASE WHEN v_so_decl THEN 'nao' ELSE 'pesagem' END);

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

CREATE OR REPLACE FUNCTION public.cancelar_sessao_producao(p_sessao_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao    sessoes_producao%ROWTYPE;
  v_aplicacao JSONB;
  v_insumos   TEXT;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;

  IF v_sessao.status <> 'aberta' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Esta sessão está %s. Só dá para cancelar uma sessão aberta.', v_sessao.status));
  END IF;

  IF COALESCE(length(trim(p_motivo)), 0) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Escreva o motivo do cancelamento — ele é o que explica a devolução depois.');
  END IF;

  -- Quais insumos voltam, para a tela poder dizer o que aconteceu.
  SELECT string_agg(DISTINCT i.nome, ', ')
    INTO v_insumos
    FROM sessoes_producao_locais spl
    JOIN insumos i ON i.id = spl.insumo_id
   WHERE spl.sessao_id = p_sessao_id AND spl.consumo_aplicado > 0;

  -- Zerar o alvo e reconciliar devolve tudo: é o mesmo caminho de quando o
  -- plano diminui (085), sem uma segunda implementação para manter em pé.
  UPDATE sessoes_producao_locais
     SET consumo_teorico = 0
   WHERE sessao_id = p_sessao_id;

  v_aplicacao := aplicar_teorico_nos_recipientes(p_sessao_id);

  -- A sessão fecha com as linhas dizendo que nada foi consumido, que é a
  -- verdade depois da devolução.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial,
         consumo_real     = 0,
         desvio           = 0
   WHERE sessao_id = p_sessao_id;

  -- Sessão cancelada não consumiu nada: não deixa dívida para os baldes (143).
  DELETE FROM consumo_pendente WHERE sessao_id = p_sessao_id AND status = 'aberto';

  UPDATE sessoes_producao
     SET status              = 'cancelada',
         cancelada_por       = p_responsavel_id,
         data_cancelamento   = NOW(),
         motivo_cancelamento = trim(p_motivo)
   WHERE id = p_sessao_id;

  RETURN jsonb_build_object(
    'ok', true,
    'codigo', v_sessao.codigo,
    'devolvido',   COALESCE((v_aplicacao->>'devolvido')::DECIMAL, 0),
    'recipientes', COALESCE((v_aplicacao->>'recipientes')::INTEGER, 0),
    'insumos', COALESCE(v_insumos, '')
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Migration 136 — o consumo previsto sai dos potes pela ordem do NÚMERO
--
-- A abertura da sessão desconta o previsto dos potes numa fila. A fila era
-- "validade primeiro, depois o número do pote" — e ninguém na fábrica olha a
-- validade do conteúdo para escolher o balde. Resultado: o sistema descontava
-- de um pote e a equipe usava outro. Em 30/09/2026 isso zerou no sistema o
-- Açúcar #3, a Farinha #1, o Açúcar Invertido #5 e #7 e o Choco #3, todos
-- cheios na balança, e virou "sumiço" nos potes realmente usados.
--
-- Agora a fila é só o número: #1, #2, #3... (Lucca, 30/09/2026). A regra da
-- fábrica passa a ser a mesma do sistema: usa-se o pote de menor número
-- primeiro. Quando não for assim, o fechamento da sessão tem o bipe dos potes
-- que não foram usados.
--
-- O número vem do nome ("Pote G Açúcar #3" → 3). Os potes de um insumo têm
-- número único mesmo com tamanhos diferentes (Açúcar Invertido: PP #1–#4,
-- P #5–#7). Pote sem número vai para o fim.
-- ============================================================

CREATE OR REPLACE FUNCTION public.numero_do_pote(p_nome TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (substring(p_nome FROM '#\s*(\d+)'))::INTEGER
$$;

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
       ORDER BY numero_do_pote(l.nome) NULLS LAST, chave_natural(l.nome)
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

CREATE OR REPLACE FUNCTION public.reaplicar_teorico_do_insumo(p_empresa_id uuid, p_insumo_id uuid)
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

    v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

    v_saiu    := v_saiu + COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0);
    v_sessoes := v_sessoes + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sessoes', v_sessoes, 'saiu', ROUND(v_saiu, 3));
END;
$function$;

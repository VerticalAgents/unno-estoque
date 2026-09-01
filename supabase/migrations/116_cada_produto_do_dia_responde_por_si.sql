-- ============================================================
-- Migration 116 — num dia de dois produtos, cada um responde por si
--
-- O DEFEITO. `fechar_sessao_producao` lia o planejado UMA VEZ, com `LIMIT 1`:
--
--     SELECT ftv.peso_medio_g, sps.quantidade_planejada, sps.ficha_tecnica_id
--       INTO v_peso_medio_g, v_qtd_planejada, v_ficha_id
--       FROM sessoes_producao_skus sps ... LIMIT 1;
--
-- e usava esse mesmo número para TODOS os produtos do dia. Num dia de um
-- produto só, ninguém percebe. Num dia misto, o segundo produto era gravado
-- com as unidades do primeiro.
--
-- COMO APARECEU. O Lucca comparou o relatório de agosto do MischaOS com o
-- nosso, dia a dia. Dezesseis dias bateram exatamente; um não:
--
--     27/08, Doce de Leite — MischaOS 16 formas, MischaFlex 12
--
-- A produção confirmou: foram 12. Só que a linha do Doce de Leite tinha
-- **1.680 unidades** gravadas, e 12 formas dão 720. As 1.680 são 28 formas —
-- exatamente o Tradicional da mesma sessão.
--
-- A SESS-0028 foi a PRIMEIRA sessão de dois produtos fechada pela tela. As
-- outras três (05/08, 13/08, 18/08) entraram pela importação do histórico e
-- nunca passaram por esta função — por isso o defeito ficou escondido.
--
-- ------ Os três estragos do mesmo LIMIT 1 -------------------
--
-- 1. `quantidade_produzida` do segundo produto vinha do planejado do primeiro.
--    É o de 27/08.
--
-- 2. `fator_perda_produto` cruzava o perdido do ÚLTIMO produto com o planejado
--    do PRIMEIRO — um percentual entre duas coisas diferentes. Agora soma o
--    dia inteiro, por peso quando todos os produtos têm peso médio, por
--    unidade quando algum não tem. Misturar grama com unidade no mesmo
--    percentual daria um número sem significado.
--
-- 3. O lote de sub-receita só podia nascer do primeiro produto da lista. Um
--    dia com duas sub-receitas perdia a segunda em silêncio. Não chegou a
--    acontecer — os dois brownies Odara são `tipo = 'produto'` e não geram
--    lote aqui (089) — mas o buraco existia.
--
-- A SESS-0028 não é consertada por esta migration: o dado errado é corrigido
-- à parte, com o número que a produção confirmou.
--
-- Partiu de pg_get_functiondef — ver CLAUDE.md.
-- ============================================================

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
    'tipo_ficha', COALESCE(v_primeiro_tipo, 'produto')
  );
END;
$function$
;

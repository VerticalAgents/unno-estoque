-- ============================================================
-- Migration 101 — refazer a abertura de um insumo
--
-- A abertura de estoque acontece em várias idas: conta-se o açúcar hoje, a
-- farinha amanhã. Até aqui, voltar à tela e digitar de novo **somava** ao que
-- já existia, e a única defesa era um aviso na tela — que depende de alguém
-- ler. Contar o mesmo saco duas vezes dobrava o estoque em silêncio.
--
-- A tela passa a travar o insumo já lançado. Para mexer nele, o operador pede
-- para refazer, e é esta função que apaga a abertura anterior daquele insumo
-- para a nova entrar no lugar.
--
-- ── A regra que delimita o que pode ser refeito ──────────────
--
-- Só enquanto o lote NÃO SE MEXEU. Depois que o açúcar foi transferido, contado
-- ou consumido numa produção, apagar a abertura quebraria a rastreabilidade: o
-- consumo apontaria para um lote que deixou de existir.
--
-- Daí em diante, a ferramenta certa é a Contagem, que ajusta saldo sem apagar
-- história. É por isso que esta função **recusa** em vez de apagar assim mesmo.
--
-- Conteúdo que a própria abertura depositou nos baldes não conta como
-- movimento — foi ela que pôs lá, e é ela que está sendo desfeita.
-- ============================================================

CREATE OR REPLACE FUNCTION refazer_abertura_do_insumo(
  p_empresa_id UUID,
  p_insumo_id  UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_insumo    RECORD;
  v_presos    TEXT[] := '{}';
  v_lote      RECORD;
  v_lotes     INTEGER := 0;
  v_baldes    INTEGER := 0;
  v_total     NUMERIC := 0;
BEGIN
  SELECT * INTO v_insumo FROM insumos
   WHERE id = p_insumo_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  -- ── 1. Achar o que não pode ser desfeito ──────────────────
  -- Falar o nome do lote importa: "não dá" sem dizer qual deixa o operador
  -- sem próximo passo.
  FOR v_lote IN
    SELECT l.id, l.codigo,
           EXISTS (SELECT 1 FROM movimentacoes_itens mi
                     JOIN movimentacoes m ON m.id = mi.movimentacao_id
                    WHERE mi.lote_id = l.id AND m.tipo <> 'entrada')  AS moveu,
           EXISTS (SELECT 1 FROM sessoes_producao_locais spl
                    WHERE spl.lote_id = l.id)                          AS produziu,
           EXISTS (SELECT 1 FROM contagem_ec_lotes c
                    WHERE c.lote_id = l.id)                            AS contou
      FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.insumo_id  = p_insumo_id
       AND l.origem     = 'inventario_inicial'
  LOOP
    IF v_lote.moveu OR v_lote.produziu OR v_lote.contou THEN
      v_presos := v_presos || format('%s (%s)', v_lote.codigo,
        CASE WHEN v_lote.produziu THEN 'usado em produção'
             WHEN v_lote.contou   THEN 'já entrou numa contagem'
             ELSE 'já foi transferido' END);
    END IF;
  END LOOP;

  IF array_length(v_presos, 1) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'erro', format(
        'A abertura de %s não pode ser refeita: %s. '
        || 'Use a Contagem para ajustar o saldo — ela corrige sem apagar o histórico.',
        v_insumo.nome, array_to_string(v_presos, ', ')));
  END IF;

  -- ── 2. Apagar, de dentro para fora ────────────────────────
  -- O conteúdo dos baldes primeiro: o gatilho `recalcular_estado_local`
  -- reescreve `locais_estado_atual` sozinho a cada linha removida.
  WITH alvo AS (
    SELECT id FROM lotes
     WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
       AND origem = 'inventario_inicial'
  ), apagados AS (
    DELETE FROM locais_lotes WHERE lote_id IN (SELECT id FROM alvo)
    RETURNING quantidade
  )
  SELECT COUNT(*), COALESCE(SUM(quantidade), 0) INTO v_baldes, v_total FROM apagados;

  DELETE FROM movimentacoes_itens
   WHERE lote_id IN (SELECT id FROM lotes
                      WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
                        AND origem = 'inventario_inicial');

  -- A movimentação de entrada pode ter coberto vários lotes de uma vez. Some
  -- só quando ficou sem nenhum item — senão levaria a entrada de outro insumo.
  DELETE FROM movimentacoes m
   WHERE m.empresa_id = p_empresa_id
     AND m.tipo = 'entrada'
     AND NOT EXISTS (SELECT 1 FROM movimentacoes_itens mi WHERE mi.movimentacao_id = m.id);

  WITH removidos AS (
    DELETE FROM lotes
     WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
       AND origem = 'inventario_inicial'
    RETURNING quantidade_recebida
  )
  SELECT COUNT(*), v_total + COALESCE(SUM(quantidade_recebida), 0)
    INTO v_lotes, v_total FROM removidos;

  RETURN jsonb_build_object(
    'ok', true,
    'insumo', v_insumo.nome,
    'lotes_removidos', v_lotes,
    'baldes_esvaziados', v_baldes,
    'quantidade_removida', v_total);
END;
$$;

COMMENT ON FUNCTION refazer_abertura_do_insumo IS
  'Apaga a abertura de estoque de um insumo para que ela seja lançada de novo. '
  'Só age sobre lotes de origem inventario_inicial que ainda não se mexeram; '
  'recusa quando algum já foi transferido, contado ou usado em produção — '
  'nesse caso a ferramenta certa é a Contagem.';

REVOKE EXECUTE ON FUNCTION refazer_abertura_do_insumo(UUID, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION refazer_abertura_do_insumo(UUID, UUID) TO authenticated, service_role;

-- ── E o conserto que apareceu ao testar o refazer ────────────
--
-- `abrir_estoque_inicial` marcava os lotes da prateleira com
-- `WHERE lote_grupo_id = v_grupo_id`, e `v_grupo_id` sai de um campo que
-- `registrar_entrada_lote` **nao devolve**. Ficava NULL, o UPDATE nao acertava
-- nada, e o saldo de abertura da prateleira nascia sem marca nenhuma.
--
-- Duas consequencias, as duas silenciosas: no relatorio ele se passava por
-- compra normal -- que e exatamente o que a marca existe para evitar -- e o
-- refazer acima nao teria o que apagar. Apareceu porque o ensaio abriu 5 lotes
-- e o refazer removeu 2.
--
-- Marca pelos ids que a entrada devolveu, como ja se faz com os baldes.

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

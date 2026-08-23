-- ============================================================
-- Migration 099 — a abertura de estoque parava quando o balde
-- tinha mais que uma embalagem
--
-- `abrir_estoque_inicial` cria o lote do conteudo que ja esta nos baldes
-- chamando `registrar_entrada_lote`, a mesma funcao da prateleira. Essa funcao
-- fatia a quantidade pelo `tamanho_embalagem` do insumo e devolve o PRIMEIRO
-- dos lotes criados.
--
-- Com 12,5 kg de acucar nos potes e fardo de 10 kg, ela cria um lote de 10 e
-- outro de 2,5, devolve o de 10, e o passo seguinte tentava descontar os 12,5
-- inteiros dele: -2,5. O `chk_quantidade CHECK (quantidade_disponivel >= 0)`
-- recusava e a abertura inteira falhava -- depois de meia hora de digitacao,
-- com tudo so na memoria do navegador.
--
-- Estourava sempre que o conteudo dos baldes de um insumo passava de uma
-- embalagem. Para acucar e farinha, isso e o caso normal, nao a excecao.
--
-- O conserto: zerar TODOS os lotes que a entrada criou, em vez de descontar de
-- um so. O total continua exato, porque a soma dos lotes E `v_baldes_tot`.
--
-- Partiu de `pg_get_functiondef`, nao da migration 069 -- ver CLAUDE.md.
-- ============================================================

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

      IF v_local.capacidade_max IS NOT NULL AND v_qtd > v_local.capacidade_max THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: %s %s nao cabe - a capacidade e %s %s.',
                 v_local.nome, v_qtd, v_insumo.unidade_medida,
                 v_local.capacidade_max, v_insumo.unidade_medida));
      END IF;
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

      v_grupo_id := (v_res->>'lote_grupo_id')::UUID;
      UPDATE lotes SET origem = 'inventario_inicial' WHERE lote_grupo_id = v_grupo_id;

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

-- ============================================================
-- Migration 069 — Abertura de estoque: a embalagem aberta
--
-- O caso que a 068 não previa: o açúcar vem em fardo de 10 kg, e na
-- prateleira há 9 fardos fechados mais um já aberto com 8 kg. Pedindo
-- "quantidade total" e "em quantas embalagens", 98 kg em 10 embalagens
-- viravam dez etiquetas de 9,8 kg — nenhuma delas correspondendo a um fardo
-- de verdade. Quem transferisse um fardo fechado lançaria 9,8 kg de um pacote
-- com 10, todas as vezes.
--
-- A correção mora na tela, que agora manda dois itens: um com as embalagens
-- fechadas (9 × 10 kg) e outro com a aberta (1 × 8 kg). O banco só precisava
-- de uma coisa para isso ficar legível depois: deixar a observação vir de
-- fora, para o lote da embalagem aberta dizer que é uma embalagem aberta.
-- ============================================================

CREATE OR REPLACE FUNCTION abrir_estoque_inicial(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_itens          JSONB
)
RETURNS JSONB AS $fn$
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

  -- Passo 1: conferir tudo ANTES de gravar qualquer coisa.
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

  -- Passo 2: gravar.
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

    -- A observação vem de fora quando a tela tem algo a dizer sobre o lote —
    -- hoje, que a embalagem está aberta.
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

      v_lote_id := (v_res->>'lote_id')::UUID;
      UPDATE lotes SET origem = 'inventario_inicial' WHERE id = v_lote_id;

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

      UPDATE lotes
         SET quantidade_disponivel = quantidade_disponivel - v_baldes_tot,
             status = CASE WHEN quantidade_disponivel - v_baldes_tot <= 0
                           THEN 'esgotado'::status_lote_enum ELSE status END
       WHERE id = v_lote_id;

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
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

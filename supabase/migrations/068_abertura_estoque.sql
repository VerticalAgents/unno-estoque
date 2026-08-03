-- ============================================================
-- Migration 068 — Abertura de estoque (inventário inicial)
--
-- Quem entra no sistema já tem estoque: sacos na prateleira e baldes cheios,
-- nada disso passou por um recebimento. Até aqui a única saída era criar os
-- lotes por SQL — o que funciona para o dono do código e para mais ninguém.
-- Esta migration dá a porta que faltava, para a tela usar.
--
-- Duas decisões que valem registro:
--
-- 1. O saldo de abertura NÃO é uma compra. Ganha `origem = 'inventario_inicial'`
--    em vez de nota fiscal inventada. Sem isso ele entraria disfarçado de
--    entrada e poluiria o primeiro fechamento da auditoria de perdas (066),
--    que compara consumo teórico com o real.
--
-- 2. Prateleira e balde viram lotes separados. O que está no balde já saiu da
--    embalagem: nasce lote, vai direto para o recipiente e se esgota no mesmo
--    instante. Assim quem conta informa só o que enxerga — o que está na
--    prateleira e o que está no pote — sem somar nada de cabeça.
-- ============================================================

-- ── 1. De onde veio o lote ──────────────────────────────────
ALTER TABLE lotes ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'recebimento';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_lotes_origem'
  ) THEN
    ALTER TABLE lotes ADD CONSTRAINT chk_lotes_origem
      CHECK (origem IN ('recebimento', 'inventario_inicial'));
  END IF;
END $$;

COMMENT ON COLUMN lotes.origem IS
  'recebimento: entrou por compra, com fornecedor e nota. '
  'inventario_inicial: saldo que já existia quando a empresa começou a usar o '
  'sistema. Não é compra — relatórios de entrada devem excluí-lo.';

-- ── 2. abrir_estoque_inicial ────────────────────────────────
--
-- p_itens é um array. Cada item descreve UM lote de UM insumo:
--
--   {
--     "insumo_id":   "uuid",
--     "marca_id":    "uuid"  | null,
--     "fornecedor_id": "uuid" | null,
--     "validade":    "2026-12-31" | null,   -- null = vai para o fim do FEFO
--     "quantidade_prateleira": 25.0,        -- na unidade do insumo
--     "embalagens":  2,                     -- quantas etiquetas gerar
--     "baldes": [ { "local_id": "uuid", "quantidade": 3.4 } ]
--   }
--
-- Insumo com duas marcas ou duas validades manda dois itens: é assim que a
-- tela desdobra sem que o banco precise saber disso.
-- ============================================================
CREATE OR REPLACE FUNCTION abrir_estoque_inicial(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_itens          JSONB
)
RETURNS JSONB AS $$
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

  -- ── Passo 1: conferir tudo ANTES de gravar qualquer coisa ──
  -- Uma abertura meio feita é pior que nenhuma: o operador não teria como
  -- saber o que já entrou e o que não. Como devolver erro não desfaz o que a
  -- função já escreveu, a validação inteira acontece antes da primeira escrita.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    SELECT * INTO v_insumo
      FROM insumos
     WHERE id = (v_item->>'insumo_id')::UUID
       AND empresa_id = p_empresa_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Insumo %s não encontrado nesta empresa.', v_item->>'insumo_id'));
    END IF;

    v_prateleira := COALESCE((v_item->>'quantidade_prateleira')::NUMERIC, 0);
    IF v_prateleira < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s: quantidade na prateleira não pode ser negativa.', v_insumo.nome));
    END IF;

    v_embalagens := GREATEST(COALESCE((v_item->>'embalagens')::INTEGER, 1), 1);

    FOR v_balde IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'baldes', '[]'::JSONB))
    LOOP
      SELECT * INTO v_local
        FROM locais
       WHERE id = (v_balde->>'local_id')::UUID
         AND empresa_id = p_empresa_id;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: recipiente não encontrado.', v_insumo.nome));
      END IF;

      IF v_local.insumo_id IS DISTINCT FROM v_insumo.id THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('O recipiente %s não é de %s.', v_local.nome, v_insumo.nome));
      END IF;

      v_qtd := COALESCE((v_balde->>'quantidade')::NUMERIC, 0);
      IF v_qtd < 0 THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: quantidade negativa.', v_local.nome));
      END IF;

      IF v_local.capacidade_max IS NOT NULL AND v_qtd > v_local.capacidade_max THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          format('%s: %s %s não cabe — a capacidade é %s %s.',
                 v_local.nome, v_qtd, v_insumo.unidade_medida,
                 v_local.capacidade_max, v_insumo.unidade_medida));
      END IF;
    END LOOP;
  END LOOP;

  -- ── Passo 2: gravar ────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    SELECT * INTO v_insumo FROM insumos WHERE id = (v_item->>'insumo_id')::UUID;

    v_prateleira := COALESCE((v_item->>'quantidade_prateleira')::NUMERIC, 0);
    v_embalagens := GREATEST(COALESCE((v_item->>'embalagens')::INTEGER, 1), 1);

    SELECT COALESCE(SUM(COALESCE((b->>'quantidade')::NUMERIC, 0)), 0)
      INTO v_baldes_tot
      FROM jsonb_array_elements(COALESCE(v_item->'baldes', '[]'::JSONB)) b;

    -- Linha em branco é linha que o operador pulou de propósito.
    CONTINUE WHEN v_prateleira <= 0 AND v_baldes_tot <= 0;

    -- Sem validade na embalagem, o lote vai para o fim da fila do FEFO em vez
    -- de bloquear a abertura. Dez anos é "não sei", não é uma promessa.
    v_validade := COALESCE(
      NULLIF(v_item->>'validade', '')::DATE,
      CURRENT_DATE + 3650
    );

    -- ── 2a. O que está na prateleira ──
    IF v_prateleira > 0 THEN
      v_res := registrar_entrada_lote(
        p_empresa_id,
        v_insumo.id,
        NULLIF(v_item->>'fornecedor_id', '')::UUID,
        CURRENT_DATE,
        v_validade,
        v_prateleira,
        v_insumo.unidade_medida::TEXT,
        v_embalagens,
        'Saldo de abertura do estoque',
        p_responsavel_id,
        NULL,
        NULLIF(v_item->>'marca_id', '')::UUID
      );

      IF NOT (v_res->>'ok')::BOOLEAN THEN
        RAISE EXCEPTION 'Falha ao criar o lote de %: %', v_insumo.nome, v_res->>'erro';
      END IF;

      v_grupo_id := (v_res->>'lote_grupo_id')::UUID;
      UPDATE lotes SET origem = 'inventario_inicial' WHERE lote_grupo_id = v_grupo_id;

      v_etiquetas := v_etiquetas || (v_res->'lotes');
      v_n_lotes := v_n_lotes + v_embalagens;
      v_total := v_total + v_prateleira;
    END IF;

    -- ── 2b. O que já está dentro dos baldes ──
    -- Um lote só para o conjunto: ele nasce e se esgota na mesma transação,
    -- porque o conteúdo passa inteiro para os recipientes. Não gera etiqueta —
    -- não existe embalagem física para colar, e o balde já tem a sua.
    IF v_baldes_tot > 0 THEN
      v_res := registrar_entrada_lote(
        p_empresa_id,
        v_insumo.id,
        NULLIF(v_item->>'fornecedor_id', '')::UUID,
        CURRENT_DATE,
        v_validade,
        v_baldes_tot,
        v_insumo.unidade_medida::TEXT,
        1,
        'Saldo de abertura — conteúdo já nos recipientes',
        p_responsavel_id,
        NULL,
        NULLIF(v_item->>'marca_id', '')::UUID
      );

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
          (v_balde->>'local_id')::UUID,
          v_lote_id,
          v_qtd,
          v_insumo.unidade_medida,
          v_validade_ep
        );

        v_n_baldes := v_n_baldes + 1;
      END LOOP;

      -- O lote foi inteiro para os potes: baixa no estoque central.
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
    'lotes', v_etiquetas,               -- só os da prateleira: são os que se etiquetam
    'lotes_criados', v_n_lotes,
    'recipientes_abastecidos', v_n_baldes,
    'quantidade_total', ROUND(v_total, 3)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION abrir_estoque_inicial IS
  'Cria o saldo inicial de estoque de quem está começando a usar o sistema, '
  'sem fingir um recebimento. Valida tudo antes de gravar qualquer coisa. '
  'Devolve em "lotes" apenas os da prateleira, que são os que precisam de etiqueta.';

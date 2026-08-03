-- ============================================================
-- Migration 057 — Encher o estoque central de uma vez (Dev Tools)
--
-- A 056 enche os recipientes, mas só funciona se houver lote no estoque
-- central. Faltava o passo anterior: criar o estoque.
--
-- A quantidade não é um número fixo: é calculada a partir da capacidade dos
-- recipientes de cada insumo, para dar e sobrar. Insumo sem recipiente ganha
-- uma quantidade mínima, senão não daria para testar recebimento nem contagem.
-- ============================================================

CREATE OR REPLACE FUNCTION dev_encher_estoque_central(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_sublotes       INTEGER DEFAULT 4,
  -- Quantas vezes a capacidade dos recipientes. 3 dá para encher, produzir e
  -- ainda sobrar no estoque.
  p_fator          NUMERIC DEFAULT 3
)
RETURNS JSONB AS $$
DECLARE
  v_ins        RECORD;
  v_capacidade NUMERIC;
  v_qtd        NUMERIC;
  v_criados    INTEGER := 0;
  v_total      NUMERIC := 0;
BEGIN
  FOR v_ins IN
    SELECT i.id, i.codigo, i.unidade_medida::TEXT AS unidade
      FROM insumos i
     WHERE i.empresa_id = p_empresa_id AND i.ativo
     ORDER BY chave_natural(i.codigo)
  LOOP
    SELECT COALESCE(SUM(COALESCE(c.capacidade_max, 0)), 0)
      INTO v_capacidade
      FROM v_recipientes_composicao c
     WHERE c.empresa_id = p_empresa_id AND c.insumo_id = v_ins.id;

    -- Sem recipiente cadastrado não há capacidade para multiplicar; 50 é o
    -- suficiente para o insumo aparecer nas telas de estoque.
    v_qtd := GREATEST(ROUND(v_capacidade * p_fator, 3), 50);

    PERFORM registrar_entrada_lote(
      p_empresa_id, v_ins.id, NULL,
      CURRENT_DATE, CURRENT_DATE + 365,
      v_qtd, v_ins.unidade, GREATEST(p_sublotes, 1),
      NULL, p_responsavel_id, NULL, NULL);

    v_criados := v_criados + 1;
    v_total   := v_total + v_qtd;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'insumos', v_criados, 'quantidade_total', ROUND(v_total, 3));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_encher_estoque_central IS
  'Atalho de teste: cria um lote por insumo ativo, com quantidade proporcional '
  'à capacidade dos recipientes daquele insumo.';

-- ============================================================
-- dev_encher_tudo — o estoque central e os recipientes, na ordem certa
-- ============================================================
CREATE OR REPLACE FUNCTION dev_encher_tudo(
  p_empresa_id     UUID,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_ec JSONB;
  v_ep JSONB;
BEGIN
  v_ec := dev_encher_estoque_central(p_empresa_id, p_responsavel_id);
  v_ep := dev_encher_recipientes(p_empresa_id);
  RETURN jsonb_build_object('ok', true, 'estoque_central', v_ec, 'recipientes', v_ep);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_encher_tudo IS
  'Cria o estoque central e já despeja nos recipientes. Um clique para deixar '
  'a fábrica pronta para testar.';

-- ============================================================
-- Migration 056 — Encher os recipientes de uma vez (Dev Tools)
--
-- Testar produção exige recipiente cheio, e enchê-los pela tela de
-- transferência são dezenas de leituras de QR. Isto é atalho de teste: usa os
-- lotes que já existem no estoque central e despeja até a capacidade.
--
-- Recipiente cujo insumo não tem lote com saldo é pulado e volta na contagem —
-- em vez de inventar estoque do nada, que mascararia o problema real.
-- ============================================================

CREATE OR REPLACE FUNCTION dev_encher_recipientes(
  p_empresa_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_rec       RECORD;
  v_lote      lotes%ROWTYPE;
  v_insumo    insumos%ROWTYPE;
  v_falta     DECIMAL;
  v_leva      DECIMAL;
  v_validade  DATE;
  v_cheios    INTEGER := 0;
  v_sem_lote  INTEGER := 0;
  v_total     DECIMAL := 0;
BEGIN
  FOR v_rec IN
    SELECT c.local_id, c.insumo_id, c.espaco_livre
      FROM v_recipientes_composicao c
     WHERE c.empresa_id = p_empresa_id
       AND c.espaco_livre > 0
     ORDER BY c.insumo_codigo, chave_natural(c.local_nome)
  LOOP
    v_falta := v_rec.espaco_livre;
    SELECT * INTO v_insumo FROM insumos WHERE id = v_rec.insumo_id;

    -- Vai consumindo lotes até encher o recipiente ou acabar o estoque.
    WHILE v_falta > 0 LOOP
      SELECT * INTO v_lote
        FROM lotes l
       WHERE l.empresa_id = p_empresa_id
         AND l.insumo_id  = v_rec.insumo_id
         AND l.status     = 'ativo'
         AND l.quantidade_disponivel > 0
       ORDER BY (l.quantidade_disponivel < l.quantidade_recebida) DESC,
                l.validade_pos_abertura, chave_natural(l.codigo)
       LIMIT 1;

      IF NOT FOUND THEN
        v_sem_lote := v_sem_lote + 1;
        EXIT;
      END IF;

      v_leva := LEAST(v_lote.quantidade_disponivel, v_falta);

      v_validade := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
        ELSE v_lote.validade_original
      END;

      PERFORM abastecer_recipiente(v_rec.local_id, v_lote.id, v_leva, v_lote.unidade, v_validade);

      UPDATE lotes
         SET quantidade_disponivel = quantidade_disponivel - v_leva,
             status = CASE WHEN quantidade_disponivel - v_leva <= 0
                           THEN 'esgotado'::status_lote_enum ELSE status END
       WHERE id = v_lote.id;

      v_falta := v_falta - v_leva;
      v_total := v_total + v_leva;
    END LOOP;

    IF v_falta <= 0 THEN v_cheios := v_cheios + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'recipientes_cheios', v_cheios,
    'sem_lote', v_sem_lote,
    'quantidade_total', ROUND(v_total, 3)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_encher_recipientes IS
  'Atalho de teste: enche os recipientes do EP até a capacidade usando os lotes '
  'do estoque central. Não inventa estoque — insumo sem lote é pulado.';

-- ============================================================
-- Migration 031 — Planejador ordenado por código do insumo
--
-- Estava por demanda decrescente. A planilha que o Lucca usa lista na ordem
-- INS001, INS002, … e é essa a ordem em que ele confere os recipientes na
-- prática. Ordenar no banco mantém tela e folha impressa iguais.
-- ============================================================

CREATE OR REPLACE FUNCTION planejar_recipientes(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id           UUID,
  codigo              TEXT,
  nome                TEXT,
  unidade             TEXT,
  recipiente_modelo   TEXT,
  capacidade          DECIMAL,
  demanda             DECIMAL,
  demanda_com_folga   DECIMAL,
  recipientes_atuais  INTEGER,
  recipientes_necessarios INTEGER,
  faltam              INTEGER
) AS $$
DECLARE
  v_folga DECIMAL;
BEGIN
  SELECT COALESCE(folga_recipientes_pct, 0) / 100.0 INTO v_folga
    FROM configuracoes_sistema WHERE empresa_id = p_empresa_id;
  v_folga := COALESCE(v_folga, 0);

  RETURN QUERY
  WITH plano AS (
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           COALESCE((e->>'formas')::DECIMAL, 0) AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::DECIMAL, 0) > 0
  ),
  -- Demanda SOMADA sobre todas as fichas do plano: os recipientes são um pool
  -- único, o açúcar das duas receitas vai nos mesmos potes.
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  recipientes AS (
    SELECT l.insumo_id AS ins_id, COUNT(*)::INTEGER AS n
      FROM locais l
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.ativo
     GROUP BY l.insumo_id
  )
  SELECT
    i.id,
    i.codigo::TEXT,
    i.nome::TEXT,
    i.unidade_medida::TEXT,
    i.recipiente_subtipo::TEXT,
    i.recipiente_capacidade_max,
    ROUND(d.qtd, 4),
    ROUND(d.qtd * (1 + v_folga), 4),
    COALESCE(r.n, 0),
    CASE WHEN COALESCE(i.recipiente_capacidade_max, 0) > 0
         THEN CEIL(d.qtd * (1 + v_folga) / i.recipiente_capacidade_max)::INTEGER
         ELSE NULL END,
    CASE WHEN COALESCE(i.recipiente_capacidade_max, 0) > 0
         THEN GREATEST(
                CEIL(d.qtd * (1 + v_folga) / i.recipiente_capacidade_max)::INTEGER
                - COALESCE(r.n, 0), 0)
         ELSE NULL END
  FROM demanda_insumo d
  JOIN insumos i ON i.id = d.ins_id
  LEFT JOIN recipientes r ON r.ins_id = d.ins_id
  WHERE i.empresa_id = p_empresa_id
  ORDER BY i.codigo;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

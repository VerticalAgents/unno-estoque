-- ============================================================
-- Migration 033 — FEFO: mostrar também o insumo SEM lote disponível
--
-- A 032 usava JOIN com os lotes, então um insumo que precisa ser transferido
-- mas não tem nenhum lote no estoque central simplesmente sumia do resultado —
-- indistinguível de um insumo já coberto pelo recipiente.
--
-- É justamente o caso mais importante de aparecer: significa que a produção vai
-- parar por falta de insumo. Com LEFT JOIN ele vem com os campos de lote nulos,
-- e a tela/folha consegue dizer "sem lote no estoque".
--
-- A condição `acum_antes < falta` passa para o ON: no LEFT JOIN ela precisa
-- filtrar o lado direito, não a linha inteira.
-- ============================================================

CREATE OR REPLACE FUNCTION sugerir_lotes_transferencia(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id         UUID,
  insumo_codigo     TEXT,
  insumo_nome       TEXT,
  unidade           TEXT,
  demanda           DECIMAL,
  ja_no_ep          DECIMAL,
  falta_transferir  DECIMAL,
  lote_id           UUID,
  lote_codigo       TEXT,
  validade          DATE,
  dias_para_vencer  INTEGER,
  quantidade_lote   DECIMAL,
  acumulado         DECIMAL,
  cobre             BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH plano AS (
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           COALESCE((e->>'formas')::DECIMAL, 0) AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::DECIMAL, 0) > 0
  ),
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  no_ep AS (
    SELECT l.insumo_id AS ins_id, SUM(lea.quantidade) AS qtd
      FROM locais_estado_atual lea
      JOIN lotes l ON l.id = lea.lote_id
     WHERE l.empresa_id = p_empresa_id
     GROUP BY l.insumo_id
  ),
  necessidade AS (
    SELECT d.ins_id,
           d.qtd AS demanda,
           COALESCE(n.qtd, 0) AS ja_no_ep,
           GREATEST(d.qtd - COALESCE(n.qtd, 0), 0) AS falta
      FROM demanda_insumo d
      LEFT JOIN no_ep n ON n.ins_id = d.ins_id
  ),
  lotes_fefo AS (
    SELECT
      l.id, l.insumo_id AS ins_id, l.codigo, l.validade_pos_abertura,
      l.quantidade_disponivel,
      COALESCE(SUM(l.quantidade_disponivel) OVER (
        PARTITION BY l.insumo_id
        ORDER BY l.validade_pos_abertura, l.codigo
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0) AS acum_antes,
      SUM(l.quantidade_disponivel) OVER (
        PARTITION BY l.insumo_id
        ORDER BY l.validade_pos_abertura, l.codigo
      ) AS acum_ate
      FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.status = 'ativo'
       AND l.quantidade_disponivel > 0
  )
  SELECT
    i.id,
    i.codigo::TEXT,
    i.nome::TEXT,
    i.unidade_medida::TEXT,
    ROUND(nec.demanda, 4),
    ROUND(nec.ja_no_ep, 4),
    ROUND(nec.falta, 4),
    lf.id,
    lf.codigo::TEXT,
    lf.validade_pos_abertura,
    (lf.validade_pos_abertura - CURRENT_DATE)::INTEGER,
    lf.quantidade_disponivel,
    ROUND(lf.acum_ate, 4),
    COALESCE(lf.acum_ate >= nec.falta, false)
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  LEFT JOIN lotes_fefo lf
    ON lf.ins_id = nec.ins_id
   AND lf.acum_antes < nec.falta   -- só os lotes necessários; o último vai inteiro (RO-002)
  WHERE nec.falta > 0
  ORDER BY i.codigo, lf.validade_pos_abertura NULLS LAST, lf.codigo;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

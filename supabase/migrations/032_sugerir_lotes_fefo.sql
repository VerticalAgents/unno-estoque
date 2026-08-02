-- ============================================================
-- Migration 032 — Sugestão de lotes a transferir (FEFO)
--
-- O planejador já diz QUANTOS recipientes encher. Esta função diz COM QUAIS
-- LOTES, respeitando FEFO (First Expired, First Out): sai primeiro o que
-- vence antes, para não vencer insumo no estoque.
--
-- Duas regras do negócio moldam o resultado:
--
--   RO-002 — a transferência é sempre do LOTE INTEIRO. Por isso a função
--   sugere lotes completos até cobrir a necessidade; o último pode sobrar,
--   e isso é o esperado, não um erro de cálculo.
--
--   O que já está nos recipientes do EP conta. Se o balde de açúcar já tem
--   12 kg e a sessão precisa de 30, faltam 18 — não 30.
--
-- Estoque central = lotes.quantidade_disponivel (é decrementado na
-- transferência). Estoque produtivo = locais_estado_atual.quantidade.
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
  -- Demanda somada entre as fichas, mesma regra do planejador
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  -- O que já está abastecido nos recipientes do EP
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
  -- Lotes disponíveis no estoque central, em ordem de vencimento (FEFO).
  -- `acum_antes` = quanto já foi coberto pelos lotes anteriores da fila.
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
    (lf.acum_ate >= nec.falta)
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  JOIN lotes_fefo lf ON lf.ins_id = nec.ins_id
  -- Só os lotes necessários: para quando o acumulado dos anteriores já cobre.
  -- O último entra inteiro (RO-002) mesmo que sobre.
  WHERE nec.falta > 0
    AND lf.acum_antes < nec.falta
  ORDER BY i.codigo, lf.validade_pos_abertura, lf.codigo;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION sugerir_lotes_transferencia IS
  'Dado o plano de produção, sugere quais lotes do estoque central transferir '
  'para os recipientes, em ordem FEFO (vence antes, sai antes). Desconta o que '
  'já está no EP e sugere lotes inteiros, conforme RO-002.';

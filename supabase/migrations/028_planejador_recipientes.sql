-- ============================================================
-- Migration 028 — Planejador de Recipientes
--
-- Espelha a aba "Planejador" da planilha de recipientes: dado quantas formas
-- de cada ficha entram na sessão, calcula a demanda de cada insumo em kg e
-- quantos recipientes precisam estar cheios ANTES da produção começar.
--
-- Não há tabela nova: tudo já existe no banco.
--   demanda   = fichas_tecnicas_itens.quantidade × rendimento_fornada × formas
--   capacidade= locais.capacidade_max
--   estoque   = count(locais) por insumo
--
-- O único parâmetro novo é a folga de segurança (célula G8 da planilha).
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS folga_recipientes_pct DECIMAL(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN configuracoes_sistema.folga_recipientes_pct IS
  'Percentual de folga aplicado sobre a demanda antes de dividir pela '
  'capacidade do recipiente. 0 = sem folga (padrão da planilha).';

-- ============================================================
-- RPC: planejar_recipientes
--
-- p_plano = [{"ficha_id": uuid, "formas": 44}, ...]
--
-- REGRA CENTRAL: a demanda é SOMADA entre as fichas antes de dividir pela
-- capacidade. Os recipientes são um pool único — não existe "o pote de açúcar
-- do Tradicional" e "o do Doce de Leite"; o açúcar das duas receitas é
-- porcionado nos mesmos potes. Dividir por ficha e somar depois inflaria o
-- número de potes necessários.
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
  -- Demanda de cada insumo, somada sobre TODAS as fichas do plano
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * v.rendimento_fornada * p.formas) AS qtd
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
  ORDER BY d.qtd DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION planejar_recipientes IS
  'Planejador de recipientes por sessão de produção. Recebe [{ficha_id, formas}] '
  'e devolve, por insumo, a demanda somada entre as fichas e quantos recipientes '
  'precisam estar abastecidos antes do início da produção.';

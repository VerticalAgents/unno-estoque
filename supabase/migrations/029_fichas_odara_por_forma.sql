-- ============================================================
-- Migration 029 — Padroniza a unidade das fichas Odara
--
-- PROBLEMA
-- O banco tinha duas convenções conflitantes para
-- `fichas_tecnicas_itens.quantidade`:
--   • migration 001 (comentário) e migration 023 → quantidade POR UNIDADE
--   • migration 016 (`abrir_sessao_producao`)    → quantidade POR FORNADA
-- Quem roda em produção é a 016. Com os itens gravados por unidade, o consumo
-- teórico de uma sessão sairia 60× menor que o real (60 un/forma).
--
-- Além disso a quantidade estava em gramas enquanto `locais.capacidade_max` e
-- `lotes.quantidade_disponivel` estão na unidade do insumo (kg), o que fazia o
-- planejador pedir 1.810 potes de açúcar para 44 formas.
--
-- DECISÃO
-- `quantidade` = consumo POR FORNADA, na unidade de medida do próprio insumo.
-- Para as fichas Odara, 1 fornada = 1 forma = 60 unidades de ~67,5 g.
-- Assim ficha, recipiente, lote e estoque falam a mesma língua.
--
-- A coluna passa a DECIMAL(14,6): em kg, o extrato de alecrim é 0,00205 por
-- forma, e 4 casas decimais arredondariam para 0,0021 (erro de 2,4%).
--
-- As fichas Morena Cacau (FT-9001/FT-9002) ficam como estão — desativadas e
-- fora de qualquer cálculo.
-- ============================================================

ALTER TABLE fichas_tecnicas_itens
  ALTER COLUMN quantidade TYPE DECIMAL(14,6);

COMMENT ON COLUMN fichas_tecnicas_itens.quantidade IS
  'Consumo por FORNADA, na unidade de medida do insumo. '
  'Casa com abrir_sessao_producao/fechar_sessao_producao, que multiplicam '
  'este valor pelo número de fornadas da sessão.';

DO $$
DECLARE
  v_empresa_id UUID;
  v_versao_id  UUID;
BEGIN
  SELECT id INTO v_empresa_id FROM empresas WHERE nome = 'Mischa''s Bakery' LIMIT 1;

  -- ── FT-001 Brownie Tradicional Odara ──────────────────────
  -- Valores da ficha de 4 formas ÷ 4 = por forma; g convertido para kg.
  SELECT v.id INTO v_versao_id
    FROM fichas_tecnicas f JOIN fichas_tecnicas_versoes v ON v.ficha_id = f.id AND v.ativa
   WHERE f.empresa_id = v_empresa_id AND f.codigo = 'FT-001';

  DELETE FROM fichas_tecnicas_itens WHERE versao_id = v_versao_id;

  INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade, observacoes)
  SELECT v_versao_id,
         (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = x.cod),
         x.qtd, x.un::unidade_medida_enum, x.obs
    FROM (VALUES
      ('INS012', 0.813500,  'kg', 'derretida 662,8 g + gotas 2.591,2 g, somadas'),
      ('INS001', 0.699200,  'kg', NULL),
      ('INS002', 0.445350,  'kg', NULL),
      ('INS006', 0.423750,  'kg', NULL),
      ('INS003', 0.389750,  'kg', NULL),
      ('INS014', 0.278300,  'kg', NULL),
      ('INS007', 0.200425,  'kg', NULL),
      ('INS005', 0.158900,  'kg', NULL),
      ('INS009', 0.105925,  'kg', NULL),
      ('INS008', 0.100225,  'kg', NULL),
      ('INS004', 0.042375,  'kg', NULL),
      ('INS010', 11.125000, 'ml', NULL),
      ('INS015', 0.011125,  'kg', NULL),
      ('INS024', 0.010250,  'kg', 'travado em 0,25% da receita'),
      ('INS016', 0.008200,  'kg', 'travado em 0,20% da receita'),
      ('INS017', 0.004100,  'kg', 'travado em 0,10% da receita'),
      ('INS018', 0.004100,  'kg', 'travado em 0,10% da receita'),
      ('INS019', 0.002050,  'kg', 'travado em 0,05% da receita')
    ) AS x(cod, qtd, un, obs);

  -- ── FT-002 Brownie Doce de Leite Odara ────────────────────
  SELECT v.id INTO v_versao_id
    FROM fichas_tecnicas f JOIN fichas_tecnicas_versoes v ON v.ficha_id = f.id AND v.ativa
   WHERE f.empresa_id = v_empresa_id AND f.codigo = 'FT-002';

  DELETE FROM fichas_tecnicas_itens WHERE versao_id = v_versao_id;

  INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade, observacoes)
  SELECT v_versao_id,
         (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = x.cod),
         x.qtd, x.un::unidade_medida_enum, x.obs
    FROM (VALUES
      ('INS014', 0.758900,  'kg', 'massa 2.235,6 g + topping 800 g (200 g/forma), somados'),
      ('INS001', 0.663875,  'kg', NULL),
      ('INS002', 0.644425,  'kg', NULL),
      ('INS013', 0.619100,  'kg', 'travado em 15,10% da receita'),
      ('INS011', 0.299250,  'kg', NULL),
      ('INS006', 0.260300,  'kg', NULL),
      ('INS004', 0.113900,  'kg', NULL),
      ('INS007', 0.104275,  'kg', NULL),
      ('INS005', 0.088325,  'kg', NULL),
      ('INS009', 0.068450,  'kg', NULL),
      ('INS008', 0.052100,  'kg', NULL),
      ('INS010', 25.975000, 'ml', NULL),
      ('INS015', 0.025975,  'kg', NULL),
      ('INS024', 0.012300,  'kg', 'travado em 0,30% da receita'),
      ('INS025', 0.010250,  'kg', 'travado em 0,25% da receita'),
      ('INS016', 0.008200,  'kg', 'travado em 0,20% da receita'),
      ('INS017', 0.004100,  'kg', 'travado em 0,10% da receita'),
      ('INS018', 0.004100,  'kg', 'travado em 0,10% da receita'),
      ('INS019', 0.002050,  'kg', 'travado em 0,05% da receita')
    ) AS x(cod, qtd, un, obs);

END $$;

-- ============================================================
-- planejar_recipientes: agora a quantidade da ficha já é por forma e já está
-- na unidade do insumo, então a demanda é quantidade × formas — sem multiplicar
-- pelo rendimento e sem converter grama para quilo.
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
  ORDER BY d.qtd DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

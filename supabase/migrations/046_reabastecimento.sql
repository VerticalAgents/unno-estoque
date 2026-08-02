-- ============================================================
-- Migration 046 — Reabastecimento (o pedido para a Odara)
--
-- Substitui a aba "Projeção de Produção Mensal" da planilha.
--
-- A pergunta que esta tela responde: quanto pedir de cada insumo para aguentar
-- até a próxima entrega, considerando o que já está na casa.
--
--   consumo/dia          = soma das fichas × formas por dia
--   necessário no período = consumo/dia × dias × (1 + margem)
--   tem em casa           = estoque central + o que está nos recipientes
--   comprar               = necessário − tem em casa (nunca negativo)
--
-- Por que o estoque conta os dois: o açúcar que está no pote da produção é
-- açúcar que a padaria tem. Pedir como se não existisse encheria o depósito.
--
-- A auditoria de estoque que existe na planilha NÃO entra aqui — é o módulo de
-- Contagem, que já existe desde a migration 019.
-- ============================================================

-- ============================================================
-- 1. Projeção: quantas formas de cada ficha por dia
-- ============================================================
CREATE TABLE IF NOT EXISTS projecao_producao (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id     UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ficha_id       UUID NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  formas_por_dia DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (formas_por_dia >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, ficha_id)
);

COMMENT ON TABLE projecao_producao IS
  'Mix diário planejado: quantas formas de cada ficha a padaria produz por dia. '
  'É a base do cálculo de reabastecimento.';

ALTER TABLE projecao_producao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acesso_por_empresa" ON projecao_producao;
CREATE POLICY "acesso_por_empresa" ON projecao_producao
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

-- ============================================================
-- 2. Parâmetros do pedido
--
-- Ficam em configuracoes_sistema porque são configuração da empresa, não do
-- insumo: mudam quando muda o contrato de entrega, não a receita.
-- ============================================================
ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS reabastecimento_dias       INTEGER      NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS reabastecimento_margem_pct DECIMAL(5,2) NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS dias_uteis_mes             INTEGER      NOT NULL DEFAULT 22;

COMMENT ON COLUMN configuracoes_sistema.reabastecimento_dias IS
  'De quantos em quantos dias o fornecedor entrega. Define o período a cobrir.';
COMMENT ON COLUMN configuracoes_sistema.reabastecimento_margem_pct IS
  'Margem de segurança sobre o consumo do período, em %. Cobre atraso de '
  'entrega e produção acima do previsto.';

-- ============================================================
-- 3. v_reabastecimento — a lista do pedido
-- ============================================================
CREATE OR REPLACE VIEW v_reabastecimento AS
WITH cfg AS (
  SELECT empresa_id,
         reabastecimento_dias       AS dias,
         reabastecimento_margem_pct AS margem,
         dias_uteis_mes             AS dias_uteis
    FROM configuracoes_sistema
),
consumo AS (
  SELECT p.empresa_id,
         it.insumo_id,
         SUM(it.quantidade * p.formas_por_dia) AS por_dia
    FROM projecao_producao p
    JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
    JOIN fichas_tecnicas_itens  it ON it.versao_id = v.id
   WHERE p.formas_por_dia > 0
   GROUP BY p.empresa_id, it.insumo_id
),
-- Estoque central: embalagens fechadas e o lote aberto
ec AS (
  SELECT empresa_id, insumo_id, SUM(quantidade_disponivel) AS qtd
    FROM lotes
   WHERE status = 'ativo' AND quantidade_disponivel > 0
   GROUP BY empresa_id, insumo_id
),
-- Estoque produtivo: o que está dentro dos recipientes
ep AS (
  SELECT l.empresa_id, l.insumo_id, SUM(ll.quantidade) AS qtd
    FROM locais l
    JOIN locais_lotes ll ON ll.local_id = l.id
   WHERE ll.quantidade > 0 AND l.ativo
   GROUP BY l.empresa_id, l.insumo_id
)
SELECT
  c.empresa_id,
  i.id                       AS insumo_id,
  i.codigo                   AS insumo_codigo,
  i.nome                     AS insumo_nome,
  i.unidade_medida           AS unidade,
  cfg.dias                   AS dias_periodo,
  cfg.margem                 AS margem_pct,
  ROUND(c.por_dia, 4)                             AS consumo_dia,
  ROUND(c.por_dia * cfg.dias_uteis, 3)            AS consumo_mes,
  ROUND(c.por_dia * cfg.dias * (1 + cfg.margem / 100), 5) AS necessario_periodo,
  ROUND(COALESCE(ec.qtd, 0), 3)                   AS estoque_ec,
  ROUND(COALESCE(ep.qtd, 0), 3)                   AS estoque_ep,
  ROUND(COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0), 3) AS estoque_total,
  ROUND(GREATEST(
    c.por_dia * cfg.dias * (1 + cfg.margem / 100)
      - COALESCE(ec.qtd, 0) - COALESCE(ep.qtd, 0), 0), 3) AS comprar,
  i.tamanho_embalagem,
  -- Só dá para converter em embalagens quando o tamanho está cadastrado.
  CASE
    WHEN i.tamanho_embalagem IS NULL OR i.tamanho_embalagem <= 0 THEN NULL
    ELSE CEIL(GREATEST(
      c.por_dia * cfg.dias * (1 + cfg.margem / 100)
        - COALESCE(ec.qtd, 0) - COALESCE(ep.qtd, 0), 0) / i.tamanho_embalagem)
  END::INTEGER AS embalagens,
  -- Para quantos dias dá o que está em casa hoje
  ROUND((COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0)) / NULLIF(c.por_dia, 0), 1)
                             AS cobertura_dias
FROM consumo c
JOIN insumos i ON i.id = c.insumo_id AND i.ativo
JOIN cfg      ON cfg.empresa_id = c.empresa_id
LEFT JOIN ec  ON ec.empresa_id = c.empresa_id AND ec.insumo_id = c.insumo_id
LEFT JOIN ep  ON ep.empresa_id = c.empresa_id AND ep.insumo_id = c.insumo_id;

COMMENT ON VIEW v_reabastecimento IS
  'Quanto pedir de cada insumo para cobrir o período até a próxima entrega. '
  'O estoque considerado soma o central e o que está nos recipientes.';

-- ============================================================
-- 4. salvar_projecao — grava o mix diário de uma vez
--
-- Recebe [{ficha_id, formas_por_dia}]. Ficha que vier com 0 sai da projeção,
-- em vez de ficar guardada valendo nada.
-- ============================================================
CREATE OR REPLACE FUNCTION salvar_projecao(
  p_empresa_id UUID,
  p_projecao   JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_item   JSONB;
  v_ficha  UUID;
  v_formas DECIMAL;
  v_n      INTEGER := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_projecao) LOOP
    v_ficha  := (v_item->>'ficha_id')::UUID;
    v_formas := COALESCE((v_item->>'formas_por_dia')::DECIMAL, 0);

    IF v_formas > 0 THEN
      INSERT INTO projecao_producao (empresa_id, ficha_id, formas_por_dia)
      VALUES (p_empresa_id, v_ficha, v_formas)
      ON CONFLICT (empresa_id, ficha_id)
      DO UPDATE SET formas_por_dia = EXCLUDED.formas_por_dia, updated_at = NOW();
      v_n := v_n + 1;
    ELSE
      DELETE FROM projecao_producao
       WHERE empresa_id = p_empresa_id AND ficha_id = v_ficha;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'fichas', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

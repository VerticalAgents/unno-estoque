-- Migration 014: RLS policies faltantes + colunas de rendimento e perdas
-- Fix crítico: fichas_tecnicas_versoes, fichas_tecnicas_itens,
--              sessoes_producao_skus e sessoes_producao_locais não tinham
--              policies, causando retorno vazio em todas as queries.

-- ============================================================
-- RLS POLICIES — subtabelas de fichas técnicas
-- ============================================================

CREATE POLICY "acesso_por_empresa" ON fichas_tecnicas_versoes
  USING (
    ficha_id IN (
      SELECT id FROM fichas_tecnicas
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON fichas_tecnicas_itens
  USING (
    versao_id IN (
      SELECT ftv.id
      FROM fichas_tecnicas_versoes ftv
      JOIN fichas_tecnicas ft ON ft.id = ftv.ficha_id
      WHERE ft.empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- RLS POLICIES — subtabelas de sessões de produção
-- ============================================================

CREATE POLICY "acesso_por_empresa" ON sessoes_producao_skus
  USING (
    sessao_id IN (
      SELECT id FROM sessoes_producao
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON sessoes_producao_locais
  USING (
    sessao_id IN (
      SELECT id FROM sessoes_producao
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- RLS POLICIES — demais tabelas com RLS ativo mas sem policy
-- ============================================================

CREATE POLICY "acesso_por_empresa" ON insumos_embalagem_config
  USING (
    insumo_id IN (
      SELECT id FROM insumos
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON insumos_armazenamento_config
  USING (
    insumo_id IN (
      SELECT id FROM insumos
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON lotes_unidades
  USING (
    lote_id IN (
      SELECT id FROM lotes
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON movimentacoes_itens
  USING (
    movimentacao_id IN (
      SELECT id FROM movimentacoes
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON reembalagens
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON locais_estado_atual
  USING (
    local_id IN (
      SELECT id FROM locais
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- NOVAS COLUNAS — fichas_tecnicas_versoes
-- ============================================================

ALTER TABLE fichas_tecnicas_versoes
  ADD COLUMN IF NOT EXISTS rendimento_fornada INTEGER,       -- unidades por fornada
  ADD COLUMN IF NOT EXISTS peso_medio_g       DECIMAL(10,2); -- peso médio por unidade (g)

-- ============================================================
-- NOVAS COLUNAS — sessoes_producao_skus
-- ============================================================

ALTER TABLE sessoes_producao_skus
  ADD COLUMN IF NOT EXISTS multiplicador                  INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quantidade_descartada_gramatura INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peso_descartado_gramatura_g    DECIMAL(10,2);

-- ============================================================
-- NOVAS COLUNAS — sessoes_producao
-- ============================================================

ALTER TABLE sessoes_producao
  ADD COLUMN IF NOT EXISTS fator_perda_insumos DECIMAL(8,4), -- % consumo real vs teórico
  ADD COLUMN IF NOT EXISTS fator_perda_produto DECIMAL(8,4); -- % produto perdido vs produzido

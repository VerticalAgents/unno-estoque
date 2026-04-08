-- ============================================================
-- Migration 006 — Estoque mínimo/máximo por local (EC e EP)
-- Adiciona limites separados para Estoque Central e Produtivo
-- ============================================================

ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS estoque_minimo_ec  DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS estoque_maximo_ec  DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS estoque_minimo_ep  DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS estoque_maximo_ep  DECIMAL(10,3);

-- Políticas RLS que faltavam
CREATE POLICY IF NOT EXISTS "acesso_por_empresa" ON categorias_insumo
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY IF NOT EXISTS "acesso_por_empresa" ON movimentacoes_itens
  USING (movimentacao_id IN (
    SELECT id FROM movimentacoes WHERE empresa_id = get_empresa_id_do_usuario()
  ));

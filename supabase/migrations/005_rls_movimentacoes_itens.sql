-- ============================================================
-- Migration 005 — Fix RLS em movimentacoes_itens
-- A tabela estava com RLS ativado mas sem nenhuma policy,
-- bloqueando todas as leituras/escritas de usuários autenticados.
-- ============================================================

-- Leitura: usuário acessa itens cuja movimentação pertence à sua empresa
CREATE POLICY "acesso_por_empresa" ON movimentacoes_itens
  USING (
    movimentacao_id IN (
      SELECT id FROM movimentacoes
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

-- Escrita: RPCs usam SECURITY DEFINER então não precisam de policy de INSERT/UPDATE.
-- A policy acima (sem WITH CHECK) cobre apenas SELECT por padrão.
-- Para INSERT via cliente (futuro), adicionar WITH CHECK equivalente se necessário.

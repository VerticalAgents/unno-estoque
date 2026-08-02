-- ============================================================
-- Migration 047 — A tela nova precisa entrar nas permissões
--
-- `permissoes_papel` guarda a lista de rotas de cada papel e tem prioridade
-- sobre o fallback do frontend. Sem isto, Gestão e Compras não veriam o item
-- Reabastecimento no menu, mesmo com o código já prevendo o acesso.
--
-- Compras entra porque a tela existe para ela: é quem faz o pedido.
-- Produção fica de fora — quem produz não compra.
-- ============================================================

UPDATE permissoes_papel
   SET rotas = rotas || ARRAY['/reabastecimento']
 WHERE papel IN ('gestao', 'compras')
   AND NOT ('/reabastecimento' = ANY(rotas));

-- E para empresas criadas daqui para a frente
CREATE OR REPLACE FUNCTION inicializar_permissoes_padrao(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO permissoes_papel (empresa_id, papel, rotas) VALUES
    (p_empresa_id, 'admin', ARRAY['*']),
    (p_empresa_id, 'gestao', ARRAY[
      '/dashboard', '/recebimento', '/transferencia', '/reabastecimento', '/producao',
      '/expedicao', '/perdas', '/contagem', '/relatorios',
      '/estoque', '/insumos', '/fornecedores', '/fichas', '/produtos',
      '/recipientes', '/configuracoes']),
    (p_empresa_id, 'producao', ARRAY[
      '/dashboard', '/transferencia', '/producao', '/contagem', '/estoque']),
    (p_empresa_id, 'compras', ARRAY[
      '/dashboard', '/recebimento', '/reabastecimento', '/estoque',
      '/contagem', '/perdas'])
  ON CONFLICT (empresa_id, papel) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

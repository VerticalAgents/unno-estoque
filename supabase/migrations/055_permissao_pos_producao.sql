-- ============================================================
-- Migration 055 — A rota /pos-producao entra nas permissões
--
-- `permissoes_papel` tem prioridade sobre o fallback do frontend, então sem
-- isto o menu não apareceria para Gestão nem para Produção, mesmo com o código
-- prevendo o acesso (ver migration 047).
--
-- Compras fica de fora: quem compra não desenforma.
--
-- NOTA sobre `fechar_sessao_producao`: ela não foi tocada de propósito. As duas
-- colunas novas (`formas_assadas`, `massa_sobra_g`) são medições, não movimento
-- de estoque — a tela as grava direto na tabela antes de fechar. Reescrever uma
-- função que rateia consumo entre lotes para carregar dois números seria risco
-- sem ganho.
-- ============================================================

UPDATE permissoes_papel
   SET rotas = rotas || ARRAY['/pos-producao']
 WHERE papel IN ('gestao', 'producao')
   AND NOT ('/pos-producao' = ANY(rotas));

CREATE OR REPLACE FUNCTION inicializar_permissoes_padrao(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO permissoes_papel (empresa_id, papel, rotas) VALUES
    (p_empresa_id, 'admin', ARRAY['*']),
    (p_empresa_id, 'gestao', ARRAY[
      '/dashboard', '/recebimento', '/transferencia', '/reabastecimento', '/producao',
      '/pos-producao', '/expedicao', '/perdas', '/contagem', '/relatorios',
      '/estoque', '/insumos', '/fornecedores', '/fichas', '/produtos',
      '/recipientes', '/configuracoes']),
    (p_empresa_id, 'producao', ARRAY[
      '/dashboard', '/transferencia', '/producao', '/pos-producao',
      '/contagem', '/estoque']),
    (p_empresa_id, 'compras', ARRAY[
      '/dashboard', '/recebimento', '/reabastecimento', '/estoque',
      '/contagem', '/perdas'])
  ON CONFLICT (empresa_id, papel) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

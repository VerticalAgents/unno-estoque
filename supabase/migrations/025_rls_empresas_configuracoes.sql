-- ============================================================
-- Migration 025 — RLS faltante em empresas e configuracoes_sistema
--
-- Ambas tinham RLS habilitado em 001 mas nunca receberam policy,
-- então toda leitura pelo cliente retornava vazio. Isso afeta:
--   - ImpressaoEtiquetaPage / ImpressaoLotesPage (nome da empresa na etiqueta)
--   - ImpressaoFichaPage (cabeçalho da ficha técnica)
--   - ConfiguracoesPage (ler e salvar dados da empresa)
--
-- Mesmo padrão das migrations 005 e 014, que corrigiram o mesmo
-- problema em outras tabelas.
-- ============================================================

DROP POLICY IF EXISTS "acesso_por_empresa" ON empresas;
CREATE POLICY "acesso_por_empresa" ON empresas
  USING (id = get_empresa_id_do_usuario());

DROP POLICY IF EXISTS "acesso_por_empresa" ON configuracoes_sistema;
CREATE POLICY "acesso_por_empresa" ON configuracoes_sistema
  USING (empresa_id = get_empresa_id_do_usuario());

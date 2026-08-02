-- ============================================================
-- Migration 050 — As views vazavam dados para quem não está logado
--
-- O QUE ESTAVA ACONTECENDO
-- As tabelas têm RLS e recusam leitura anônima como devem. As views, não:
-- no Postgres uma view roda com as permissões de quem a criou (postgres), e o
-- dono da tabela ignora RLS. Resultado: bastava a chave publicável — que é
-- pública por natureza, vai no JavaScript da tela — para ler estoque, fichas
-- técnicas e plano de produção de qualquer empresa, sem login.
--
-- Verificado com uma requisição sem token: as 7 views devolviam dados; as
-- tabelas devolviam vazio.
--
-- A CORREÇÃO
-- `security_invoker = true` (Postgres 15+, e estamos no 17) faz a view rodar
-- com as permissões de quem consulta. Aí o RLS das tabelas de baixo volta a
-- valer, e anônimo não vê nada.
--
-- Não quebra as RPCs: dentro de uma função SECURITY DEFINER quem executa é o
-- dono da função, que segue passando pelo RLS como antes.
-- ============================================================

ALTER VIEW v_estoque_consolidado      SET (security_invoker = true);
ALTER VIEW v_lotes_vencendo           SET (security_invoker = true);
ALTER VIEW v_rastreabilidade_producao SET (security_invoker = true);
ALTER VIEW v_recipientes_composicao   SET (security_invoker = true);
ALTER VIEW v_reabastecimento          SET (security_invoker = true);
ALTER VIEW v_projecao_formas          SET (security_invoker = true);
ALTER VIEW v_plano_semana             SET (security_invoker = true);

-- Ao criar view nova, lembrar de repetir isto. Sem a linha, a view nasce
-- aberta — o padrão do Postgres é o inseguro.

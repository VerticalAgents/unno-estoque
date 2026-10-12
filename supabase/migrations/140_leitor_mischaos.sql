-- Migration 140 — usuário de banco só-leitura para o Mischa OS (aplicada em 12/10/2026).
--
-- O botão "Puxar do unno-estoque" da aba Registro do PCP do Mischa OS compara a produção
-- daqui com o que está lançado lá. Quem lê é uma função de servidor do Mischa OS
-- (mischa-os/supabase/functions/unno-producao), entrando com este usuário: ele só enxerga
-- as três tabelas de produção e não escreve em nenhuma.
--
-- Não é usuário do app (não está em `usuarios`, não tem papel): é login direto no Postgres.
-- Por isso a política de leitura própria: a `acesso_por_empresa` depende do login do app e
-- não devolveria linha nenhuma para ele.
--
-- A SENHA NÃO ESTÁ AQUI. Foi gerada na criação e fica nos segredos do Supabase do Mischa OS
-- (UNNO_ESTOQUE_LEITURA_URL) e em ~/.unno_estoque_leitor, fora de repositório. Para refazer
-- do zero: crie o usuário com uma senha nova e atualize os dois lugares.
--
-- Se a consulta do Mischa OS passar a ler outra tabela, ela precisa do GRANT e da política
-- também.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mischaos_leitor') THEN
    -- Sem senha: o login só funciona depois de um ALTER ROLE ... PASSWORD feito à mão.
    CREATE ROLE mischaos_leitor LOGIN NOINHERIT;
  END IF;
END $$;

ALTER ROLE mischaos_leitor SET default_transaction_read_only = on;
GRANT USAGE ON SCHEMA public TO mischaos_leitor;

GRANT SELECT ON public.sessoes_producao TO mischaos_leitor;
GRANT SELECT ON public.sessoes_producao_skus TO mischaos_leitor;
GRANT SELECT ON public.fichas_tecnicas TO mischaos_leitor;

DROP POLICY IF EXISTS leitura_mischaos ON public.sessoes_producao;
CREATE POLICY leitura_mischaos ON public.sessoes_producao
  FOR SELECT TO mischaos_leitor USING (true);

DROP POLICY IF EXISTS leitura_mischaos ON public.sessoes_producao_skus;
CREATE POLICY leitura_mischaos ON public.sessoes_producao_skus
  FOR SELECT TO mischaos_leitor USING (true);

DROP POLICY IF EXISTS leitura_mischaos ON public.fichas_tecnicas;
CREATE POLICY leitura_mischaos ON public.fichas_tecnicas
  FOR SELECT TO mischaos_leitor USING (true);

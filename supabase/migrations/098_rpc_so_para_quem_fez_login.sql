-- ============================================================
-- Migration 098 — As funções do banco param de atender visitante
--
-- MEDIDO em 17/08/2026, contra o banco de produção, usando só o que está
-- público no GitHub (o repositório é PUBLIC): a URL e a chave publishable do
-- `src/lib/supabase.ts`, sem login nenhum.
--
--   GET /rest/v1/usuarios          → 200 []
--   GET /rest/v1/lotes             → 200 []
--   GET /rest/v1/fornecedores      → 200 []
--   POST /rest/v1/rpc/dossie_rastreabilidade → 200 {"ok": true, "lotes": [...]}
--
-- As tabelas estão trancadas: 46 de 46 com RLS e política por empresa, e
-- nenhuma view sem `security_invoker`. A leitura direta volta vazia.
--
-- O buraco são as funções. SECURITY DEFINER existe para ignorar o RLS — é o que
-- permite a elas fazer o trabalho. Só que estavam com EXECUTE para PUBLIC e
-- para `anon`, e recebem `p_empresa_id` como PARÂMETRO, sem conferir se quem
-- chamou pertence àquela empresa. Quem soubesse o UUID da empresa mandava nela.
--
-- O UUID não é segredo por desenho: aparece em tela, em print, em URL. Depender
-- de ninguém nunca tê-lo visto é sorte, não proteção.
--
-- O QUE ESTA MIGRATION FAZ e o que ela NÃO faz. Ela tira o acesso de quem não
-- fez login — 90% do risco, porque fecha o sistema para a internet inteira. Ela
-- NÃO faz cada função conferir a empresa de quem chama; depois disto, um
-- funcionário logado ainda pode passar o UUID de outra empresa. Enquanto houver
-- uma empresa só no banco isso é teórico, mas vira real no primeiro cliente
-- novo. Essa é a correção de fundo, e fica para uma migration própria.
--
-- `get_empresa_id_do_usuario` FICA liberada para anon de propósito: as políticas
-- de RLS a chamam, e o papel que consulta precisa poder executá-la. Sem isso, a
-- leitura anônima passaria a estourar erro de permissão em vez de devolver
-- vazio — pior de diagnosticar e sem ganho nenhum. Ela devolve o vínculo de
-- quem chama, e para anon devolve NULL.
--
-- Funções de gatilho ficam de fora da lista: são chamadas pelo mecanismo de
-- trigger, que não consulta EXECUTE do usuário.
--
-- Revogação dirigida, nunca `ALL FUNCTIONS IN SCHEMA public`: o schema public
-- também guarda função de extensão (uuid_generate_v4 e companhia), e mexer no
-- privilégio delas quebra INSERT em qualquer tabela com default.
-- ============================================================

DO $$
DECLARE
  v_fn    RECORD;
  v_total INTEGER := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure AS assinatura
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef                                   -- só as que ignoram RLS
       AND p.prorettype <> 'trigger'::regtype            -- gatilho não usa EXECUTE
       AND p.proname <> 'get_empresa_id_do_usuario'      -- usada dentro do RLS
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', v_fn.assinatura);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn.assinatura);
    v_total := v_total + 1;
  END LOOP;

  RAISE NOTICE 'Funções fechadas para visitante: %', v_total;
END $$;

-- ── Que não volte a nascer aberta ───────────────────────────
-- Sem isto, a próxima função criada herda o EXECUTE para PUBLIC e o buraco
-- reaparece na migration seguinte, sem ninguém reparar.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

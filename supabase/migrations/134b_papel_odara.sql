-- ============================================================
-- Migration 134b — o papel 'odara': só a Meta Odara, e só grava o estoque de lá
--
-- O Antônio, da Odara, compra os insumos. Precisa ver quanto há aqui, quanto
-- dura e quanto pedir — e digitar o que a Odara guarda lá. Nada mais (Lucca,
-- 29/09/2026).
--
-- A RLS deste banco separa EMPRESA, não papel: quem está logado lê e grava o
-- que é da empresa. Por isso, além de a tela mostrar uma página só, aqui cada
-- tabela ganha uma trava RESTRITIVA: o papel 'odara' não insere, não altera e
-- não apaga nada — exceto `estoque_externo_insumo`, que é o trabalho dele.
-- Leitura continua liberada: é o que a tela dele precisa, e não estraga dado.
--
-- Fica de fora (pendência de fundo do CLAUDE.md): as funções SECURITY DEFINER
-- não conferem o papel de quem chama. Pela tela, o papel 'odara' não chega a
-- nenhuma delas.

ALTER TABLE permissoes_papel DROP CONSTRAINT IF EXISTS permissoes_papel_papel_check;
ALTER TABLE permissoes_papel ADD CONSTRAINT permissoes_papel_papel_check
  CHECK (papel = ANY (ARRAY['admin', 'gestao', 'producao', 'compras', 'odara']));

INSERT INTO permissoes_papel (empresa_id, papel, rotas)
VALUES ('59e40a9f-b136-4c47-8dc0-2edd73dbe341', 'odara', ARRAY['/odara'])
ON CONFLICT (empresa_id, papel) DO UPDATE SET rotas = EXCLUDED.rotas;

CREATE OR REPLACE FUNCTION public.papel_do_usuario()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT papel::TEXT FROM usuarios WHERE id = auth.uid()
$$;
REVOKE ALL ON FUNCTION papel_do_usuario() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION papel_do_usuario() TO authenticated, service_role;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND rowsecurity
       AND tablename <> 'estoque_externo_insumo'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS odara_nao_insere ON %I', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS odara_nao_altera ON %I', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS odara_nao_apaga ON %I', t.tablename);
    EXECUTE format($p$CREATE POLICY odara_nao_insere ON %I AS RESTRICTIVE FOR INSERT
                      TO authenticated WITH CHECK (papel_do_usuario() IS DISTINCT FROM 'odara')$p$, t.tablename);
    EXECUTE format($p$CREATE POLICY odara_nao_altera ON %I AS RESTRICTIVE FOR UPDATE
                      TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara')$p$, t.tablename);
    EXECUTE format($p$CREATE POLICY odara_nao_apaga ON %I AS RESTRICTIVE FOR DELETE
                      TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara')$p$, t.tablename);
  END LOOP;
END;
$$;

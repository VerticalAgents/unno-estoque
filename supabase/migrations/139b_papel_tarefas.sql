-- Migration 139b — papel "tarefas": login que só usa o Unno Tarefas.
--
-- A Paula e a Clarissa precisam marcar os controles da fábrica no Unno Tarefas, que divide
-- este banco e este login, mas o estoque não compete a elas (Lucca, 11/10/2026).
--
-- Diferente do papel "odara" (134b), que só não escreve, aqui a LEITURA também é barrada:
-- não basta esconder o menu, o banco não entrega dado do estoque para esse papel. Ficam de
-- fora do bloqueio de leitura as tabelas tarefas_* (o app delas), usuarios e permissoes_papel
-- (o login lê as duas). Escrever, esse papel não escreve em tabela nenhuma: as marcações do
-- Unno Tarefas entram pelas funções SECURITY DEFINER (registrar_execucao e companhia).
--
-- Tabela nova com RLS precisa repetir estas políticas à mão, como a 135b e a 137 fizeram
-- com as do papel odara.

ALTER TABLE permissoes_papel DROP CONSTRAINT IF EXISTS permissoes_papel_papel_check;
ALTER TABLE permissoes_papel ADD CONSTRAINT permissoes_papel_papel_check
  CHECK (papel = ANY (ARRAY['admin', 'gestao', 'producao', 'compras', 'odara', 'tarefas']));

-- Sem rota nenhuma no estoque. A tela barra esse papel já no login (AuthContext).
INSERT INTO permissoes_papel (empresa_id, papel, rotas)
VALUES ('59e40a9f-b136-4c47-8dc0-2edd73dbe341', 'tarefas', ARRAY[]::TEXT[])
ON CONFLICT (empresa_id, papel) DO UPDATE SET rotas = EXCLUDED.rotas;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND rowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tarefas_nao_le ON %I', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS tarefas_nao_insere ON %I', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS tarefas_nao_altera ON %I', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS tarefas_nao_apaga ON %I', t.tablename);

    IF t.tablename NOT LIKE 'tarefas\_%' AND t.tablename NOT IN ('usuarios', 'permissoes_papel') THEN
      EXECUTE format($p$CREATE POLICY tarefas_nao_le ON %I AS RESTRICTIVE FOR SELECT
                        TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'tarefas')$p$, t.tablename);
    END IF;
    EXECUTE format($p$CREATE POLICY tarefas_nao_insere ON %I AS RESTRICTIVE FOR INSERT
                      TO authenticated WITH CHECK (papel_do_usuario() IS DISTINCT FROM 'tarefas')$p$, t.tablename);
    EXECUTE format($p$CREATE POLICY tarefas_nao_altera ON %I AS RESTRICTIVE FOR UPDATE
                      TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'tarefas')$p$, t.tablename);
    EXECUTE format($p$CREATE POLICY tarefas_nao_apaga ON %I AS RESTRICTIVE FOR DELETE
                      TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'tarefas')$p$, t.tablename);
  END LOOP;
END;
$$;

-- ============================================================
-- Migration 020 — Permissões por papel configuráveis
-- ============================================================

CREATE TABLE permissoes_papel (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'gestao', 'producao', 'compras')),
  rotas TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(empresa_id, papel)
);

ALTER TABLE permissoes_papel ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON permissoes_papel
  USING (empresa_id = get_empresa_id_do_usuario());

-- Trigger para updated_at
CREATE TRIGGER set_updated_at_permissoes_papel
  BEFORE UPDATE ON permissoes_papel
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- RPC: inicializar_permissoes_padrao
-- Cria permissões default para uma empresa (se não existem)
-- ============================================================
CREATE OR REPLACE FUNCTION inicializar_permissoes_padrao(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO permissoes_papel (empresa_id, papel, rotas) VALUES
    (p_empresa_id, 'admin', ARRAY['*']),
    (p_empresa_id, 'gestao', ARRAY[
      '/dashboard', '/recebimento', '/transferencia', '/producao',
      '/expedicao', '/perdas', '/contagem', '/relatorios',
      '/estoque', '/insumos', '/fornecedores', '/fichas', '/produtos', '/recipientes',
      '/configuracoes'
    ]),
    (p_empresa_id, 'producao', ARRAY[
      '/dashboard', '/transferencia', '/producao', '/contagem', '/estoque'
    ]),
    (p_empresa_id, 'compras', ARRAY[
      '/dashboard', '/recebimento', '/estoque', '/contagem', '/perdas'
    ])
  ON CONFLICT (empresa_id, papel) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Inicializar para todas as empresas existentes
DO $$
DECLARE
  v_emp RECORD;
BEGIN
  FOR v_emp IN SELECT id FROM empresas LOOP
    PERFORM inicializar_permissoes_padrao(v_emp.id);
  END LOOP;
END $$;

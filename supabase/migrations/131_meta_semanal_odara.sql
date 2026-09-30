-- ============================================================
-- Migration 131 — meta semanal da Odara e estoque na Odara
--
-- A Odara compra os insumos e manda uma entrega por semana (sexta), que tem de
-- cobrir a semana seguinte com folga — é ela que deixa abastecer na sexta os
-- potes da segunda. Quem compra (o Antônio, da Odara) comprava no escuro: não
-- sabia quanto havia aqui, quanto durava, nem quanto pedir (Lucca, 29/09/2026).
--
-- A conta vivia numa planilha. Aqui ficam só os DADOS que ela pedia e o
-- sistema não tinha; a conta é feita na tela (aba "Meta Odara" do Planejador):
--
--   * a meta FIXA por semana, por ficha — hoje 144 formas de Tradicional e 48
--     de Doce de Leite. Não é o plano da semana (planos_semana): é o ritmo
--     combinado, que a compra usa para projetar;
--   * a folga da entrega (20%);
--   * o estoque que a Odara guarda lá — ela tem espaço e compra grande, e
--     manda aos poucos. NULL é "não informado", não zero.

CREATE TABLE IF NOT EXISTS metas_semanais_ficha (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id),
  ficha_id      UUID NOT NULL REFERENCES fichas_tecnicas(id),
  formas_semana INTEGER NOT NULL DEFAULT 0 CHECK (formas_semana >= 0),
  updated_by    UUID REFERENCES usuarios(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, ficha_id)
);

CREATE TABLE IF NOT EXISTS estoque_externo_insumo (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id     UUID NOT NULL REFERENCES empresas(id),
  insumo_id      UUID NOT NULL REFERENCES insumos(id),
  quantidade     NUMERIC CHECK (quantidade IS NULL OR quantidade >= 0),
  atualizado_por UUID REFERENCES usuarios(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, insumo_id)
);

CREATE TRIGGER set_updated_at_metas_semanais_ficha
  BEFORE UPDATE ON metas_semanais_ficha
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at_estoque_externo_insumo
  BEFORE UPDATE ON estoque_externo_insumo
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Mesmo padrão da 049: cada empresa vê só o que é dela.
ALTER TABLE metas_semanais_ficha ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON metas_semanais_ficha
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

ALTER TABLE estoque_externo_insumo ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON estoque_externo_insumo
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS folga_reabastecimento_pct NUMERIC NOT NULL DEFAULT 20
    CHECK (folga_reabastecimento_pct >= 0);

-- A meta de hoje (Lucca, 29/09/2026).
INSERT INTO metas_semanais_ficha (empresa_id, ficha_id, formas_semana)
SELECT f.empresa_id, f.id,
       CASE WHEN f.nome ILIKE '%doce de leite%' THEN 48 ELSE 144 END
  FROM fichas_tecnicas f
 WHERE f.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
   AND f.ativo
   AND f.nome IN ('Brownie Tradicional Odara', 'Brownie Doce de Leite Odara')
ON CONFLICT (empresa_id, ficha_id) DO NOTHING;

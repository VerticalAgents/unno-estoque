-- ============================================================
-- Migration 022 — Dados nutricionais por insumo (por 100g)
-- ============================================================

CREATE TABLE insumos_nutrientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insumo_id UUID NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  energia_kcal DECIMAL DEFAULT 0,
  carboidratos DECIMAL DEFAULT 0,
  acucares_totais DECIMAL DEFAULT 0,
  acucares_adicionados DECIMAL DEFAULT 0,
  proteinas DECIMAL DEFAULT 0,
  gorduras_totais DECIMAL DEFAULT 0,
  gorduras_saturadas DECIMAL DEFAULT 0,
  gorduras_trans DECIMAL DEFAULT 0,
  fibras DECIMAL DEFAULT 0,
  sodio_mg DECIMAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(insumo_id)
);

ALTER TABLE insumos_nutrientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON insumos_nutrientes
  USING (
    insumo_id IN (
      SELECT id FROM insumos
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

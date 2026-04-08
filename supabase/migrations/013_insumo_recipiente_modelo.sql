-- Migration 013: Modelo de recipiente padrão por insumo
-- Armazena o template usado ao criar recipientes para o insumo,
-- permitindo pré-preencher o formulário de criação.

ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS recipiente_subtipo        text,
  ADD COLUMN IF NOT EXISTS recipiente_capacidade_max numeric,
  ADD COLUMN IF NOT EXISTS recipiente_unidade_cap    text;

-- Migration 135a — a bobina de BOPP como tipo de embalagem do fornecedor.
-- Separada da 135b porque o valor novo só pode ser usado depois do commit.
ALTER TYPE tipo_embalagem_fornecedor_enum ADD VALUE IF NOT EXISTS 'bobina';

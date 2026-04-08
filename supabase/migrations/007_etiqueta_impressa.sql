-- ============================================================
-- Migration 007 — Rastreio de etiqueta impressa por lote
-- ============================================================

ALTER TABLE lotes
  ADD COLUMN IF NOT EXISTS etiqueta_impressa BOOLEAN NOT NULL DEFAULT FALSE;

-- Lotes existentes são considerados já impressos (dados legados)
UPDATE lotes SET etiqueta_impressa = TRUE;

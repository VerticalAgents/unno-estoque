-- ============================================================
-- Migration 024 — Fix constraint de versão ativa em fichas técnicas
-- ============================================================
-- A constraint UNIQUE(ficha_id, ativa) impedia múltiplas versões
-- inativas na mesma ficha, quebrando o fluxo de nova versão pela UI.
-- Troca por índice parcial que garante apenas 1 versão ATIVA por ficha.
-- ============================================================

ALTER TABLE fichas_tecnicas_versoes DROP CONSTRAINT IF EXISTS chk_uma_versao_ativa;

CREATE UNIQUE INDEX IF NOT EXISTS chk_uma_versao_ativa
  ON fichas_tecnicas_versoes (ficha_id)
  WHERE ativa = true;

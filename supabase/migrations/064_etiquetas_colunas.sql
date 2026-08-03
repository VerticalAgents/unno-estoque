-- ============================================================
-- Migration 064 — Rolo com mais de uma coluna de etiquetas
--
-- A 063 assumiu que uma página = uma etiqueta. Rolo de etiqueta térmica
-- costuma vir com 2 ou 3 colunas lado a lado: a impressora avança a LINHA
-- inteira, não uma etiqueta. Se a página tem a largura de uma etiqueta só,
-- as outras colunas saem em branco e o alinhamento se perde na segunda linha.
--
-- Três números descrevem o rolo:
--   colunas   — quantas etiquetas cabem lado a lado
--   espaco_mm — o vão entre uma coluna e a seguinte
--   margem_mm — a borda em branco de cada lado do rolo
--
-- A largura do papel passa a ser calculada:
--   2*margem + colunas*largura + (colunas-1)*espaco
--
-- Ex.: 3 colunas de 34mm, vão de 2,5mm, margem de 2mm = 111mm de rolo.
--
-- Defaults (1 coluna, sem vão, sem margem) repetem o comportamento da 063.
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS etiqueta_lote_colunas             INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_espaco_mm           DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_margem_mm           DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_colunas       INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_espaco_mm     DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_margem_mm     DECIMAL(5,1) NOT NULL DEFAULT 0;

COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_colunas IS
  'Quantas etiquetas de lote cabem lado a lado no rolo.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_espaco_mm IS
  'Vão em milímetros entre duas colunas de etiqueta de lote.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_margem_mm IS
  'Borda em branco, em milímetros, de cada lado do rolo de etiqueta de lote.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_colunas IS
  'Quantas etiquetas de recipiente cabem lado a lado no rolo.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_espaco_mm IS
  'Vão em milímetros entre duas colunas de etiqueta de recipiente.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_margem_mm IS
  'Borda em branco, em milímetros, de cada lado do rolo de etiqueta de recipiente.';

ALTER TABLE configuracoes_sistema
  DROP CONSTRAINT IF EXISTS chk_etiqueta_colunas;
ALTER TABLE configuracoes_sistema
  ADD CONSTRAINT chk_etiqueta_colunas CHECK (
    etiqueta_lote_colunas         BETWEEN 1 AND 10 AND
    etiqueta_recipiente_colunas   BETWEEN 1 AND 10 AND
    etiqueta_lote_espaco_mm       BETWEEN 0 AND 50 AND
    etiqueta_recipiente_espaco_mm BETWEEN 0 AND 50 AND
    etiqueta_lote_margem_mm       BETWEEN 0 AND 50 AND
    etiqueta_recipiente_margem_mm BETWEEN 0 AND 50
  );

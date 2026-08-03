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
  'Vao em milimetros entre duas colunas de etiqueta de lote.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_margem_mm IS
  'Borda em branco, em milimetros, de cada lado do rolo de etiqueta de lote.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_colunas IS
  'Quantas etiquetas de recipiente cabem lado a lado no rolo.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_espaco_mm IS
  'Vao em milimetros entre duas colunas de etiqueta de recipiente.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_margem_mm IS
  'Borda em branco, em milimetros, de cada lado do rolo de etiqueta de recipiente.';

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

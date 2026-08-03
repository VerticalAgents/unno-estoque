ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS etiqueta_lote_largura_mm       DECIMAL(6,1) NOT NULL DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_altura_mm        DECIMAL(6,1) NOT NULL DEFAULT 75.0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_largura_mm DECIMAL(6,1) NOT NULL DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_altura_mm  DECIMAL(6,1) NOT NULL DEFAULT 75.0;

COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_largura_mm IS
  'Largura, em milimetros, do papel da etiqueta de lote/sublote (recebimento).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_altura_mm IS
  'Altura, em milimetros, do papel da etiqueta de lote/sublote (recebimento).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_largura_mm IS
  'Largura, em milimetros, do papel da etiqueta de recipiente (balde, caixa, garrafa).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_altura_mm IS
  'Altura, em milimetros, do papel da etiqueta de recipiente (balde, caixa, garrafa).';

ALTER TABLE configuracoes_sistema
  DROP CONSTRAINT IF EXISTS chk_etiqueta_dimensoes;
ALTER TABLE configuracoes_sistema
  ADD CONSTRAINT chk_etiqueta_dimensoes CHECK (
    etiqueta_lote_largura_mm       BETWEEN 10 AND 400 AND
    etiqueta_lote_altura_mm        BETWEEN 10 AND 400 AND
    etiqueta_recipiente_largura_mm BETWEEN 10 AND 400 AND
    etiqueta_recipiente_altura_mm  BETWEEN 10 AND 400
  );

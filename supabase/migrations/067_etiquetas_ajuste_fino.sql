-- ============================================================
-- Migration 067 — Ajuste fino de posição e vão entre linhas
--
-- Impressora de etiqueta nunca começa a imprimir exatamente na borda do
-- papel: cada modelo tem seu deslocamento, e rolo colado à mão sai um pouco
-- torto. Sem um ajuste, a única saída é reconfigurar o driver por tentativa.
--
--   deslocar_x_mm / deslocar_y_mm — empurram TODO o conteúdo impresso, em
--   milímetros. Aceitam negativo (puxar para a esquerda/para cima).
--
-- E falta uma medida do rolo: entre uma LINHA de etiquetas e a seguinte
-- costuma haver um vão. A 064 assumiu que a página tinha exatamente a altura
-- da etiqueta; quando existe vão, a impressão vai escorregando um pouco a
-- cada linha.
--
--   espaco_linha_mm — o vão entre uma linha de etiquetas e a próxima. A
--   altura da página passa a ser altura + espaco_linha.
--
-- Defaults zerados repetem o comportamento da 064.
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS etiqueta_lote_espaco_linha_mm       DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_deslocar_x_mm         DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_deslocar_y_mm         DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_espaco_linha_mm DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_deslocar_x_mm   DECIMAL(5,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_deslocar_y_mm   DECIMAL(5,1) NOT NULL DEFAULT 0;

COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_espaco_linha_mm IS
  'Vão em milímetros entre uma linha de etiquetas de lote e a seguinte no rolo.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_deslocar_x_mm IS
  'Ajuste fino horizontal da impressão da etiqueta de lote, em mm (aceita negativo).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_deslocar_y_mm IS
  'Ajuste fino vertical da impressão da etiqueta de lote, em mm (aceita negativo).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_espaco_linha_mm IS
  'Vão em milímetros entre uma linha de etiquetas de recipiente e a seguinte.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_deslocar_x_mm IS
  'Ajuste fino horizontal da impressão da etiqueta de recipiente, em mm.';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_deslocar_y_mm IS
  'Ajuste fino vertical da impressão da etiqueta de recipiente, em mm.';

ALTER TABLE configuracoes_sistema
  DROP CONSTRAINT IF EXISTS chk_etiqueta_ajuste;
ALTER TABLE configuracoes_sistema
  ADD CONSTRAINT chk_etiqueta_ajuste CHECK (
    etiqueta_lote_espaco_linha_mm       BETWEEN 0 AND 50 AND
    etiqueta_recipiente_espaco_linha_mm BETWEEN 0 AND 50 AND
    etiqueta_lote_deslocar_x_mm         BETWEEN -30 AND 30 AND
    etiqueta_lote_deslocar_y_mm         BETWEEN -30 AND 30 AND
    etiqueta_recipiente_deslocar_x_mm   BETWEEN -30 AND 30 AND
    etiqueta_recipiente_deslocar_y_mm   BETWEEN -30 AND 30
  );

-- ============================================================
-- Migration 063 — Tamanho das etiquetas vira configuração
--
-- Até aqui o tamanho do papel estava escrito no código de três telas
-- (`@page { size: 100mm 75mm }` em ImpressaoEtiquetaPage, ImpressaoLotesPage
-- e EtiquetaRecipientePage). Quem trocasse o rolo da impressora não tinha
-- como avisar o sistema — a etiqueta saía cortada ou sobrando papel.
--
-- Agora são quatro números por empresa, um par para cada tipo de etiqueta.
-- O desenho continua sendo o mesmo, feito para 100x75mm; as telas encolhem
-- ou aumentam o conteúdo até caber no tamanho escolhido, mantendo a
-- proporção (nada estica nem achata).
--
-- Os defaults repetem o que estava no código, então nada muda para quem
-- já usa o sistema até mexer nas Configurações.
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS etiqueta_lote_largura_mm       DECIMAL(6,1) NOT NULL DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS etiqueta_lote_altura_mm        DECIMAL(6,1) NOT NULL DEFAULT 75.0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_largura_mm DECIMAL(6,1) NOT NULL DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_altura_mm  DECIMAL(6,1) NOT NULL DEFAULT 75.0;

COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_largura_mm IS
  'Largura, em milímetros, do papel da etiqueta de lote/sublote (recebimento).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_lote_altura_mm IS
  'Altura, em milímetros, do papel da etiqueta de lote/sublote (recebimento).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_largura_mm IS
  'Largura, em milímetros, do papel da etiqueta de recipiente (balde, caixa, garrafa).';
COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_altura_mm IS
  'Altura, em milímetros, do papel da etiqueta de recipiente (balde, caixa, garrafa).';

-- Um tamanho zerado ou negativo faria a etiqueta sumir na impressão, e um
-- valor absurdo trava o navegador ao gerar o preview. 10mm a 400mm cobre de
-- etiqueta de frasco a folha A3.
ALTER TABLE configuracoes_sistema
  DROP CONSTRAINT IF EXISTS chk_etiqueta_dimensoes;
ALTER TABLE configuracoes_sistema
  ADD CONSTRAINT chk_etiqueta_dimensoes CHECK (
    etiqueta_lote_largura_mm       BETWEEN 10 AND 400 AND
    etiqueta_lote_altura_mm        BETWEEN 10 AND 400 AND
    etiqueta_recipiente_largura_mm BETWEEN 10 AND 400 AND
    etiqueta_recipiente_altura_mm  BETWEEN 10 AND 400
  );

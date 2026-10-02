-- Migration 138 — embalagem não leva etiqueta
--
-- Display, caixa de embarque e BOPP (categoria EMBALAGENS, migration 135b) entram
-- no estoque só para o saldo: ninguém cola etiqueta nem QR code neles (Lucca,
-- 02/10/2026). Sem isto, cada entrega da Odara enchia a fila de "etiquetas a
-- imprimir" e o aviso de lote sem etiqueta do recebimento e do painel.
--
-- O lote de embalagem já nasce com etiqueta_impressa = true. Continua lá, e
-- pode ser impresso pela tela se alguém quiser; só não cobra.

CREATE OR REPLACE FUNCTION embalagem_dispensa_etiqueta()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM insumos i
      JOIN categorias_insumo c ON c.id = i.categoria_id
     WHERE i.id = NEW.insumo_id
       AND upper(c.nome) = 'EMBALAGENS'
  ) THEN
    NEW.etiqueta_impressa := TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_embalagem_dispensa_etiqueta ON lotes;
CREATE TRIGGER trg_embalagem_dispensa_etiqueta
  BEFORE INSERT ON lotes
  FOR EACH ROW EXECUTE FUNCTION embalagem_dispensa_etiqueta();

-- Os que já entraram: saldo inicial de 02/10 e a NF 28390.
UPDATE lotes l
   SET etiqueta_impressa = TRUE
  FROM insumos i
  JOIN categorias_insumo c ON c.id = i.categoria_id
 WHERE l.insumo_id = i.id
   AND upper(c.nome) = 'EMBALAGENS'
   AND NOT l.etiqueta_impressa;

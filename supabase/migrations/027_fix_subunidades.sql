-- ============================================================
-- Migration 027 — Correção das subunidades (confirmado pelo Lucca)
--
-- A migration 026 assumiu a subdivisão das embalagens por analogia,
-- porque a planilha só traz o peso total. Os números reais são:
--   Farinha de Trigo   — fardo 25 kg = 5 unidades de 5 kg (não 25 de 1 kg)
--   Cobertura Ao Leite — caixa 10 kg = 5 unidades de 2 kg (não 10 de 1 kg)
--
-- Nutella conferida e mantida: compra em balde de 3 kg, porcionada em
-- sacos de confeitar de 750 g (recipiente). Já estava correto.
-- ============================================================

UPDATE insumos_embalagem_config
   SET subunidade_quantidade = 5,
       subunidade_peso       = 5
 WHERE insumo_id = (SELECT id FROM insumos WHERE codigo = 'INS002');

UPDATE insumos_embalagem_config
   SET subunidade_quantidade = 5,
       subunidade_peso       = 2
 WHERE insumo_id = (SELECT id FROM insumos WHERE codigo = 'INS012');

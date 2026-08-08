-- ============================================================
-- Migration 072 — Quantas etiquetas cada tipo de recipiente precisa
--
-- Nem todo recipiente precisa de uma etiqueta só. O balde G leva duas — uma
-- no corpo e uma na tampa — senão não há como saber qual tampa é de qual
-- balde depois que empilham na bancada. Já a garrafa de glicerina precisa de
-- uma só, no corpo.
--
-- Isso é característica do TIPO (balde, garrafa, caixa), não de cada
-- recipiente, então mora aqui e não em `locais`: cadastrar o décimo balde não
-- pode obrigar ninguém a lembrar de pedir duas etiquetas.
--
-- JSONB e não uma tabela porque é um punhado de pares tipo→número, lido
-- inteiro de uma vez e sempre junto do resto da configuração de etiqueta.
-- Tipo que não estiver no objeto vale 1.
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS etiqueta_recipiente_copias JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN configuracoes_sistema.etiqueta_recipiente_copias IS
  'Cópias por subtipo de recipiente na impressão em massa: {"balde": 2, ...}. '
  'Ausente = 1. Existe porque balde precisa de etiqueta no corpo e na tampa.';

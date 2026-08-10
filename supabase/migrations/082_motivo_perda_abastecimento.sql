-- ============================================================
-- Migration 082 — Motivo de perda: abastecimento
--
-- A perda do abastecimento é a diferença entre o que saiu das embalagens e o
-- que entrou nos potes: poeira, respingo, o que fica no fundo do saco. Sem um
-- motivo próprio ela cairia em 'outro' e ficaria indistinguível da perda de
-- produção — que é justamente a comparação que interessa.
--
-- Sozinha nesta migration: o Postgres não deixa USAR um valor de enum na mesma
-- transação em que ele é criado.
-- ============================================================

ALTER TYPE motivo_perda_enum ADD VALUE IF NOT EXISTS 'abastecimento';

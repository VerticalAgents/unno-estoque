-- ============================================================
-- Migration 042 — Remove a assinatura antiga de realizar_transferencia
--
-- A 041 criou a versão com `p_justificativa` (6 parâmetros). Como o novo
-- parâmetro tem DEFAULT, uma chamada com 5 argumentos passou a casar com as
-- DUAS versões, e o Postgres recusa por ambiguidade:
--   "function realizar_transferencia(...) is not unique"
--
-- Isso quebraria a tela de transferência, que chama por nome de parâmetro.
-- ============================================================

DROP FUNCTION IF EXISTS realizar_transferencia(UUID, UUID, DECIMAL, UUID, UUID);

-- ============================================================
-- Migration 126a — o modo 'unidade'
--
-- Separada da 126b porque um valor novo de enum só pode ser usado depois do
-- commit que o criou. Ver a 126b para o porquê.

ALTER TYPE modo_ep_enum ADD VALUE IF NOT EXISTS 'unidade';

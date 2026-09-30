-- Migration 134a — valor novo do enum, separado da 134b porque só pode ser
-- usado depois do commit que o criou.
ALTER TYPE papel_usuario_enum ADD VALUE IF NOT EXISTS 'odara';

-- Migration 139a — valor novo do enum, separado da 139b porque só pode ser
-- usado depois do commit que o criou (mesmo motivo da 134a).
ALTER TYPE papel_usuario_enum ADD VALUE IF NOT EXISTS 'tarefas';

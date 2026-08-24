-- ============================================================
-- Migration 109 — o movimento "acerto de recipiente"
--
-- Sozinha nesta migration DE PROPÓSITO. O Postgres recusa usar um valor de
-- enum na mesma transação em que ele é criado ("unsafe use of new value"), e a
-- 110 usa este valor dentro da `registrar_abastecimento`. Juntas, a migration
-- não passaria nem no teste em `begin … rollback`.
--
-- O QUE ELE REGISTRA. A balança do recipiente discordou do saldo que o sistema
-- supunha, e o saldo cedeu. Não é perda — nada sumiu do mundo, o sistema é que
-- estava errado sobre quanto havia no balde. E não é ajuste de inventário —
-- ninguém digitou um número novo à mão; uma balança foi lida.
--
-- Ter tipo próprio é o que permite ao painel de perdas continuar respondendo
-- "quanto a fábrica perdeu" sem misturar isso com "o quanto o teórico erra".
-- ============================================================

ALTER TYPE tipo_movimentacao_enum ADD VALUE IF NOT EXISTS 'acerto_recipiente';

-- ============================================================
-- Migration 133 — as funções da página Dev Tools saem do banco
--
-- A página saiu do app em 29/09/2026 (pedido do Lucca). As funções ficavam:
-- qualquer usuário logado ainda podia chamá-las pelo nome — e três delas
-- (limpar estoque, limpar movimento, esvaziar recipientes) apagam dado de
-- verdade. Continuam no histórico das migrations, caso um dia sejam precisas.

DROP FUNCTION IF EXISTS public.dev_encher_recipientes(uuid);
DROP FUNCTION IF EXISTS public.dev_encher_estoque_central(uuid, uuid, integer, numeric);
DROP FUNCTION IF EXISTS public.dev_encher_tudo(uuid, uuid);
DROP FUNCTION IF EXISTS public.dev_criar_sessao_pos_producao(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.dev_limpar_sessoes_teste(uuid);
DROP FUNCTION IF EXISTS public.dev_limpar_movimento(uuid);
DROP FUNCTION IF EXISTS public.dev_limpar_estoque(uuid);
DROP FUNCTION IF EXISTS public.dev_esvaziar_recipientes(uuid);

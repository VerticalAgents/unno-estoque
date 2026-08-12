-- ============================================================
-- Migration 091 — A fila da pós-produção passa a respeitar o RLS
--
-- Achado ao conferir as opções das views depois da 090: de nove views, oito
-- têm `security_invoker = true` e uma não — a `v_pos_producao_pendente`.
--
-- Não é regressão da 089 nem da 090. A 050 ligou a opção em todas as views que
-- existiam naquele dia, e a fila da pós só nasceu na 054, quatro migrations
-- depois. Passou em branco desde então.
--
-- Sem `security_invoker`, a view roda com os privilégios de quem a criou e as
-- políticas de RLS das tabelas por baixo não são aplicadas. A tela filtra por
-- empresa antes de mostrar, mas isso é educação do cliente, não trava: quem
-- chamasse a API com outro `empresa_id` veria as sessões de outra padaria.
-- ============================================================

ALTER VIEW v_pos_producao_pendente SET (security_invoker = true);

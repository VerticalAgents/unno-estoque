-- ============================================================
-- Migration 120 — o recipiente também sabe se já foi etiquetado
--
-- O PEDIDO DO LUCCA, em 09/09/2026: um lugar só onde ficam todas as etiquetas
-- que nunca foram impressas, com um botão para imprimir todas de uma vez.
--
-- O lote já sabia responder isso (`lotes.etiqueta_impressa`). O recipiente não
-- sabia — e é justamente o caso que gerou o pedido: seis potes novos foram
-- criados hoje e não havia como a tela saber que faltava etiqueta neles. Sem
-- etiqueta colada o pote existe no sistema e não existe na bancada: ninguém
-- consegue bipar.
--
-- ------ O que a coluna significa -----------------------------
--
-- `false` = nunca foi mandado para a impressora. NÃO é "não tem etiqueta
-- colada": o sistema não tem como saber se o papel saiu, se colou ou se caiu.
-- É o mesmo limite que `lotes.etiqueta_impressa` já tem, e continua valendo o
-- alerta: a marca é feita no CLIQUE, então impressora travada deixa o pote
-- marcado como impresso sem papel nenhum. Reimprimir sempre é possível.
--
-- ------ Por que os antigos nascem `true` ---------------------
--
-- Os recipientes que já estavam em uso ontem estão etiquetados de fato — são
-- bipados todo dia na transferência, o que só é possível com a etiqueta na
-- mão. Nascerem `false` encheria a tela nova com 70 potes que não precisam de
-- nada, e uma lista de pendências que começa cheia de coisa resolvida é uma
-- lista que ninguém olha.
--
-- O corte é por data de criação: tudo que existia antes de hoje vale como
-- impresso. Os seis potes de hoje ficam pendentes, que é o estado verdadeiro.
-- ============================================================

ALTER TABLE locais
  ADD COLUMN IF NOT EXISTS etiqueta_impressa BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN locais.etiqueta_impressa IS
  'Já foi mandado para a impressora ao menos uma vez. Marcado no clique de '
  'imprimir, não na saída do papel — impressora travada deixa marcado sem '
  'etiqueta. Alimenta a tela de etiquetas pendentes.';

-- Os que já eram usados ontem estão etiquetados: são bipados todo dia.
UPDATE locais
   SET etiqueta_impressa = true
 WHERE created_at < date_trunc('day', now())
   AND NOT etiqueta_impressa;

-- A embalagem do fornecedor nunca aparece nesta lista: ela usa a etiqueta do
-- LOTE, colada desde o recebimento, e não tem etiqueta própria (migration
-- 073). Marcar como impressa é o jeito de dizer "aqui não falta nada".
UPDATE locais
   SET etiqueta_impressa = true
 WHERE efemero AND NOT etiqueta_impressa;

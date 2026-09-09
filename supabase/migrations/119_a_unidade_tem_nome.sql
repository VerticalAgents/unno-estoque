-- ============================================================
-- Migration 119 — a unidade de dentro da embalagem tem nome
--
-- O PEDIDO DO LUCCA, em 09/09/2026: o óleo era registrado em gramas, e o
-- operador tinha de pesar para dizer quanto voltou ao estoque. Mas óleo sai em
-- garrafa fechada: pegou 10 de uma caixa de 20, voltaram 10. Nunca meia.
--
-- O sistema já sabia perguntar por unidade — é `insumos.tamanho_subembalagem`,
-- que faz a tela de transferência trocar "quanto ficou (kg)" por "quantos
-- pacotes ficaram". O açúcar usa isso desde sempre: 10 sacos de 1 kg no fardo.
-- Faltava o cadastro do óleo, que foi feito junto: 810 g por garrafa, 20 por
-- caixa de 16,2 kg.
--
-- O que esta migration acrescenta é só o NOME da unidade. A tela dizia
-- "pacotes" para tudo, e pacote de óleo não existe — existe garrafa. Numa tela
-- que o operador usa correndo, chamar a coisa pelo nome errado é o mesmo que
-- não perguntar.
--
-- ------ Por que não é rastreio por sub-unidade -----------------
--
-- Isto NÃO é criar identidade para cada garrafa, e a distinção importa porque
-- a tentação já custou trabalho antes: 15 "recipientes" de saco de confeitar
-- foram criados e desfeitos por isso, e `lotes_unidades` existe vazia de
-- propósito (migration 074). Aqui não nasce linha nenhuma por garrafa. O que
-- muda é a UNIDADE EM QUE A PERGUNTA É FEITA; o banco continua guardando
-- quilos, e "quantas cabem" continua sendo conta, não cadastro.
--
-- ------ E por que contar é mais exato do que pesar -------------
--
-- Das 18 caixas de óleo recebidas, 8 estão com peso inflado — há caixa de
-- 16,2 kg registrada com 18,257. Todas foram ALTERADAS depois de criadas, na
-- transferência: quando a balança do recipiente lê mais do que o previsto, o
-- sistema aumenta a quantidade do lote. É o mesmo defeito do fardo de farinha
-- que apareceu com 25,124 kg.
--
-- Contar garrafa não corrige as 8 caixas antigas — isso é assunto da auditoria
-- —, mas remove o passo que inflava o número.
-- ============================================================

ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS nome_subembalagem TEXT;

COMMENT ON COLUMN insumos.nome_subembalagem IS
  'Como a tela chama a unidade de dentro da embalagem, no plural: "garrafas", '
  '"sacos", "latas". NULL cai em "pacotes". Só faz sentido junto de '
  'tamanho_subembalagem — sem ele a tela pergunta em peso e este nome não '
  'aparece em lugar nenhum.';

-- Os dois que têm unidade contável hoje.
UPDATE insumos SET nome_subembalagem = 'garrafas', updated_at = now()
 WHERE codigo = 'INS006' AND tamanho_subembalagem IS NOT NULL;

UPDATE insumos SET nome_subembalagem = 'sacos', updated_at = now()
 WHERE codigo = 'INS001' AND tamanho_subembalagem IS NOT NULL;

-- ============================================================
-- Migration 089b — Os dois lotes de produto que nasceram na regra antiga
--
-- A 089 mudou onde o lote nasce. Restam os dois que já existiam, cada um
-- pedindo uma coisa diferente:
--
--   LPROD-0001 (SESS-0001, pós registrada em 12/08). Existe e está certo em
--   quantidade. Só a validade estava contada da produção: 08/12 onde deveriam
--   ser 10/12. Mesmos 120 dias, contados do dia certo.
--
--   LPROD-0002 (SESS-0002, 3.600 un). A pós dessa sessão ainda não foi
--   registrada — pela regra nova ele não deveria existir. Sai daqui e volta
--   pela tela da pós-produção, dividido entre o que foi desenformado no dia 11
--   e o que ficou para o dia 12. É o caso que motivou tudo isto.
--
-- A condição de "intocado" é explícita nas duas. Lote que já teve saída fica
-- onde está — nenhuma linha que circulou some por causa de uma migration.
-- ============================================================

UPDATE lotes_produto lp
   SET data_desenforma = pp.data,
       validade        = pp.data + COALESCE(pr.validade_dias, 365)
  FROM pos_producao pp, produtos pr
 WHERE pp.sessao_id = lp.sessao_id
   AND pr.id = lp.produto_id
   AND lp.data_desenforma IS NULL;

DELETE FROM lotes_produto lp
 WHERE NOT EXISTS (SELECT 1 FROM pos_producao pp WHERE pp.sessao_id = lp.sessao_id)
   AND lp.quantidade_disponivel = lp.quantidade_produzida
   AND NOT EXISTS (SELECT 1 FROM expedicoes_itens ei WHERE ei.lote_produto_id = lp.id);

-- ============================================================
-- Migration 095 — As perdas por dia, e as metas
--
-- A página de Perdas é uma lista de totais, e total não aponta nada. O que o
-- usuário quer dela é diagnóstico: *"se em algum momento eu passar a ter mta
-- perda por brownie queimado, pode indicar que preciso dar uma atenção pra
-- manutenção de termostato do forno"*.
--
-- Isso só virou possível na 092, quando o descarte deixou de ser um monte por
-- sessão e passou a ter DIA e MOTIVO. Agora dá para ver a participação de cada
-- motivo mudar ao longo do tempo — que é o sinal que chega antes do total.
--
-- DUAS VIEWS, NÃO UMA. O denominador (unidades que saíram do forno) mora na
-- parte; os motivos são N por parte. Uma view só, com JOIN direto, multiplicaria
-- o denominador pelo número de motivos do dia — o mesmo produto cartesiano que
-- a 087 teve de desfazer, e que aqui apareceria como perda menor do que a real.
-- Por isso o total do dia sai numa view e os motivos noutra, cruzados por data
-- na tela.
--
-- O QUE NÃO ESTÁ AQUI. Perda de insumo continua vindo de `v_perda_auditoria`
-- (066), por auditoria e não por semana: duas auditorias podem estar a dez dias
-- ou a um mês de distância, e encaixá-las em semanas inventaria pontos que
-- ninguém mediu.
-- ============================================================

-- ── As metas ────────────────────────────────────────────────
-- Nulo é "sem meta": a tela mostra o número sem linha de referência, em vez de
-- fingir que a meta é zero e pintar tudo de vermelho.
ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS meta_perda_insumo_pct  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS meta_perda_produto_pct NUMERIC(5,2);

COMMENT ON COLUMN configuracoes_sistema.meta_perda_insumo_pct IS
  'Meta de perda de insumo, em %, medida na auditoria de estoque. Nulo = sem meta.';
COMMENT ON COLUMN configuracoes_sistema.meta_perda_produto_pct IS
  'Meta de descarte de produto, em %, medida na desenforma. Nulo = sem meta.';

-- ── O dia de desenforma, com o denominador ──────────────────
CREATE OR REPLACE VIEW v_perda_produto_dia AS
SELECT pp.empresa_id,
       pt.data_desenforma                                        AS data,
       sp.id                                                     AS sessao_id,
       sp.codigo                                                 AS sessao_codigo,
       ft.id                                                     AS ficha_id,
       ft.nome                                                   AS ficha_nome,
       pt.formas,
       (pt.formas * COALESCE(fv.rendimento_fornada, 0))          AS no_forno,
       dq.q                                                      AS descartadas,
       GREATEST(pt.formas * COALESCE(fv.rendimento_fornada, 0) - dq.q, 0) AS aproveitadas,
       CASE
         WHEN pt.formas * COALESCE(fv.rendimento_fornada, 0) > 0
           THEN ROUND(dq.q::NUMERIC * 100
                      / (pt.formas * COALESCE(fv.rendimento_fornada, 0)), 2)
         ELSE NULL
       END                                                       AS perda_pct
  FROM pos_producao_partes pt
  JOIN pos_producao pp            ON pp.id = pt.pos_id
  JOIN sessoes_producao sp        ON sp.id = pp.sessao_id
  JOIN sessoes_producao_skus sk   ON sk.id = pt.sessao_sku_id
  JOIN fichas_tecnicas ft         ON ft.id = sk.ficha_tecnica_id
  LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
  -- LATERAL, e não JOIN com os descartes: aqui o denominador tem de sobreviver
  -- inteiro, sem se multiplicar pelo número de motivos do dia.
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(d.quantidade), 0)::INTEGER AS q
      FROM pos_producao_descartes d WHERE d.parte_id = pt.id
  ) dq;

COMMENT ON VIEW v_perda_produto_dia IS
  'Cada dia de desenforma: quantas formas foram abertas, quantas unidades '
  'saíram do forno, quantas foram descartadas e o rendimento do dia.';

-- ── O motivo, dia a dia ─────────────────────────────────────
CREATE OR REPLACE VIEW v_perda_produto_motivo AS
SELECT pp.empresa_id,
       pt.data_desenforma AS data,
       m.id               AS motivo_id,
       m.nome             AS motivo,
       m.ordem            AS motivo_ordem,
       ft.id              AS ficha_id,
       ft.nome            AS ficha_nome,
       SUM(d.quantidade)::INTEGER AS quantidade
  FROM pos_producao_descartes d
  JOIN pos_producao_partes pt   ON pt.id = d.parte_id
  JOIN pos_producao pp          ON pp.id = pt.pos_id
  JOIN motivos_descarte m       ON m.id = d.motivo_id
  JOIN sessoes_producao_skus sk ON sk.id = pt.sessao_sku_id
  JOIN fichas_tecnicas ft       ON ft.id = sk.ficha_tecnica_id
 GROUP BY pp.empresa_id, pt.data_desenforma, m.id, m.nome, m.ordem, ft.id, ft.nome;

COMMENT ON VIEW v_perda_produto_motivo IS
  'Quantas unidades foram descartadas por motivo em cada dia de desenforma. '
  'O denominador NÃO está aqui: ele vive em v_perda_produto_dia, e juntar os '
  'dois numa view só multiplicaria as unidades do forno pelo nº de motivos.';

-- MEDIDO na 092: qualquer CREATE OR REPLACE VIEW apaga o security_invoker.
ALTER VIEW v_perda_produto_dia    SET (security_invoker = true);
ALTER VIEW v_perda_produto_motivo SET (security_invoker = true);

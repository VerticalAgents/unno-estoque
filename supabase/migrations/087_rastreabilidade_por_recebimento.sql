-- ============================================================
-- Migration 087 — Rastreabilidade por recebimento, não por pacote
--
-- O QUE INCOMODAVA. A produção gravava o SUBLOTE: "INS001-0002.4/17", o saco
-- número 4 de 17. Mas os 17 sacos são indistinguíveis para o sistema — mesmo
-- fornecedor, mesma nota, mesma data de recebimento, mesma validade, mesma
-- marca. E o lote do FABRICANTE não é registrado em lugar nenhum. Dizer "foi o
-- saco 4" não leva a nada que "foi o recebimento 0002" já não levasse, e uma
-- produção que usa três sacos rendia três linhas idênticas.
--
-- Numa chamada de recall a unidade é o recebimento, não o pacote.
--
-- O VÍNCULO FINO CONTINUA GRAVADO. `sessoes_producao_locais.lote_id` segue
-- apontando para o sublote; o que muda é a LEITURA. Agrupar na leitura é
-- reversível, apagar o vínculo não seria — e se um dia o lote do fabricante
-- passar a ser registrado saco a saco, a granularidade ainda está lá.
--
-- O sublote continua sendo a unidade que se bipa no estoque central e a que
-- carrega a "embalagem aberta" do FEFO. Isso não muda.
--
-- ── E UM DEFEITO QUE APARECEU NO CAMINHO ──────────────────
--
-- A view fazia PRODUTO CARTESIANO entre as fichas da sessão e os recipientes:
-- `JOIN sessoes_producao_skus` e `JOIN sessoes_producao_locais` pendurados no
-- mesmo `sp.id`, sem relação entre si. Com duas fichas, cada linha de insumo
-- saía duplicada e o consumo lido dobrava.
--
-- Medido antes de consertar, numa sessão de teste com duas fichas: 62 linhas
-- onde existiam 31, e o Açúcar Refinado somando 8,248 kg quando o consumo real
-- era 4,124. Com três fichas seria o triplo.
--
-- A correção é agregar as fichas ANTES de cruzar com os recipientes: os
-- produtos e as quantidades pertencem à sessão, não a cada linha de insumo.
--
-- DROP + CREATE, e não CREATE OR REPLACE, porque `lote_id` sai e
-- `lote_grupo_id` entra — replace não renomeia coluna. Por isso o
-- `security_invoker` precisa ser religado logo abaixo: sem ele a view roda com
-- os poderes do dono e passa por cima do RLS (migration 050).
-- ============================================================

DROP VIEW IF EXISTS v_rastreabilidade_producao;

CREATE VIEW v_rastreabilidade_producao AS
WITH producao AS (
  -- As fichas da sessão, resolvidas ANTES do cruzamento com os recipientes.
  SELECT sp.id                                 AS sessao_id,
         sp.data_producao,
         sp.codigo                             AS sessao_codigo,
         sp.aberta_por,
         sp.fechada_por,
         string_agg(DISTINCT ft.nome, ', ')    AS produto_final,
         SUM(spsku.quantidade_produzida)       AS quantidade_produzida,
         SUM(spsku.quantidade_perdida)         AS quantidade_perdida
    FROM sessoes_producao sp
    JOIN sessoes_producao_skus spsku ON spsku.sessao_id = sp.id
    JOIN fichas_tecnicas ft          ON ft.id = spsku.ficha_tecnica_id
   WHERE sp.status = 'fechada'
   GROUP BY sp.id, sp.data_producao, sp.codigo, sp.aberta_por, sp.fechada_por
)
SELECT
  p.data_producao,
  p.sessao_codigo,
  p.produto_final,
  p.quantidade_produzida,
  p.quantidade_perdida,
  ROUND(
    CASE WHEN p.quantidade_produzida > 0
         THEN p.quantidade_perdida::NUMERIC / p.quantidade_produzida::NUMERIC * 100
         ELSE 0 END, 2)                          AS fator_perda_pct,
  i.nome                                         AS insumo,
  l.lote_grupo_id,
  -- O código do recebimento é o do sublote sem o sufixo ".i/N". Conferido nos
  -- 153 lotes: nenhum grupo com prefixo ambíguo, nenhum prefixo repetido entre
  -- grupos, nenhum código com dois pontos.
  MIN(split_part(l.codigo, '.', 1))              AS lote_codigo,
  COUNT(DISTINCT l.id)                           AS sublotes,
  SUM(spl.consumo_real)                          AS consumo_real,
  SUM(spl.consumo_teorico)                       AS consumo_teorico,
  SUM(spl.desvio)                                AS desvio,
  string_agg(DISTINCT loc.nome, ', ' ORDER BY loc.nome) AS recipiente_ep,
  p.aberta_por                                   AS aberto_por_id,
  p.fechada_por                                  AS fechado_por_id
FROM producao p
JOIN sessoes_producao_locais spl ON spl.sessao_id = p.sessao_id
JOIN insumos i                   ON i.id  = spl.insumo_id
JOIN lotes l                     ON l.id  = spl.lote_id
JOIN locais loc                  ON loc.id = spl.local_id
GROUP BY p.data_producao, p.sessao_codigo, p.produto_final,
         p.quantidade_produzida, p.quantidade_perdida,
         i.nome, l.lote_grupo_id, p.aberta_por, p.fechada_por
-- Recebimento que estava no pote mas não foi consumido não entrou no produto.
-- Listá-lo faria uma chamada de recall apontar para uma entrega inocente.
HAVING COALESCE(SUM(spl.consumo_real), 0) > 0
ORDER BY p.data_producao DESC, p.produto_final, i.nome;

-- Sem isto a view roda como o dono e ignora o RLS (migration 050).
ALTER VIEW v_rastreabilidade_producao SET (security_invoker = true);

COMMENT ON VIEW v_rastreabilidade_producao IS
  'Uma linha por sessão × insumo × LOTE DE RECEBIMENTO, só do que foi de fato '
  'consumido. Os sublotes são somados: os pacotes de uma mesma entrada são '
  'indistinguíveis, e a unidade de recall é o recebimento. A coluna sublotes '
  'diz quantos pacotes entraram.';

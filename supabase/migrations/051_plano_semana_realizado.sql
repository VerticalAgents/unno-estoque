-- ============================================================
-- Migration 051 — O realizado também precisa mostrar o que não foi planejado
--
-- A `v_plano_semana` da 049 partia dos itens do plano e pendurava o realizado
-- ao lado. Isso responde "cumpri o que planejei?" mas é cego para o outro lado
-- da pergunta: produção que aconteceu num dia sem estar no plano simplesmente
-- não aparecia.
--
-- Numa comparação planejado × realizado isso é meia verdade — e a metade que
-- some é justamente a que explica por que o insumo acabou antes.
--
-- Agora a view é um FULL OUTER JOIN entre o que foi planejado e o que foi
-- produzido dentro da semana de cada plano. Linha sem plano vem com
-- `fora_do_plano = true`.
-- ============================================================

DROP VIEW IF EXISTS v_plano_semana;

CREATE VIEW v_plano_semana AS
WITH realizado AS (
  SELECT s.empresa_id,
         s.data_producao              AS data,
         sk.ficha_tecnica_id          AS ficha_id,
         SUM(sk.multiplicador)        AS formas,
         SUM(sk.quantidade_produzida) AS unidades,
         BOOL_OR(s.status = 'aberta') AS aberta
    FROM sessoes_producao s
    JOIN sessoes_producao_skus sk ON sk.sessao_id = s.id
   WHERE s.status <> 'cancelada'
   GROUP BY s.empresa_id, s.data_producao, sk.ficha_tecnica_id
),
-- Cada produção é atribuída à semana que a contém — e só entra se existir
-- plano para aquela semana. Produção de semana sem plano não tem com o que
-- ser comparada.
realizado_na_semana AS (
  SELECT p.id AS plano_id, p.empresa_id, p.semana_inicio,
         r.data, r.ficha_id, r.formas, r.unidades, r.aberta
    FROM realizado r
    JOIN planos_semana p
      ON p.empresa_id = r.empresa_id
     AND r.data BETWEEN p.semana_inicio AND p.semana_inicio + 6
),
planejado AS (
  SELECT p.id AS plano_id, p.empresa_id, p.semana_inicio,
         i.data, i.ficha_id, i.formas
    FROM planos_semana p
    JOIN planos_semana_itens i ON i.plano_id = p.id
)
SELECT
  COALESCE(pl.plano_id,      rl.plano_id)      AS plano_id,
  COALESCE(pl.empresa_id,    rl.empresa_id)    AS empresa_id,
  COALESCE(pl.semana_inicio, rl.semana_inicio) AS semana_inicio,
  COALESCE(pl.data,          rl.data)          AS data,
  COALESCE(pl.ficha_id,      rl.ficha_id)      AS ficha_id,
  f.codigo AS ficha_codigo,
  f.nome   AS ficha_nome,
  COALESCE(pl.formas, 0)                                       AS formas_planejadas,
  (COALESCE(pl.formas, 0) * COALESCE(v.rendimento_fornada, 0))::INTEGER
                                                               AS unidades_planejadas,
  -- NULL, e não zero: nada aconteceu ainda é diferente de aconteceu zero
  rl.formas                                                    AS formas_realizadas,
  rl.unidades                                                  AS unidades_produzidas,
  COALESCE(rl.aberta, false)                                   AS em_andamento,
  (pl.plano_id IS NULL)                                        AS fora_do_plano
FROM planejado pl
FULL OUTER JOIN realizado_na_semana rl
  ON  rl.plano_id = pl.plano_id
  AND rl.data     = pl.data
  AND rl.ficha_id = pl.ficha_id
JOIN fichas_tecnicas f
  ON f.id = COALESCE(pl.ficha_id, rl.ficha_id)
LEFT JOIN fichas_tecnicas_versoes v
  ON v.ficha_id = COALESCE(pl.ficha_id, rl.ficha_id) AND v.ativa;

-- Recriar a view perde as opções: sem esta linha ela volta a ser legível sem
-- login (ver migration 050).
ALTER VIEW v_plano_semana SET (security_invoker = true);

COMMENT ON VIEW v_plano_semana IS
  'Planejado × realizado da semana. Inclui produção que aconteceu sem estar no '
  'plano (fora_do_plano = true). Realizado NULL = ainda não aconteceu.';

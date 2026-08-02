-- ============================================================
-- Migration 039 — Quais recipientes abastecer, e em que ordem
--
-- O planejador já diz QUANTOS potes e COM QUAIS LOTES. Falta dizer EM QUAIS
-- POTES — que é a instrução que o operador do abastecimento realmente segue.
--
-- CONTEXTO DA OPERAÇÃO (define o algoritmo)
-- O reabastecimento é diário: enche-se mais ou menos o que será consumido no
-- dia seguinte. Não se abastece para a semana porque não há espaço físico —
-- a padaria já está no limite de recipientes.
--
-- Consequência: o algoritmo é conservador. Ele COMPLETA os potes que já têm o
-- insumo antes de mandar encher pote novo, e para assim que a necessidade do
-- dia estiver coberta. Sugerir pote a mais custa espaço que não existe.
--
-- A ordem entregue é a ordem de trabalho: primeiro item da lista, primeiro
-- pote a encher.
-- ============================================================

CREATE OR REPLACE FUNCTION planejar_abastecimento(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id        UUID,
  insumo_codigo    TEXT,
  insumo_nome      TEXT,
  unidade          TEXT,
  falta_transferir DECIMAL,
  ordem            INTEGER,
  local_id         UUID,
  local_nome       TEXT,
  qr_code_fixo     TEXT,
  ja_tem           DECIMAL,
  capacidade       DECIMAL,
  espaco_livre     DECIMAL,
  colocar          DECIMAL,
  completa_pote    BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH plano AS (
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           COALESCE((e->>'formas')::DECIMAL, 0) AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::DECIMAL, 0) > 0
  ),
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  no_ep AS (
    SELECT l.insumo_id AS ins_id, SUM(ll.quantidade) AS qtd
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id AND ll.quantidade > 0
     GROUP BY l.insumo_id
  ),
  necessidade AS (
    SELECT d.ins_id,
           GREATEST(d.qtd - COALESCE(n.qtd, 0), 0) AS falta
      FROM demanda_insumo d
      LEFT JOIN no_ep n ON n.ins_id = d.ins_id
     WHERE GREATEST(d.qtd - COALESCE(n.qtd, 0), 0) > 0
  ),
  -- Ordem de preferência: completar pote já em uso antes de abrir pote novo.
  -- Entre iguais, o de maior espaço livre primeiro (menos viagens).
  potes AS (
    SELECT
      c.local_id, c.local_nome, c.qr_code_fixo, c.insumo_id AS ins_id,
      c.quantidade_total AS ja_tem,
      c.capacidade_max   AS capacidade,
      c.espaco_livre,
      ROW_NUMBER() OVER (
        PARTITION BY c.insumo_id
        ORDER BY (c.quantidade_total > 0) DESC,  -- já em uso primeiro
                 c.espaco_livre DESC,
                 c.local_nome
      ) AS pos,
      -- quanto já foi coberto pelos potes anteriores da fila
      COALESCE(SUM(c.espaco_livre) OVER (
        PARTITION BY c.insumo_id
        ORDER BY (c.quantidade_total > 0) DESC, c.espaco_livre DESC, c.local_nome
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0) AS acum_antes
    FROM v_recipientes_composicao c
    WHERE c.empresa_id = p_empresa_id
      AND c.espaco_livre > 0
  )
  SELECT
    i.id,
    i.codigo::TEXT,
    i.nome::TEXT,
    i.unidade_medida::TEXT,
    ROUND(nec.falta, 3),
    p.pos::INTEGER,
    p.local_id,
    p.local_nome::TEXT,
    p.qr_code_fixo::TEXT,
    ROUND(p.ja_tem, 3),
    p.capacidade,
    ROUND(p.espaco_livre, 3),
    -- coloca o que ainda falta, limitado ao que cabe neste pote
    ROUND(LEAST(p.espaco_livre, nec.falta - p.acum_antes), 3),
    (p.espaco_livre <= nec.falta - p.acum_antes)  -- este pote sai cheio
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  JOIN potes p   ON p.ins_id = nec.ins_id
  -- para na hora que a necessidade do dia foi coberta: espaço é escasso
  WHERE p.acum_antes < nec.falta
  ORDER BY i.codigo, p.pos;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION planejar_abastecimento IS
  'Dado o plano de produção, diz em QUAIS recipientes colocar e quanto em cada '
  'um, na ordem em que devem ser abastecidos. Completa potes já em uso antes de '
  'abrir pote novo, porque o espaço físico é o recurso escasso.';

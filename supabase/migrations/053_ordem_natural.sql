-- ============================================================
-- Migration 053 — A ordem de pegar no estoque estava em ordem alfabética
--
-- O PROBLEMA
-- A folha mandava pegar os sublotes nesta ordem:
--
--   INS001-0001.1/12
--   INS001-0001.10/12
--   INS001-0001.11/12
--   INS001-0001.12/12
--
-- Não é aleatório: é ordem de texto, e em texto "10" vem logo depois de "1".
-- O sublote .2 iria para o fim da fila. Quem está no estoque com a folha na
-- mão lê isso como bagunça — e é.
--
-- O mesmo acontecia com os recipientes: Nutella #1, #10, #11 … #15, #2, #3.
-- Com 15 sacos de confeitar, a lista fica embaralhada.
--
-- A CORREÇÃO
-- `chave_natural` transforma cada corrida de dígitos num número de largura
-- fixa antes de comparar, então "2" passa a vir antes de "10". É o que se
-- chama de ordenação natural.
--
-- Não muda o FEFO: validade continua mandando. A chave só resolve o empate,
-- que é justamente onde estava a bagunça — todos os sublotes de um mesmo
-- recebimento têm a mesma validade.
-- ============================================================

CREATE OR REPLACE FUNCTION chave_natural(p_texto TEXT)
RETURNS TEXT AS $$
  SELECT COALESCE(
    string_agg(
      CASE WHEN parte ~ '^\d+$' THEN lpad(parte, 9, '0') ELSE parte END,
      '' ORDER BY ord
    ), '')
  FROM regexp_matches(COALESCE(p_texto, ''), '\d+|\D+', 'g')
         WITH ORDINALITY AS t(m, ord),
       LATERAL (SELECT m[1]) AS x(parte)
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION chave_natural IS
  'Chave de ordenação natural: preenche os números com zeros à esquerda para '
  'que 2 venha antes de 10. Use em ORDER BY de códigos e nomes numerados.';

-- ============================================================
-- sugerir_lotes_transferencia — mesma lógica, ordem arrumada
-- ============================================================
DROP FUNCTION IF EXISTS sugerir_lotes_transferencia(UUID, JSONB);

CREATE OR REPLACE FUNCTION sugerir_lotes_transferencia(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id         UUID,
  insumo_codigo     TEXT,
  insumo_nome       TEXT,
  unidade           TEXT,
  alvo              DECIMAL,
  lote_id           UUID,
  lote_codigo       TEXT,
  validade          DATE,
  dias_para_vencer  INTEGER,
  saldo_do_lote     DECIMAL,
  ja_estava_aberto  BOOLEAN,
  levar             DECIMAL,
  volta_aberto      DECIMAL
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
    SELECT it.insumo_id AS ins_id, SUM(it.quantidade * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  potes_insumo AS (
    SELECT c.insumo_id AS ins_id,
           SUM(c.quantidade_total)            AS conteudo,
           SUM(COALESCE(c.capacidade_max, 0)) AS capacidade
      FROM v_recipientes_composicao c
     WHERE c.empresa_id = p_empresa_id
     GROUP BY c.insumo_id
  ),
  necessidade AS (
    SELECT d.ins_id,
           GREATEST(COALESCE(pi.capacidade, 0) - COALESCE(pi.conteudo, 0), 0) AS alvo
      FROM demanda_insumo d
      LEFT JOIN potes_insumo pi ON pi.ins_id = d.ins_id
     WHERE COALESCE(pi.conteudo, 0) < d.qtd
       AND GREATEST(COALESCE(pi.capacidade, 0) - COALESCE(pi.conteudo, 0), 0) > 0
  ),
  lotes_fila AS (
    SELECT
      l.id, l.insumo_id AS ins_id, l.codigo, l.validade_pos_abertura,
      l.quantidade_disponivel,
      (l.quantidade_disponivel < l.quantidade_recebida) AS aberto,
      COALESCE(SUM(l.quantidade_disponivel) OVER (
        PARTITION BY l.insumo_id
        -- aberto primeiro, depois FEFO, e o empate resolvido em ordem natural
        ORDER BY (l.quantidade_disponivel < l.quantidade_recebida) DESC,
                 l.validade_pos_abertura, chave_natural(l.codigo)
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0) AS acum_antes
      FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.status = 'ativo'
       AND l.quantidade_disponivel > 0
  )
  SELECT
    i.id,
    i.codigo::TEXT,
    i.nome::TEXT,
    i.unidade_medida::TEXT,
    ROUND(nec.alvo, 3),
    lf.id,
    lf.codigo::TEXT,
    lf.validade_pos_abertura,
    (lf.validade_pos_abertura - CURRENT_DATE)::INTEGER,
    lf.quantidade_disponivel,
    lf.aberto,
    ROUND(LEAST(lf.quantidade_disponivel, nec.alvo - lf.acum_antes), 3),
    ROUND(GREATEST(lf.quantidade_disponivel - (nec.alvo - lf.acum_antes), 0), 3)
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  LEFT JOIN lotes_fila lf
    ON lf.ins_id = nec.ins_id
   AND lf.acum_antes < nec.alvo
  ORDER BY chave_natural(i.codigo),
           lf.aberto DESC NULLS LAST,
           lf.validade_pos_abertura NULLS LAST,
           chave_natural(lf.codigo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION sugerir_lotes_transferencia IS
  'Quais lotes levar para encher os recipientes. Esgota o lote já aberto antes '
  'de qualquer outro; depois lotes inteiros em FEFO; só o último é aberto '
  'parcialmente. Empate de validade resolvido em ordem natural do código.';

-- ============================================================
-- planejar_abastecimento — a lista de recipientes também
-- ============================================================
DROP FUNCTION IF EXISTS planejar_abastecimento(UUID, JSONB);

CREATE OR REPLACE FUNCTION planejar_abastecimento(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id            UUID,
  insumo_codigo        TEXT,
  insumo_nome          TEXT,
  unidade              TEXT,
  demanda              DECIMAL,
  conteudo_atual       DECIMAL,
  capacidade_total     DECIMAL,
  alvo                 DECIMAL,
  para_producao        DECIMAL,
  excedente            DECIMAL,
  saldo_apos_abastecer DECIMAL,
  sobra_apos_producao  DECIMAL,
  ordem                INTEGER,
  local_id             UUID,
  local_nome           TEXT,
  qr_code_fixo         TEXT,
  ja_tem               DECIMAL,
  capacidade           DECIMAL,
  colocar              DECIMAL
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
  potes_insumo AS (
    SELECT c.insumo_id AS ins_id,
           SUM(c.quantidade_total)               AS conteudo,
           SUM(COALESCE(c.capacidade_max, 0))    AS capacidade
      FROM v_recipientes_composicao c
     WHERE c.empresa_id = p_empresa_id
     GROUP BY c.insumo_id
  ),
  necessidade AS (
    SELECT d.ins_id,
           d.qtd                                            AS demanda,
           COALESCE(pi.conteudo, 0)                         AS conteudo,
           COALESCE(pi.capacidade, 0)                       AS capacidade,
           GREATEST(COALESCE(pi.capacidade, 0) - COALESCE(pi.conteudo, 0), 0) AS alvo,
           GREATEST(d.qtd - COALESCE(pi.conteudo, 0), 0)    AS para_producao
      FROM demanda_insumo d
      LEFT JOIN potes_insumo pi ON pi.ins_id = d.ins_id
     WHERE COALESCE(pi.conteudo, 0) < d.qtd
  ),
  potes AS (
    SELECT
      c.local_id, c.local_nome, c.qr_code_fixo, c.insumo_id AS ins_id,
      c.quantidade_total AS ja_tem,
      c.capacidade_max   AS capacidade,
      c.espaco_livre,
      ROW_NUMBER() OVER (
        PARTITION BY c.insumo_id
        ORDER BY (c.quantidade_total > 0) DESC, c.espaco_livre DESC,
                 chave_natural(c.local_nome)
      ) AS pos,
      COALESCE(SUM(c.espaco_livre) OVER (
        PARTITION BY c.insumo_id
        ORDER BY (c.quantidade_total > 0) DESC, c.espaco_livre DESC,
                 chave_natural(c.local_nome)
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
    ROUND(nec.demanda, 3),
    ROUND(nec.conteudo, 3),
    ROUND(nec.capacidade, 3),
    ROUND(nec.alvo, 3),
    ROUND(nec.para_producao, 3),
    ROUND(GREATEST(nec.alvo - nec.para_producao, 0), 3),
    ROUND(nec.conteudo + nec.alvo, 3),
    ROUND(nec.conteudo + nec.alvo - nec.demanda, 3),
    p.pos::INTEGER,
    p.local_id,
    p.local_nome::TEXT,
    p.qr_code_fixo::TEXT,
    ROUND(p.ja_tem, 3),
    p.capacidade,
    ROUND(LEAST(p.espaco_livre, nec.alvo - p.acum_antes), 3)
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  JOIN potes p   ON p.ins_id = nec.ins_id
  WHERE p.acum_antes < nec.alvo
  ORDER BY chave_natural(i.codigo), p.pos;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION planejar_abastecimento IS
  'Só entra o insumo cujos recipientes não cobrem a produção planejada. Quando '
  'entra, o alvo é encher até a capacidade — discriminando quanto é produção e '
  'quanto é excedente. Recipientes em ordem natural do nome.';

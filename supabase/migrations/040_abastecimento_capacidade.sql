-- ============================================================
-- Migration 040 — Abastecimento por capacidade e lote aberto único
--
-- O QUE ESTAVA ERRADO
-- A folha impressa mandava colocar 30,765 kg nos potes e, logo abaixo, pegar
-- 4 sublotes de 10 kg. São 40 kg, e os dois Potes G de açúcar somam 34 kg.
-- A sugestão de lotes ainda arredondava para sublote inteiro — herança da
-- RO-002, revogada na migration 035 — enquanto o resto da folha já trabalhava
-- com quantidade exata.
--
-- AS REGRAS DA OPERAÇÃO (definidas pelo Lucca)
--
-- 1. O planejador só age quando falta: se o conteúdo somado dos recipientes de
--    um insumo já cobre a produção planejada, o insumo não entra na lista.
--    (Por isso o Extrato de Alecrim, com 90 g de demanda e 2 L nas garrafas,
--     simplesmente não aparece.)
--
-- 2. Quando age, enche até a CAPACIDADE — não até a demanda. O excedente é
--    legítimo: veio de lote que já foi aberto. Mas tem que estar discriminado.
--
-- 3. No máximo UM lote aberto por insumo no estoque central. Ao abastecer:
--    esgota o aberto, consome lotes inteiros, e abre no máximo um novo.
--    O que não pode é tirar 7 kg de dois sublotes e devolver 3 kg de cada.
--
-- 4. Esgotar o aberto é prioridade máxima, "o quanto der" — se não couber no
--    recipiente, põe o que cabe e ele segue aberto.
--
-- Lote aberto = quantidade_disponivel > 0 AND quantidade_disponivel <
-- quantidade_recebida. As duas colunas já existem desde a migration 001.
-- ============================================================

-- As duas funções ganham colunas novas, e o Postgres não permite trocar o tipo
-- de retorno com CREATE OR REPLACE — só o frontend as chama, então apagar e
-- recriar é seguro.
DROP FUNCTION IF EXISTS planejar_abastecimento(UUID, JSONB);
DROP FUNCTION IF EXISTS sugerir_lotes_transferencia(UUID, JSONB);

-- ============================================================
-- 1. planejar_abastecimento — alvo é a capacidade, não a demanda
-- ============================================================
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
  alvo                 DECIMAL,   -- total a abastecer (até encher)
  para_producao        DECIMAL,   -- parte do alvo que a produção exige
  excedente            DECIMAL,   -- o resto, que fica de sobra
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
  -- Conteúdo e capacidade somados por insumo
  potes_insumo AS (
    SELECT c.insumo_id AS ins_id,
           SUM(c.quantidade_total)               AS conteudo,
           SUM(COALESCE(c.capacidade_max, 0))    AS capacidade
      FROM v_recipientes_composicao c
     WHERE c.empresa_id = p_empresa_id
     GROUP BY c.insumo_id
  ),
  -- REGRA 1: só entra quem não está coberto
  necessidade AS (
    SELECT d.ins_id,
           d.qtd                                            AS demanda,
           COALESCE(pi.conteudo, 0)                         AS conteudo,
           COALESCE(pi.capacidade, 0)                       AS capacidade,
           -- REGRA 2: alvo é encher, limitado ao que a capacidade permite
           GREATEST(COALESCE(pi.capacidade, 0) - COALESCE(pi.conteudo, 0), 0) AS alvo,
           GREATEST(d.qtd - COALESCE(pi.conteudo, 0), 0)    AS para_producao
      FROM demanda_insumo d
      LEFT JOIN potes_insumo pi ON pi.ins_id = d.ins_id
     WHERE COALESCE(pi.conteudo, 0) < d.qtd
  ),
  -- Distribuição entre os recipientes: completa os em uso antes dos vazios
  potes AS (
    SELECT
      c.local_id, c.local_nome, c.qr_code_fixo, c.insumo_id AS ins_id,
      c.quantidade_total AS ja_tem,
      c.capacidade_max   AS capacidade,
      c.espaco_livre,
      ROW_NUMBER() OVER (
        PARTITION BY c.insumo_id
        ORDER BY (c.quantidade_total > 0) DESC, c.espaco_livre DESC, c.local_nome
      ) AS pos,
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
  ORDER BY i.codigo, p.pos;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION planejar_abastecimento IS
  'Só entra o insumo cujos recipientes não cobrem a produção planejada. Quando '
  'entra, o alvo é encher até a capacidade — discriminando quanto é produção e '
  'quanto é excedente.';

-- ============================================================
-- 2. sugerir_lotes_transferencia — FEFO com lote aberto único
--
-- Cobre o ALVO (encher os potes), não só a demanda. Ordem:
--   1. lote já aberto — prioridade máxima, esgota o quanto der
--   2. lotes fechados em ordem FEFO, inteiros
--   3. o último pode ser aberto parcialmente — e é o único que volta aberto
-- ============================================================
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
  levar             DECIMAL,   -- quanto tirar deste lote
  volta_aberto      DECIMAL    -- quanto sobra nele (só o último costuma ter)
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
     WHERE COALESCE(pi.conteudo, 0) < d.qtd          -- mesmo gatilho da regra 1
       AND GREATEST(COALESCE(pi.capacidade, 0) - COALESCE(pi.conteudo, 0), 0) > 0
  ),
  lotes_fila AS (
    SELECT
      l.id, l.insumo_id AS ins_id, l.codigo, l.validade_pos_abertura,
      l.quantidade_disponivel,
      (l.quantidade_disponivel < l.quantidade_recebida) AS aberto,
      COALESCE(SUM(l.quantidade_disponivel) OVER (
        PARTITION BY l.insumo_id
        -- aberto primeiro (regra 3/4), depois FEFO
        ORDER BY (l.quantidade_disponivel < l.quantidade_recebida) DESC,
                 l.validade_pos_abertura, l.codigo
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
    -- leva o que ainda falta para o alvo, limitado ao saldo do lote
    ROUND(LEAST(lf.quantidade_disponivel, nec.alvo - lf.acum_antes), 3),
    ROUND(GREATEST(lf.quantidade_disponivel - (nec.alvo - lf.acum_antes), 0), 3)
  FROM necessidade nec
  JOIN insumos i ON i.id = nec.ins_id
  LEFT JOIN lotes_fila lf
    ON lf.ins_id = nec.ins_id
   AND lf.acum_antes < nec.alvo
  ORDER BY i.codigo,
           lf.aberto DESC NULLS LAST,
           lf.validade_pos_abertura NULLS LAST,
           lf.codigo;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION sugerir_lotes_transferencia IS
  'Quais lotes levar para encher os recipientes. Esgota o lote já aberto antes '
  'de qualquer outro; depois consome lotes inteiros em ordem FEFO; só o último '
  'é aberto parcialmente. Garante no máximo um lote aberto por insumo.';

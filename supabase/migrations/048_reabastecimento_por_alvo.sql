-- ============================================================
-- Migration 048 — Reabastecimento parte do alvo de produção
--
-- A 046 pedia "quantas formas por dia". Está invertido em relação a como a
-- fábrica pensa: o que se sabe é a **meta de unidades** de cada produto. Quantas
-- fornadas isso dá é consequência, não entrada.
--
-- Agora o caminho é:
--
--   unidades alvo  →  formas (fornadas)  →  insumo necessário  →  o que comprar
--
-- Formas arredonda para cima: não existe meia fornada. Sobra produto no fim da
-- última forma, e é assim na prática.
--
-- Saem de cena `reabastecimento_dias` e `dias_uteis_mes`: com o alvo dado em
-- unidades, o período já está embutido nele. Insistir num consumo por dia seria
-- inventar um dado que ninguém informou. A margem de segurança fica.
-- ============================================================

DROP VIEW IF EXISTS v_reabastecimento;

ALTER TABLE projecao_producao
  ADD COLUMN IF NOT EXISTS unidades_alvo DECIMAL(12,2) NOT NULL DEFAULT 0
    CHECK (unidades_alvo >= 0);

ALTER TABLE projecao_producao DROP COLUMN IF EXISTS formas_por_dia;

COMMENT ON COLUMN projecao_producao.unidades_alvo IS
  'Meta de unidades a produzir desta ficha. As fornadas saem daqui.';

ALTER TABLE configuracoes_sistema
  DROP COLUMN IF EXISTS reabastecimento_dias,
  DROP COLUMN IF EXISTS dias_uteis_mes;

-- ============================================================
-- v_projecao_formas — a conversão que a tela mostra em cima
-- ============================================================
CREATE OR REPLACE VIEW v_projecao_formas AS
SELECT
  p.empresa_id,
  p.ficha_id,
  f.codigo                  AS ficha_codigo,
  f.nome                    AS ficha_nome,
  v.id                      AS versao_id,
  p.unidades_alvo,
  v.rendimento_fornada,
  CEIL(p.unidades_alvo / NULLIF(v.rendimento_fornada, 0))::INTEGER AS formas,
  -- 1 batelada = 4 formas; é assim que a produção agenda o dia
  CEIL(CEIL(p.unidades_alvo / NULLIF(v.rendimento_fornada, 0)) / 4.0)::INTEGER AS bateladas,
  -- unidades que realmente saem, já que a última forma vai inteira
  (CEIL(p.unidades_alvo / NULLIF(v.rendimento_fornada, 0)) * v.rendimento_fornada)::INTEGER
                            AS unidades_produzidas
FROM projecao_producao p
JOIN fichas_tecnicas f              ON f.id = p.ficha_id
JOIN fichas_tecnicas_versoes v      ON v.ficha_id = p.ficha_id AND v.ativa
WHERE p.unidades_alvo > 0;

COMMENT ON VIEW v_projecao_formas IS
  'Converte a meta de unidades em fornadas e bateladas. A última forma vai '
  'inteira, então unidades_produzidas costuma passar um pouco do alvo.';

-- ============================================================
-- v_reabastecimento — quanto comprar de cada insumo
-- ============================================================
CREATE OR REPLACE VIEW v_reabastecimento AS
WITH cfg AS (
  SELECT empresa_id, reabastecimento_margem_pct AS margem
    FROM configuracoes_sistema
),
consumo AS (
  SELECT pf.empresa_id,
         it.insumo_id,
         SUM(it.quantidade * pf.formas) AS bruto
    FROM v_projecao_formas pf
    JOIN fichas_tecnicas_itens it ON it.versao_id = pf.versao_id
   GROUP BY pf.empresa_id, it.insumo_id
),
ec AS (
  SELECT empresa_id, insumo_id, SUM(quantidade_disponivel) AS qtd
    FROM lotes
   WHERE status = 'ativo' AND quantidade_disponivel > 0
   GROUP BY empresa_id, insumo_id
),
ep AS (
  SELECT l.empresa_id, l.insumo_id, SUM(ll.quantidade) AS qtd
    FROM locais l
    JOIN locais_lotes ll ON ll.local_id = l.id
   WHERE ll.quantidade > 0 AND l.ativo
   GROUP BY l.empresa_id, l.insumo_id
)
SELECT
  c.empresa_id,
  i.id             AS insumo_id,
  i.codigo         AS insumo_codigo,
  i.nome           AS insumo_nome,
  i.unidade_medida AS unidade,
  cfg.margem       AS margem_pct,
  ROUND(c.bruto, 4)                                    AS consumo_bruto,
  ROUND(c.bruto * (1 + cfg.margem / 100), 4)           AS necessario,
  ROUND(COALESCE(ec.qtd, 0), 3)                        AS estoque_ec,
  ROUND(COALESCE(ep.qtd, 0), 3)                        AS estoque_ep,
  ROUND(COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0), 3)  AS estoque_total,
  ROUND(GREATEST(
    c.bruto * (1 + cfg.margem / 100)
      - COALESCE(ec.qtd, 0) - COALESCE(ep.qtd, 0), 0), 3) AS comprar,
  i.tamanho_embalagem,
  CASE
    WHEN i.tamanho_embalagem IS NULL OR i.tamanho_embalagem <= 0 THEN NULL
    ELSE CEIL(GREATEST(
      c.bruto * (1 + cfg.margem / 100)
        - COALESCE(ec.qtd, 0) - COALESCE(ep.qtd, 0), 0) / i.tamanho_embalagem)
  END::INTEGER AS embalagens,
  -- Quanto do necessário o estoque de hoje já cobre
  ROUND(
    100 * (COALESCE(ec.qtd, 0) + COALESCE(ep.qtd, 0))
        / NULLIF(c.bruto * (1 + cfg.margem / 100), 0), 0)::INTEGER AS cobertura_pct
FROM consumo c
JOIN insumos i ON i.id = c.insumo_id AND i.ativo
JOIN cfg      ON cfg.empresa_id = c.empresa_id
LEFT JOIN ec  ON ec.empresa_id = c.empresa_id AND ec.insumo_id = c.insumo_id
LEFT JOIN ep  ON ep.empresa_id = c.empresa_id AND ep.insumo_id = c.insumo_id;

COMMENT ON VIEW v_reabastecimento IS
  'Quanto comprar de cada insumo para atingir a meta de produção, já com a '
  'margem de segurança. O estoque considerado soma o central e o que está '
  'dentro dos recipientes.';

-- ============================================================
-- salvar_projecao — agora recebe unidades
-- ============================================================
CREATE OR REPLACE FUNCTION salvar_projecao(
  p_empresa_id UUID,
  p_projecao   JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_item      JSONB;
  v_ficha     UUID;
  v_unidades  DECIMAL;
  v_n         INTEGER := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_projecao) LOOP
    v_ficha    := (v_item->>'ficha_id')::UUID;
    v_unidades := COALESCE((v_item->>'unidades_alvo')::DECIMAL, 0);

    IF v_unidades > 0 THEN
      INSERT INTO projecao_producao (empresa_id, ficha_id, unidades_alvo)
      VALUES (p_empresa_id, v_ficha, v_unidades)
      ON CONFLICT (empresa_id, ficha_id)
      DO UPDATE SET unidades_alvo = EXCLUDED.unidades_alvo, updated_at = NOW();
      v_n := v_n + 1;
    ELSE
      DELETE FROM projecao_producao
       WHERE empresa_id = p_empresa_id AND ficha_id = v_ficha;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'fichas', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Migration 049 — Plano semanal de produção
--
-- O Planejador de Recipientes enxerga um dia. A semana era planejada de cabeça
-- e digitada dia a dia, refazendo a mesma conta em três telas que não
-- conversam: meta → formas → abastecimento → sessão.
--
-- A REGRA QUE DEFINE A DISTRIBUIÇÃO
-- Trocar de sabor obriga a lavar os utensílios. Por isso a produção da semana
-- não se divide igual entre os dias: enche-se o dia com um sabor só e lava-se
-- no fim. Misturar dois produtos num dia é exceção, aceitável quando a sobra
-- não fecha um dia inteiro.
--
-- A distribuição em si acontece na tela, não aqui — é cálculo que precisa
-- responder a cada tecla e permitir ajuste manual. O banco guarda o resultado.
-- ============================================================

CREATE TABLE IF NOT EXISTS planos_semana (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  semana_inicio DATE NOT NULL,           -- sempre a segunda-feira
  -- Os dias marcados, inclusive os que ficaram sem produção. Sem isto um dia
  -- marcado e vazio sumiria ao recarregar, porque não gera item.
  dias_ativos   DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  observacoes   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, semana_inicio)
);

COMMENT ON TABLE planos_semana IS
  'Plano de produção de uma semana de calendário. Uma linha por semana.';

CREATE TABLE IF NOT EXISTS planos_semana_itens (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plano_id  UUID NOT NULL REFERENCES planos_semana(id) ON DELETE CASCADE,
  data      DATE NOT NULL,
  ficha_id  UUID NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  formas    INTEGER NOT NULL CHECK (formas > 0),
  UNIQUE (plano_id, data, ficha_id)
);

CREATE INDEX IF NOT EXISTS idx_planos_semana_itens_data
  ON planos_semana_itens(plano_id, data);

ALTER TABLE planos_semana       ENABLE ROW LEVEL SECURITY;
ALTER TABLE planos_semana_itens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acesso_por_empresa" ON planos_semana;
CREATE POLICY "acesso_por_empresa" ON planos_semana
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

-- Os itens não têm empresa_id: a checagem sobe pelo plano.
DROP POLICY IF EXISTS "acesso_por_empresa" ON planos_semana_itens;
CREATE POLICY "acesso_por_empresa" ON planos_semana_itens
  USING (EXISTS (
    SELECT 1 FROM planos_semana p
     WHERE p.id = plano_id AND p.empresa_id = get_empresa_id_do_usuario()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM planos_semana p
     WHERE p.id = plano_id AND p.empresa_id = get_empresa_id_do_usuario()));

-- ============================================================
-- salvar_plano_semana — grava a semana inteira de uma vez
--
-- Substitui os itens em vez de fazer merge: a tela sempre manda o plano
-- completo, e merge deixaria para trás dia que foi desmarcado.
-- ============================================================
CREATE OR REPLACE FUNCTION salvar_plano_semana(
  p_empresa_id    UUID,
  p_semana_inicio DATE,
  p_dias          DATE[],
  p_itens         JSONB,
  p_observacoes   TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_plano_id UUID;
  v_item     JSONB;
  v_formas   INTEGER;
  v_n        INTEGER := 0;
BEGIN
  INSERT INTO planos_semana (empresa_id, semana_inicio, dias_ativos, observacoes)
  VALUES (p_empresa_id, p_semana_inicio, COALESCE(p_dias, ARRAY[]::DATE[]), p_observacoes)
  ON CONFLICT (empresa_id, semana_inicio) DO UPDATE
     SET dias_ativos = EXCLUDED.dias_ativos,
         observacoes = EXCLUDED.observacoes,
         updated_at  = NOW()
  RETURNING id INTO v_plano_id;

  DELETE FROM planos_semana_itens WHERE plano_id = v_plano_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) LOOP
    v_formas := COALESCE((v_item->>'formas')::INTEGER, 0);
    -- Dia sem produção não vira linha; ele sobrevive em dias_ativos.
    IF v_formas > 0 THEN
      INSERT INTO planos_semana_itens (plano_id, data, ficha_id, formas)
      VALUES (v_plano_id, (v_item->>'data')::DATE, (v_item->>'ficha_id')::UUID, v_formas)
      ON CONFLICT (plano_id, data, ficha_id)
      DO UPDATE SET formas = EXCLUDED.formas;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'plano_id', v_plano_id, 'itens', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION salvar_plano_semana IS
  'Grava a semana inteira. Substitui os itens — a tela manda o plano completo.';

-- ============================================================
-- v_plano_semana — planejado ao lado do realizado
--
-- O realizado vem das sessões de produção pela data. Sessão ainda aberta não
-- tem quantidade_produzida: vem NULL, e é isso que distingue "em andamento" de
-- "não cumprido". Somar zero apagaria essa diferença.
-- ============================================================
CREATE OR REPLACE VIEW v_plano_semana AS
WITH realizado AS (
  SELECT s.empresa_id,
         s.data_producao                    AS data,
         sk.ficha_tecnica_id                AS ficha_id,
         SUM(sk.multiplicador)              AS formas,
         SUM(sk.quantidade_produzida)       AS unidades,
         BOOL_OR(s.status = 'aberta')       AS tem_sessao_aberta
    FROM sessoes_producao s
    JOIN sessoes_producao_skus sk ON sk.sessao_id = s.id
   WHERE s.status <> 'cancelada'
   GROUP BY s.empresa_id, s.data_producao, sk.ficha_tecnica_id
)
SELECT
  p.id                       AS plano_id,
  p.empresa_id,
  p.semana_inicio,
  i.data,
  i.ficha_id,
  f.codigo                   AS ficha_codigo,
  f.nome                     AS ficha_nome,
  i.formas                   AS formas_planejadas,
  (i.formas * v.rendimento_fornada)::INTEGER AS unidades_planejadas,
  r.formas                   AS formas_realizadas,
  r.unidades                 AS unidades_produzidas,
  COALESCE(r.tem_sessao_aberta, false)       AS em_andamento
FROM planos_semana p
JOIN planos_semana_itens i     ON i.plano_id = p.id
JOIN fichas_tecnicas f         ON f.id = i.ficha_id
LEFT JOIN fichas_tecnicas_versoes v
       ON v.ficha_id = i.ficha_id AND v.ativa
LEFT JOIN realizado r
       ON r.empresa_id = p.empresa_id
      AND r.data       = i.data
      AND r.ficha_id   = i.ficha_id;

COMMENT ON VIEW v_plano_semana IS
  'O plano da semana com o que as sessões de produção de fato registraram. '
  'Realizado NULL = nada aconteceu ainda naquele dia para aquela ficha.';

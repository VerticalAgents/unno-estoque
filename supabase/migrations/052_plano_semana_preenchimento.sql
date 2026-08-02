-- ============================================================
-- Migration 052 — Como a semana é preenchida também é decisão do usuário
--
-- A 049 tinha uma regra de distribuição só: blocos por produto. É a que evita
-- lavagem de utensílio e por isso é o padrão — mas nem toda semana é assim, e
-- não havia como discordar dela.
--
-- Agora o modo e a ordem dos produtos fazem parte do plano. A ordem importa:
-- é ela que decide qual produto ocupa os primeiros dias da semana.
--
-- A grade em si já era salva; o que faltava era guardar COMO ela foi gerada,
-- para "Redistribuir" fazer a mesma coisa depois de reabrir a semana.
-- ============================================================

ALTER TABLE planos_semana
  ADD COLUMN IF NOT EXISTS modo_preenchimento TEXT NOT NULL DEFAULT 'blocos'
    CHECK (modo_preenchimento IN ('blocos', 'igual', 'manual')),
  -- Prioridade dos produtos na semana. Ficha ausente entra depois das listadas.
  ADD COLUMN IF NOT EXISTS ordem_fichas UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

COMMENT ON COLUMN planos_semana.modo_preenchimento IS
  'blocos = um produto por dia, lavando só na troca (padrão); '
  'igual = todo dia com o mesmo mix; manual = o usuário distribui.';
COMMENT ON COLUMN planos_semana.ordem_fichas IS
  'Prioridade dos produtos: quem vem primeiro ocupa os primeiros dias.';

-- Assinatura nova: o Postgres não deixa acrescentar parâmetro com DEFAULT
-- convivendo com a assinatura antiga — vira ambiguidade (aconteceu na 042).
DROP FUNCTION IF EXISTS salvar_plano_semana(UUID, DATE, DATE[], JSONB, TEXT);

CREATE OR REPLACE FUNCTION salvar_plano_semana(
  p_empresa_id    UUID,
  p_semana_inicio DATE,
  p_dias          DATE[],
  p_itens         JSONB,
  p_observacoes   TEXT   DEFAULT NULL,
  p_modo          TEXT   DEFAULT 'blocos',
  p_ordem         UUID[] DEFAULT ARRAY[]::UUID[]
)
RETURNS JSONB AS $$
DECLARE
  v_plano_id UUID;
  v_item     JSONB;
  v_formas   INTEGER;
  v_n        INTEGER := 0;
BEGIN
  INSERT INTO planos_semana
    (empresa_id, semana_inicio, dias_ativos, observacoes, modo_preenchimento, ordem_fichas)
  VALUES
    (p_empresa_id, p_semana_inicio, COALESCE(p_dias, ARRAY[]::DATE[]), p_observacoes,
     COALESCE(p_modo, 'blocos'), COALESCE(p_ordem, ARRAY[]::UUID[]))
  ON CONFLICT (empresa_id, semana_inicio) DO UPDATE
     SET dias_ativos        = EXCLUDED.dias_ativos,
         observacoes        = EXCLUDED.observacoes,
         modo_preenchimento = EXCLUDED.modo_preenchimento,
         ordem_fichas       = EXCLUDED.ordem_fichas,
         updated_at         = NOW()
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

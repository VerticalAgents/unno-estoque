-- ============================================================
-- Migration 054 — Perda de processo e módulo de Pós-produção
--
-- O fechamento da sessão pedia unidades produzidas e descartadas por gramatura
-- — dois números que ninguém tem como saber naquele momento. No dia da produção
-- o brownie é cortado ainda quente mas segue DENTRO DA FORMA; só é desenformado
-- no dia seguinte, e é aí que aparece unidade quebrada, crua, torta.
--
-- São duas perdas, em dois momentos, medidas em unidades diferentes e por
-- pessoas diferentes:
--
--   processo       — no fim da produção — massa que sobrou no tacho, em GRAMAS
--   pós-produção   — no dia seguinte    — unidades descartadas, POR MOTIVO
--
-- A primeira já está prevista nas fichas: 4.100 g de insumos por forma, pesar
-- 4.050 g na forma, 50 g/forma de margem para perda de processo. No Doce de
-- Leite a massa da batedeira é 3.900 g e o topping (200 g) vai por cima, mas a
-- margem é a mesma — ela é sobre a massa, não sobre o total. Por isso a margem
-- é um número da ficha, e não uma conta derivada dos insumos.
--
-- Ninguém digita unidade boa em lugar nenhum: ela é
-- `formas assadas × rendimento − descartadas`.
-- ============================================================

-- ============================================================
-- 1. Motivos de descarte
-- ============================================================
CREATE TABLE IF NOT EXISTS motivos_descarte (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  codigo     TEXT NOT NULL,
  nome       TEXT NOT NULL,
  ordem      INTEGER NOT NULL DEFAULT 0,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo)
);

COMMENT ON TABLE motivos_descarte IS
  'Por que uma unidade foi descartada na pós-produção. Desativar em vez de '
  'apagar: motivo usado num registro antigo não pode sumir do histórico.';

CREATE OR REPLACE FUNCTION inicializar_motivos_descarte(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO motivos_descarte (empresa_id, codigo, nome, ordem) VALUES
    (p_empresa_id, 'fora_gramatura', 'Fora da gramatura', 1),
    (p_empresa_id, 'corpo_estranho', 'Corpo estranho',    2),
    (p_empresa_id, 'quebrado',       'Quebrado',          3),
    (p_empresa_id, 'cru',            'Cru',               4),
    (p_empresa_id, 'assado_demais',  'Assado em demasia', 5),
    (p_empresa_id, 'corte_torto',    'Corte torto',       6)
  ON CONFLICT (empresa_id, codigo) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
DECLARE v_emp RECORD;
BEGIN
  FOR v_emp IN SELECT id FROM empresas LOOP
    PERFORM inicializar_motivos_descarte(v_emp.id);
  END LOOP;
END $$;

-- ============================================================
-- 2. Colunas novas
-- ============================================================

-- A margem vive na ficha porque é dela: muda com a receita, não com o dia.
ALTER TABLE fichas_tecnicas_versoes
  ADD COLUMN IF NOT EXISTS perda_esperada_g_forma DECIMAL(10,2) NOT NULL DEFAULT 50;

COMMENT ON COLUMN fichas_tecnicas_versoes.perda_esperada_g_forma IS
  'Massa que se espera perder no tacho e nos utensílios, por forma. É a '
  'diferença entre os insumos da receita e o que vai pesado na forma.';

ALTER TABLE sessoes_producao_skus
  -- O planejado pode não ser o que foi ao forno.
  ADD COLUMN IF NOT EXISTS formas_assadas INTEGER,
  -- A pesagem do tacho no fim das bateladas daquele sabor.
  ADD COLUMN IF NOT EXISTS massa_sobra_g  DECIMAL(10,2);

-- ============================================================
-- 3. Pós-produção
-- ============================================================
CREATE TABLE IF NOT EXISTS pos_producao (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  -- UNIQUE é o que garante "um registro por sessão": a pós-produção sai de uma
  -- vez, nunca em pedaços.
  sessao_id     UUID NOT NULL UNIQUE REFERENCES sessoes_producao(id) ON DELETE CASCADE,
  data          DATE NOT NULL DEFAULT CURRENT_DATE,
  responsavel_id UUID REFERENCES usuarios(id),
  observacoes   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pos_producao_descartes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pos_id         UUID NOT NULL REFERENCES pos_producao(id) ON DELETE CASCADE,
  sessao_sku_id  UUID NOT NULL REFERENCES sessoes_producao_skus(id) ON DELETE CASCADE,
  motivo_id      UUID NOT NULL REFERENCES motivos_descarte(id),
  quantidade     INTEGER NOT NULL CHECK (quantidade > 0),
  UNIQUE (pos_id, sessao_sku_id, motivo_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_descartes_pos ON pos_producao_descartes(pos_id);

ALTER TABLE motivos_descarte       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_producao           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_producao_descartes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acesso_por_empresa" ON motivos_descarte;
CREATE POLICY "acesso_por_empresa" ON motivos_descarte
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

DROP POLICY IF EXISTS "acesso_por_empresa" ON pos_producao;
CREATE POLICY "acesso_por_empresa" ON pos_producao
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

-- Os descartes não têm empresa_id: a checagem sobe pelo cabeçalho.
DROP POLICY IF EXISTS "acesso_por_empresa" ON pos_producao_descartes;
CREATE POLICY "acesso_por_empresa" ON pos_producao_descartes
  USING (EXISTS (SELECT 1 FROM pos_producao p
                  WHERE p.id = pos_id AND p.empresa_id = get_empresa_id_do_usuario()))
  WITH CHECK (EXISTS (SELECT 1 FROM pos_producao p
                  WHERE p.id = pos_id AND p.empresa_id = get_empresa_id_do_usuario()));

-- ============================================================
-- 4. registrar_pos_producao
--
-- Substitui os descartes em vez de somar: a tela manda o registro completo, e
-- somar faria o segundo salvamento dobrar tudo.
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_pos_producao(
  p_empresa_id     UUID,
  p_sessao_id      UUID,
  p_responsavel_id UUID,
  p_descartes      JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_data           DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB AS $$
DECLARE
  v_pos_id UUID;
  v_item   JSONB;
  v_qtd    INTEGER;
  v_sku    RECORD;
  v_n      INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessoes_producao
                  WHERE id = p_sessao_id AND empresa_id = p_empresa_id
                    AND status = 'fechada') THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'A sessão precisa estar fechada para registrar a pós-produção.');
  END IF;

  INSERT INTO pos_producao (empresa_id, sessao_id, data, responsavel_id, observacoes)
  VALUES (p_empresa_id, p_sessao_id, COALESCE(p_data, CURRENT_DATE),
          p_responsavel_id, p_observacoes)
  ON CONFLICT (sessao_id) DO UPDATE
     SET data = EXCLUDED.data,
         responsavel_id = EXCLUDED.responsavel_id,
         observacoes = EXCLUDED.observacoes,
         updated_at = NOW()
  RETURNING id INTO v_pos_id;

  DELETE FROM pos_producao_descartes WHERE pos_id = v_pos_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) LOOP
    v_qtd := COALESCE((v_item->>'quantidade')::INTEGER, 0);
    IF v_qtd > 0 THEN
      INSERT INTO pos_producao_descartes (pos_id, sessao_sku_id, motivo_id, quantidade)
      VALUES (v_pos_id, (v_item->>'sessao_sku_id')::UUID,
              (v_item->>'motivo_id')::UUID, v_qtd)
      ON CONFLICT (pos_id, sessao_sku_id, motivo_id)
      DO UPDATE SET quantidade = EXCLUDED.quantidade;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- As unidades boas saem por diferença — ninguém as digita.
  FOR v_sku IN
    SELECT sk.id,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(v.rendimento_fornada, 0)                AS rendimento,
           COALESCE((SELECT SUM(d.quantidade)
                       FROM pos_producao_descartes d
                      WHERE d.pos_id = v_pos_id AND d.sessao_sku_id = sk.id), 0) AS descartadas
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes v ON v.id = sk.ficha_versao_id
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    UPDATE sessoes_producao_skus
       SET quantidade_perdida   = v_sku.descartadas,
           quantidade_produzida = GREATEST(v_sku.formas * v_sku.rendimento - v_sku.descartadas, 0)
     WHERE id = v_sku.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'pos_id', v_pos_id, 'descartes', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_pos_producao IS
  'Grava os descartes por motivo de uma sessão e recalcula as unidades boas por '
  'diferença. Substitui os descartes anteriores — a tela manda o registro todo.';

-- ============================================================
-- 5. v_pos_producao_pendente — a fila da tela
-- ============================================================
CREATE OR REPLACE VIEW v_pos_producao_pendente AS
SELECT
  s.id            AS sessao_id,
  s.empresa_id,
  s.codigo,
  s.data_producao,
  s.data_fechamento,
  (CURRENT_DATE - s.data_producao)::INTEGER AS dias_parado,
  COALESCE(SUM(COALESCE(sk.formas_assadas, sk.multiplicador, 0)), 0)::INTEGER AS formas,
  COALESCE(SUM(COALESCE(sk.formas_assadas, sk.multiplicador, 0)
               * COALESCE(v.rendimento_fornada, 0)), 0)::INTEGER              AS unidades_teoricas
FROM sessoes_producao s
JOIN sessoes_producao_skus sk ON sk.sessao_id = s.id
LEFT JOIN fichas_tecnicas_versoes v ON v.id = sk.ficha_versao_id
WHERE s.status = 'fechada'
  AND NOT EXISTS (SELECT 1 FROM pos_producao p WHERE p.sessao_id = s.id)
GROUP BY s.id, s.empresa_id, s.codigo, s.data_producao, s.data_fechamento;

-- Recriar view perde as opções: sem esta linha ela nasce legível sem login.
ALTER VIEW v_pos_producao_pendente SET (security_invoker = true);

COMMENT ON VIEW v_pos_producao_pendente IS
  'Sessões fechadas que ainda não tiveram a pós-produção registrada.';

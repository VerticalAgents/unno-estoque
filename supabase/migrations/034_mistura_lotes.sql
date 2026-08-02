-- ============================================================
-- Migration 034 — Recipiente passa a aceitar mais de um lote
--
-- POR QUE
-- RO-002 (transferir sempre o lote inteiro) e RO-003 (recipiente tem que estar
-- vazio) não se sustentam na operação real: o lote não cabe no pote, ou a
-- produção não pode esperar o pote raspar. Quando a regra não pode ser
-- cumprida, a equipe contorna — e aí o sistema passa a AFIRMAR que o pote tem
-- só o lote A quando na verdade tem A e B. Rastreabilidade falsa é pior que
-- rastreabilidade fraca: num recall, recolhe-se o lote errado.
--
-- O que continua travado é o que de fato não pode acontecer: misturar MARCAS
-- diferentes no mesmo recipiente.
--
-- O QUE MUDA AQUI (só o modelo de dados; as RPCs vêm na 035 e 036)
-- `locais_estado_atual` guardava um único lote_id por recipiente — esse era o
-- bloqueio. Passa a existir `locais_lotes` com o conteúdo lote a lote, e
-- `locais_estado_atual` vira o RESUMO, mantido por trigger.
--
-- Manter o resumo (em vez de migrar tudo de uma vez) preserva 5 telas, as RPCs
-- de contagem e a view v_estoque_consolidado funcionando sem alteração.
-- ============================================================

-- ── Conteúdo do recipiente, lote a lote ─────────────────────
CREATE TABLE IF NOT EXISTS locais_lotes (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  local_id           UUID NOT NULL REFERENCES locais(id) ON DELETE CASCADE,
  lote_id            UUID NOT NULL REFERENCES lotes(id) ON DELETE RESTRICT,
  quantidade         DECIMAL(12,3) NOT NULL DEFAULT 0,
  unidade            unidade_medida_enum,
  data_transferencia DATE NOT NULL DEFAULT CURRENT_DATE,
  validade_ep        DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- transferir o mesmo lote duas vezes para o mesmo pote soma, não duplica
  UNIQUE (local_id, lote_id),
  CONSTRAINT chk_locais_lotes_qtd CHECK (quantidade >= 0)
);

COMMENT ON TABLE locais_lotes IS
  'Conteúdo de cada recipiente do EP, lote a lote. Um recipiente pode ter '
  'vários lotes do MESMO insumo e da MESMA marca misturados. '
  'locais_estado_atual é o resumo desta tabela, mantido por trigger.';

CREATE INDEX IF NOT EXISTS idx_locais_lotes_local ON locais_lotes(local_id);
CREATE INDEX IF NOT EXISTS idx_locais_lotes_lote  ON locais_lotes(lote_id);

ALTER TABLE locais_lotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acesso_por_empresa" ON locais_lotes;
CREATE POLICY "acesso_por_empresa" ON locais_lotes
  USING (
    local_id IN (SELECT id FROM locais WHERE empresa_id = get_empresa_id_do_usuario())
  );

CREATE TRIGGER set_updated_at BEFORE UPDATE ON locais_lotes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- Trigger: mantém locais_estado_atual como resumo de locais_lotes
--
-- É o que garante que o agregado nunca fica inconsistente, não importa qual
-- RPC escreva em locais_lotes. Regras do resumo:
--   quantidade  = soma dos lotes com saldo
--   validade_ep = MENOR validade (o pote vence junto com o pior lote)
--   lote_id     = lote de validade mais próxima — mantém vivos os leitores
--                 que ainda esperam "um" lote por recipiente
-- ============================================================
CREATE OR REPLACE FUNCTION recalcular_estado_local()
RETURNS TRIGGER AS $$
DECLARE
  v_local_id   UUID;
  v_total      DECIMAL;
  v_unidade    unidade_medida_enum;
  v_lote_id    UUID;
  v_validade   DATE;
  v_data_transf DATE;
BEGIN
  v_local_id := COALESCE(NEW.local_id, OLD.local_id);

  SELECT
    COALESCE(SUM(ll.quantidade), 0),
    MIN(ll.validade_ep),
    (ARRAY_AGG(ll.lote_id ORDER BY ll.validade_ep NULLS LAST, ll.data_transferencia))[1],
    (ARRAY_AGG(ll.unidade ORDER BY ll.validade_ep NULLS LAST, ll.data_transferencia))[1],
    MAX(ll.data_transferencia)
    INTO v_total, v_validade, v_lote_id, v_unidade, v_data_transf
  FROM locais_lotes ll
  WHERE ll.local_id = v_local_id
    AND ll.quantidade > 0;

  INSERT INTO locais_estado_atual (
    local_id, lote_id, quantidade, unidade, validade_ep, data_transferencia, atualizado_em
  )
  VALUES (
    v_local_id, v_lote_id, COALESCE(v_total, 0), v_unidade, v_validade, v_data_transf, NOW()
  )
  ON CONFLICT (local_id) DO UPDATE SET
    lote_id            = EXCLUDED.lote_id,
    quantidade         = EXCLUDED.quantidade,
    unidade            = COALESCE(EXCLUDED.unidade, locais_estado_atual.unidade),
    validade_ep        = EXCLUDED.validade_ep,
    data_transferencia = COALESCE(EXCLUDED.data_transferencia, locais_estado_atual.data_transferencia),
    atualizado_em      = NOW();

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_recalcular_estado_local ON locais_lotes;
CREATE TRIGGER trg_recalcular_estado_local
  AFTER INSERT OR UPDATE OR DELETE ON locais_lotes
  FOR EACH ROW EXECUTE FUNCTION recalcular_estado_local();

-- ============================================================
-- Migra o conteúdo que já existe nos recipientes
-- (hoje: um lote por recipiente, em locais_estado_atual)
-- ============================================================
INSERT INTO locais_lotes (local_id, lote_id, quantidade, unidade, data_transferencia, validade_ep)
SELECT lea.local_id, lea.lote_id, lea.quantidade, lea.unidade,
       COALESCE(lea.data_transferencia, CURRENT_DATE), lea.validade_ep
  FROM locais_estado_atual lea
 WHERE lea.lote_id IS NOT NULL
   AND lea.quantidade > 0
ON CONFLICT (local_id, lote_id) DO NOTHING;

-- ============================================================
-- View de apoio: composição do recipiente, pronta para as telas
-- ============================================================
CREATE OR REPLACE VIEW v_recipientes_composicao AS
SELECT
  l.empresa_id,
  l.id                AS local_id,
  l.nome              AS local_nome,
  l.qr_code_fixo,
  l.capacidade_max,
  l.insumo_id,
  i.codigo            AS insumo_codigo,
  i.nome              AS insumo_nome,
  i.unidade_medida,
  COUNT(ll.id) FILTER (WHERE ll.quantidade > 0)              AS qtd_lotes,
  COALESCE(SUM(ll.quantidade), 0)                            AS quantidade_total,
  GREATEST(COALESCE(l.capacidade_max, 0) - COALESCE(SUM(ll.quantidade), 0), 0) AS espaco_livre,
  MIN(ll.validade_ep)                                        AS validade_ep,
  -- marca do conteúdo atual: NULL quando vazio
  (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1] AS marca_conteudo
FROM locais l
JOIN insumos i ON i.id = l.insumo_id
LEFT JOIN locais_lotes ll ON ll.local_id = l.id AND ll.quantidade > 0
LEFT JOIN lotes lo        ON lo.id = ll.lote_id
WHERE l.tipo = 'estoque_produtivo' AND l.ativo
GROUP BY l.empresa_id, l.id, l.nome, l.qr_code_fixo, l.capacidade_max,
         l.insumo_id, i.codigo, i.nome, i.unidade_medida;

COMMENT ON VIEW v_recipientes_composicao IS
  'Um registro por recipiente do EP com o que ele contém hoje: quantos lotes, '
  'quanto no total, quanto ainda cabe e a marca do conteúdo atual.';

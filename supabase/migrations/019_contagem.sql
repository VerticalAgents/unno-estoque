-- ============================================================
-- Migration 019 — Contagem (Inventário Físico)
-- Tabelas para contagem de EC e EP, peso_tara em locais,
-- RPCs para iniciar e aplicar contagens.
-- ============================================================

-- ============================================================
-- 1. Coluna peso_tara em locais
-- ============================================================
ALTER TABLE locais ADD COLUMN IF NOT EXISTS peso_tara DECIMAL DEFAULT 0;

-- ============================================================
-- 2. Tabela: contagens (sessões de inventário)
-- ============================================================
CREATE TABLE contagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ec', 'ep')),
  status TEXT NOT NULL DEFAULT 'em_andamento'
    CHECK (status IN ('em_andamento', 'finalizada', 'aplicada', 'cancelada')),
  iniciada_por UUID NOT NULL REFERENCES usuarios(id),
  observacao TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizada_at TIMESTAMPTZ,
  aplicada_at TIMESTAMPTZ
);

ALTER TABLE contagens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON contagens
  USING (empresa_id = get_empresa_id_do_usuario());

-- ============================================================
-- 3. Tabela: contagem_insumos (progresso por insumo)
-- ============================================================
CREATE TABLE contagem_insumos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contagem_id UUID NOT NULL REFERENCES contagens(id) ON DELETE CASCADE,
  insumo_id UUID NOT NULL REFERENCES insumos(id),
  qtd_teorica DECIMAL NOT NULL,
  qtd_fisica DECIMAL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_contagem', 'finalizado')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(contagem_id, insumo_id)
);

ALTER TABLE contagem_insumos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON contagem_insumos
  USING (
    contagem_id IN (
      SELECT id FROM contagens
      WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- 4. Tabela: contagem_ec_lotes (lotes esperados no EC)
-- ============================================================
CREATE TABLE contagem_ec_lotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contagem_insumo_id UUID NOT NULL REFERENCES contagem_insumos(id) ON DELETE CASCADE,
  lote_id UUID NOT NULL REFERENCES lotes(id),
  lote_codigo TEXT NOT NULL,
  qtd_lote DECIMAL NOT NULL,
  encontrado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(contagem_insumo_id, lote_id)
);

ALTER TABLE contagem_ec_lotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON contagem_ec_lotes
  USING (
    contagem_insumo_id IN (
      SELECT ci.id FROM contagem_insumos ci
      JOIN contagens c ON c.id = ci.contagem_id
      WHERE c.empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- 5. Tabela: contagem_ep_locais (recipientes no EP)
-- ============================================================
CREATE TABLE contagem_ep_locais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contagem_insumo_id UUID NOT NULL REFERENCES contagem_insumos(id) ON DELETE CASCADE,
  local_id UUID NOT NULL REFERENCES locais(id),
  local_nome TEXT NOT NULL,
  status_fisico TEXT CHECK (status_fisico IN ('cheio', 'vazio', 'usado')),
  peso_bruto DECIMAL,
  peso_tara DECIMAL,
  qtd_liquida DECIMAL,
  qtd_estado_atual DECIMAL NOT NULL,
  escaneado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(contagem_insumo_id, local_id)
);

ALTER TABLE contagem_ep_locais ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acesso_por_empresa" ON contagem_ep_locais
  USING (
    contagem_insumo_id IN (
      SELECT ci.id FROM contagem_insumos ci
      JOIN contagens c ON c.id = ci.contagem_id
      WHERE c.empresa_id = get_empresa_id_do_usuario()
    )
  );

-- ============================================================
-- Índices
-- ============================================================
CREATE INDEX idx_contagem_insumos_contagem ON contagem_insumos(contagem_id);
CREATE INDEX idx_contagem_ec_lotes_insumo ON contagem_ec_lotes(contagem_insumo_id);
CREATE INDEX idx_contagem_ep_locais_insumo ON contagem_ep_locais(contagem_insumo_id);

-- ============================================================
-- 6. RPC: iniciar_contagem
-- Cria sessão e pré-popula todos os registros esperados
-- ============================================================
CREATE OR REPLACE FUNCTION iniciar_contagem(
  p_empresa_id UUID,
  p_tipo TEXT,
  p_usuario_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_contagem_id UUID;
  v_item_id UUID;
  v_insumo RECORD;
  v_lote RECORD;
  v_local RECORD;
  v_qtd_teorica DECIMAL;
  v_existing UUID;
BEGIN
  -- Verifica se já existe contagem em_andamento do mesmo tipo
  SELECT id INTO v_existing
  FROM contagens
  WHERE empresa_id = p_empresa_id
    AND tipo = p_tipo
    AND status = 'em_andamento'
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Já existe uma contagem em andamento do tipo ' || p_tipo, 'contagem_id', v_existing);
  END IF;

  -- Cria a contagem
  INSERT INTO contagens (empresa_id, tipo, iniciada_por)
  VALUES (p_empresa_id, p_tipo, p_usuario_id)
  RETURNING id INTO v_contagem_id;

  IF p_tipo = 'ec' THEN
    -- Para cada insumo ativo com lotes ativos
    FOR v_insumo IN
      SELECT DISTINCT i.id AS insumo_id
      FROM insumos i
      JOIN lotes l ON l.insumo_id = i.id AND l.status = 'ativo' AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY i.id
    LOOP
      -- Soma teórica
      SELECT COALESCE(SUM(quantidade_disponivel), 0) INTO v_qtd_teorica
      FROM lotes
      WHERE insumo_id = v_insumo.insumo_id
        AND empresa_id = p_empresa_id
        AND status = 'ativo';

      INSERT INTO contagem_insumos (contagem_id, insumo_id, qtd_teorica)
      VALUES (v_contagem_id, v_insumo.insumo_id, v_qtd_teorica)
      RETURNING id INTO v_item_id;

      -- Cria registro para cada lote ativo
      FOR v_lote IN
        SELECT id, codigo, quantidade_disponivel
        FROM lotes
        WHERE insumo_id = v_insumo.insumo_id
          AND empresa_id = p_empresa_id
          AND status = 'ativo'
        ORDER BY data_recebimento
      LOOP
        INSERT INTO contagem_ec_lotes (contagem_insumo_id, lote_id, lote_codigo, qtd_lote)
        VALUES (v_item_id, v_lote.id, v_lote.codigo, v_lote.quantidade_disponivel);
      END LOOP;
    END LOOP;

  ELSIF p_tipo = 'ep' THEN
    -- Para cada insumo ativo com recipientes EP
    FOR v_insumo IN
      SELECT DISTINCT i.id AS insumo_id
      FROM insumos i
      JOIN locais l ON l.insumo_id = i.id AND l.tipo = 'estoque_produtivo' AND l.ativo = true AND l.empresa_id = p_empresa_id
      WHERE i.empresa_id = p_empresa_id AND i.ativo = true
      ORDER BY i.id
    LOOP
      -- Soma teórica do EP
      SELECT COALESCE(SUM(lea.quantidade), 0) INTO v_qtd_teorica
      FROM locais loc
      JOIN locais_estado_atual lea ON lea.local_id = loc.id
      WHERE loc.insumo_id = v_insumo.insumo_id
        AND loc.tipo = 'estoque_produtivo'
        AND loc.ativo = true
        AND loc.empresa_id = p_empresa_id;

      INSERT INTO contagem_insumos (contagem_id, insumo_id, qtd_teorica)
      VALUES (v_contagem_id, v_insumo.insumo_id, v_qtd_teorica)
      RETURNING id INTO v_item_id;

      -- Cria registro para cada recipiente
      FOR v_local IN
        SELECT loc.id, loc.nome, loc.peso_tara, COALESCE(lea.quantidade, 0) AS qtd_atual
        FROM locais loc
        LEFT JOIN locais_estado_atual lea ON lea.local_id = loc.id
        WHERE loc.insumo_id = v_insumo.insumo_id
          AND loc.tipo = 'estoque_produtivo'
          AND loc.ativo = true
          AND loc.empresa_id = p_empresa_id
        ORDER BY loc.nome
      LOOP
        INSERT INTO contagem_ep_locais (contagem_insumo_id, local_id, local_nome, qtd_estado_atual, peso_tara)
        VALUES (v_item_id, v_local.id, v_local.nome, v_local.qtd_atual, COALESCE(v_local.peso_tara, 0));
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'contagem_id', v_contagem_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 7. RPC: aplicar_contagem
-- Aplica divergências ao estoque virtual
-- ============================================================
CREATE OR REPLACE FUNCTION aplicar_contagem(
  p_contagem_id UUID,
  p_usuario_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_contagem contagens%ROWTYPE;
  v_item RECORD;
  v_ec_lote RECORD;
  v_ep_local RECORD;
  v_mov_id UUID;
  v_mov_codigo TEXT;
  v_local_rec locais%ROWTYPE;
BEGIN
  SELECT * INTO v_contagem FROM contagens WHERE id = p_contagem_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Contagem não encontrada');
  END IF;

  IF v_contagem.status != 'finalizada' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Contagem deve estar finalizada para ser aplicada');
  END IF;

  IF v_contagem.tipo = 'ec' THEN
    -- Para cada lote não encontrado, marcar como descartado
    FOR v_ec_lote IN
      SELECT cel.lote_id, cel.qtd_lote, ci.insumo_id
      FROM contagem_ec_lotes cel
      JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
      WHERE ci.contagem_id = p_contagem_id
        AND cel.encontrado = false
    LOOP
      -- Atualiza lote
      UPDATE lotes
      SET status = 'descartado', quantidade_disponivel = 0, updated_at = now()
      WHERE id = v_ec_lote.lote_id;

      -- Cria movimentação de ajuste
      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem: lote não encontrado no EC')
      RETURNING id INTO v_mov_id;

      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
      SELECT v_mov_id, v_ec_lote.lote_id, v_ec_lote.qtd_lote,
             i.unidade_medida
      FROM insumos i WHERE i.id = v_ec_lote.insumo_id;
    END LOOP;

  ELSIF v_contagem.tipo = 'ep' THEN
    -- Para cada recipiente escaneado, ajustar estado atual
    FOR v_ep_local IN
      SELECT cel.local_id, cel.status_fisico, cel.qtd_liquida, ci.insumo_id
      FROM contagem_ep_locais cel
      JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
      WHERE ci.contagem_id = p_contagem_id
        AND cel.escaneado = true
    LOOP
      SELECT * INTO v_local_rec FROM locais WHERE id = v_ep_local.local_id;

      IF v_ep_local.status_fisico = 'cheio' THEN
        UPDATE locais_estado_atual
        SET quantidade = COALESCE(v_local_rec.capacidade_max, 0),
            atualizado_em = now(), atualizado_por = p_usuario_id
        WHERE local_id = v_ep_local.local_id;

      ELSIF v_ep_local.status_fisico = 'vazio' THEN
        UPDATE locais_estado_atual
        SET quantidade = 0, lote_id = NULL, lote_unidade_id = NULL,
            atualizado_em = now(), atualizado_por = p_usuario_id
        WHERE local_id = v_ep_local.local_id;

      ELSIF v_ep_local.status_fisico = 'usado' THEN
        UPDATE locais_estado_atual
        SET quantidade = COALESCE(v_ep_local.qtd_liquida, 0),
            atualizado_em = now(), atualizado_por = p_usuario_id
        WHERE local_id = v_ep_local.local_id;
      END IF;

      -- Movimentação de ajuste
      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem EP: ajuste recipiente ' || v_local_rec.nome);
    END LOOP;
  END IF;

  -- Marca como aplicada
  UPDATE contagens
  SET status = 'aplicada', aplicada_at = now()
  WHERE id = p_contagem_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

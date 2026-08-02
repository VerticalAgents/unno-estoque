-- ============================================================
-- Migration 041 — Travas configuráveis com justificativa
--
-- POR QUÊ
-- As regras do sistema eram absolutas: ou passava, ou não passava. Numa
-- operação do tamanho da Mischa's isso não se sustenta — quando a regra
-- impede o trabalho, a equipe contorna por fora, e o sistema perde o registro
-- do que aconteceu.
--
-- A saída: cada regra vira configuração. Em `bloqueia`, recusa sempre. Em
-- `avisa`, deixa passar mediante justificativa escrita, que fica registrada.
-- Assim a exceção continua sendo exceção — mas fica auditável, em vez de
-- virar um contorno invisível.
--
-- Padrão de fábrica: só `marca_diferente` bloqueia. Foi a única regra que o
-- usuário classificou como inegociável.
-- ============================================================

CREATE TABLE IF NOT EXISTS travas_config (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chave      TEXT NOT NULL,
  modo       TEXT NOT NULL DEFAULT 'avisa' CHECK (modo IN ('bloqueia', 'avisa')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, chave)
);

COMMENT ON TABLE travas_config IS
  'Modo de cada regra de negócio: bloqueia (recusa sempre) ou avisa (permite '
  'com justificativa registrada em excecoes_registradas).';

-- Auditoria dedicada: a pergunta "quando e por que furamos a regra" precisa
-- ser respondível sem garimpar observações de movimentação.
CREATE TABLE IF NOT EXISTS excecoes_registradas (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id    UUID REFERENCES usuarios(id),
  chave         TEXT NOT NULL,
  contexto      JSONB,          -- lote, recipiente, sessão envolvidos
  justificativa TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_excecoes_empresa_data
  ON excecoes_registradas(empresa_id, created_at DESC);

ALTER TABLE travas_config         ENABLE ROW LEVEL SECURITY;
ALTER TABLE excecoes_registradas  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acesso_por_empresa" ON travas_config;
CREATE POLICY "acesso_por_empresa" ON travas_config
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());

DROP POLICY IF EXISTS "acesso_por_empresa" ON excecoes_registradas;
CREATE POLICY "acesso_por_empresa" ON excecoes_registradas
  USING (empresa_id = get_empresa_id_do_usuario());

-- ── Defaults por empresa ────────────────────────────────────
CREATE OR REPLACE FUNCTION inicializar_travas_padrao(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO travas_config (empresa_id, chave, modo) VALUES
    (p_empresa_id, 'marca_diferente',     'bloqueia'),
    (p_empresa_id, 'segundo_lote_aberto', 'avisa'),
    (p_empresa_id, 'excede_capacidade',   'avisa'),
    (p_empresa_id, 'sessao_sem_insumo',   'avisa'),
    (p_empresa_id, 'fefo',                'avisa')
  ON CONFLICT (empresa_id, chave) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
DECLARE v_emp RECORD;
BEGIN
  FOR v_emp IN SELECT id FROM empresas LOOP
    PERFORM inicializar_travas_padrao(v_emp.id);
  END LOOP;
END $$;

-- ============================================================
-- avaliar_trava — o coração da coisa
--
-- Devolve se a ação pode prosseguir. Em `bloqueia`, nunca — justificativa não
-- fura bloqueio, senão a configuração não valeria nada. Em `avisa`, só com
-- justificativa preenchida.
-- ============================================================
CREATE OR REPLACE FUNCTION avaliar_trava(
  p_empresa_id    UUID,
  p_chave         TEXT,
  p_justificativa TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_modo TEXT;
BEGIN
  SELECT modo INTO v_modo
    FROM travas_config
   WHERE empresa_id = p_empresa_id AND chave = p_chave;

  -- Trava não configurada: assume o mais conservador dos modos permissivos
  v_modo := COALESCE(v_modo, 'avisa');

  IF v_modo = 'bloqueia' THEN
    RETURN jsonb_build_object('permitido', false, 'modo', 'bloqueia');
  END IF;

  IF p_justificativa IS NULL OR btrim(p_justificativa) = '' THEN
    RETURN jsonb_build_object(
      'permitido', false, 'modo', 'avisa', 'requer_justificativa', true
    );
  END IF;

  RETURN jsonb_build_object('permitido', true, 'modo', 'avisa');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION registrar_excecao(
  p_empresa_id    UUID,
  p_usuario_id    UUID,
  p_chave         TEXT,
  p_contexto      JSONB,
  p_justificativa TEXT
)
RETURNS void AS $$
BEGIN
  INSERT INTO excecoes_registradas
    (empresa_id, usuario_id, chave, contexto, justificativa)
  VALUES
    (p_empresa_id, p_usuario_id, p_chave, p_contexto, p_justificativa);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- realizar_transferencia — agora consulta as travas
--
-- Três regras podem ser violadas aqui:
--   marca_diferente     — misturar marcas no recipiente
--   segundo_lote_aberto — deixar dois lotes abertos do mesmo insumo no EC
--   excede_capacidade   — passar da capacidade nominal do recipiente
--
-- Quando a regra pega e não há justificativa, devolve o motivo para a tela
-- pedir a confirmação. Se a trava for `bloqueia`, recusa e pronto.
-- ============================================================
CREATE OR REPLACE FUNCTION realizar_transferencia(
  p_lote_id        UUID,
  p_local_id       UUID,
  p_quantidade     DECIMAL,
  p_responsavel_id UUID,
  p_empresa_id     UUID,
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_local         locais%ROWTYPE;
  v_insumo        insumos%ROWTYPE;
  v_mov_codigo    TEXT;
  v_mov_id        UUID;
  v_validade_ep   DATE;
  v_marca_conteudo UUID;
  v_total_atual   DECIMAL;
  v_abertos       INTEGER;
  v_vai_abrir     BOOLEAN;
  v_trava         JSONB;
  v_contexto      JSONB;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe uma quantidade maior que zero.');
  END IF;

  IF v_lote.quantidade_disponivel < p_quantidade THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Quantidade insuficiente. Disponível: %s %s',
             v_lote.quantidade_disponivel, v_lote.unidade));
  END IF;

  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_lote.insumo_id THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este recipiente é dedicado a outro insumo.');
  END IF;

  SELECT COALESCE(SUM(ll.quantidade), 0),
         (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1]
    INTO v_total_atual, v_marca_conteudo
    FROM locais_lotes ll
    JOIN lotes lo ON lo.id = ll.lote_id
   WHERE ll.local_id = p_local_id AND ll.quantidade > 0;

  v_contexto := jsonb_build_object(
    'lote', v_lote.codigo, 'recipiente', v_local.nome, 'quantidade', p_quantidade
  );

  -- ── TRAVA: marca diferente ────────────────────────────────
  IF (v_lote.marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
      AND v_lote.marca_id <> v_local.marca_id)
     OR (v_lote.marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
         AND v_lote.marca_id <> v_marca_conteudo) THEN
    v_trava := avaliar_trava(p_empresa_id, 'marca_diferente', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'marca_diferente',
        'mensagem', 'Este recipiente é de outra marca. Misturar marcas compromete a rastreabilidade.');
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'marca_diferente',
                              v_contexto, p_justificativa);
  END IF;

  -- ── TRAVA: segundo lote aberto ────────────────────────────
  -- Só abre lote novo quem leva menos do que o saldo. Se já existe outro
  -- aberto do mesmo insumo, esta transferência criaria o segundo.
  v_vai_abrir := (p_quantidade < v_lote.quantidade_disponivel)
                 AND (v_lote.quantidade_disponivel = v_lote.quantidade_recebida);

  IF v_vai_abrir THEN
    SELECT COUNT(*) INTO v_abertos
      FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.insumo_id = v_lote.insumo_id
       AND l.status = 'ativo'
       AND l.quantidade_disponivel > 0
       AND l.quantidade_disponivel < l.quantidade_recebida;

    IF v_abertos > 0 THEN
      v_trava := avaliar_trava(p_empresa_id, 'segundo_lote_aberto', p_justificativa);
      IF NOT (v_trava->>'permitido')::BOOLEAN THEN
        RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'segundo_lote_aberto',
          'mensagem', format('Já existe %s lote aberto deste insumo no estoque. '
                             'Esgote ele antes de abrir outro.', v_abertos));
      END IF;
      PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'segundo_lote_aberto',
                                v_contexto, p_justificativa);
    END IF;
  END IF;

  -- ── TRAVA: excede capacidade ──────────────────────────────
  IF v_local.capacidade_max IS NOT NULL
     AND v_total_atual + p_quantidade > v_local.capacidade_max THEN
    v_trava := avaliar_trava(p_empresa_id, 'excede_capacidade', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'excede_capacidade',
        'mensagem', format('Passa da capacidade do recipiente (%s de %s %s).',
                           v_total_atual + p_quantidade, v_local.capacidade_max, v_lote.unidade));
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'excede_capacidade',
                              v_contexto, p_justificativa);
  END IF;

  -- ── Execução ──────────────────────────────────────────────
  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;
  v_validade_ep := CASE
    WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
    THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
    ELSE v_lote.validade_original
  END;

  UPDATE lotes
     SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
         status = CASE
           WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'esgotado'::status_lote_enum
           ELSE status
         END
   WHERE id = p_lote_id;

  PERFORM abastecer_recipiente(p_local_id, p_lote_id, p_quantidade, v_lote.unidade, v_validade_ep);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
          p_responsavel_id, p_justificativa)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens
    (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, NULL, p_local_id, p_quantidade, v_lote.unidade);

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'codigo', v_mov_codigo,
    'validade_ep', v_validade_ep,
    'misturou', v_total_atual > 0,
    'lote_esgotado', (v_lote.quantidade_disponivel - p_quantidade) <= 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

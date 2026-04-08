-- ============================================================
-- Migration 010 — Formato de código de sublotes
-- Sublotes de um mesmo recebimento compartilham o código base:
--   1 etiqueta  → LOTE-0001
--   N etiquetas → LOTE-0001.1/12 … LOTE-0001.12/12
-- ============================================================

-- ── 1. gerar_proximo_codigo — extração por regex ─────────────
-- Troca SUBSTRING posicional por regex para que o MAX ignore
-- qualquer sufixo .i/N e retorne sempre o número base correto.
CREATE OR REPLACE FUNCTION gerar_proximo_codigo(
  p_empresa_id UUID,
  p_tabela     TEXT,
  p_prefixo    TEXT
)
RETURNS TEXT AS $$
DECLARE
  v_max    INTEGER;
  v_codigo TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    ('x' || md5(p_empresa_id::text || p_tabela))::bit(64)::bigint
  );

  EXECUTE format(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(codigo FROM %L) AS INTEGER)), 0)
     FROM %I
     WHERE empresa_id = $1 AND codigo ~ %L',
    '^' || p_prefixo || '-(\d+)',   -- regex: captura só os dígitos base
    p_tabela,
    '^' || p_prefixo || '-\d'       -- filtro rápido de linhas candidatas
  ) INTO v_max USING p_empresa_id;

  v_codigo := p_prefixo || '-' || LPAD((v_max + 1)::TEXT, 4, '0');
  RETURN v_codigo;
END;
$$ LANGUAGE plpgsql;


-- ── 2. registrar_entrada_lote — código base único por lote ───
-- O código base é gerado UMA vez para o recebimento inteiro.
-- Cada sublote recebe o sufixo .i/N (exceto quando N=1).
CREATE OR REPLACE FUNCTION registrar_entrada_lote(
  p_empresa_id          UUID,
  p_insumo_id           UUID,
  p_fornecedor_id       UUID,
  p_data_recebimento    DATE,
  p_validade_original   DATE,
  p_quantidade_recebida DECIMAL,
  p_unidade             TEXT,
  p_num_etiquetas       INTEGER  DEFAULT 1,
  p_observacoes         TEXT     DEFAULT NULL,
  p_responsavel_id      UUID     DEFAULT NULL,
  p_numero_nf           TEXT     DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_grupo_id           UUID    := uuid_generate_v4();
  v_lote_codigo_base   TEXT;
  v_lote_codigo        TEXT;
  v_qr_code            TEXT;
  v_validade_calculada DATE;
  v_lote_id            UUID;
  v_mov_id             UUID;
  v_mov_codigo         TEXT;
  v_lotes_criados      JSONB   := '[]'::JSONB;
  v_qtd_por_etiqueta   DECIMAL;
  v_qtd_ultima         DECIMAL;
  i                    INTEGER;
  v_qtd_i              DECIMAL;
BEGIN
  IF p_num_etiquetas < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Número de etiquetas deve ser >= 1.');
  END IF;

  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id, p_validade_original, p_data_recebimento
  );

  v_qtd_por_etiqueta := ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3);
  v_qtd_ultima := p_quantidade_recebida - (v_qtd_por_etiqueta * (p_num_etiquetas - 1));

  -- Código base gerado UMA vez para todo o recebimento
  v_lote_codigo_base := gerar_proximo_codigo(p_empresa_id, 'lotes', 'LOTE');

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  FOR i IN 1..p_num_etiquetas LOOP
    v_qtd_i := CASE WHEN i = p_num_etiquetas THEN v_qtd_ultima ELSE v_qtd_por_etiqueta END;

    -- Único: LOTE-0001 | Múltiplos: LOTE-0001.1/12, LOTE-0001.2/12 …
    v_lote_codigo := CASE
      WHEN p_num_etiquetas = 1 THEN v_lote_codigo_base
      ELSE v_lote_codigo_base || '.' || i || '/' || p_num_etiquetas
    END;
    v_qr_code := 'QR-' || v_lote_codigo;

    INSERT INTO lotes (
      id, empresa_id, codigo, insumo_id, fornecedor_id,
      data_recebimento, data_fabricacao,
      validade_original, validade_pos_abertura,
      quantidade_recebida, unidade, quantidade_disponivel,
      recebido_por, qr_code, observacoes, numero_nf, lote_grupo_id
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes, p_numero_nf, v_grupo_id
    ) RETURNING id INTO v_lote_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, v_qtd_i, p_unidade::unidade_medida_enum);

    v_lotes_criados := v_lotes_criados || jsonb_build_object(
      'lote_id',    v_lote_id,
      'codigo',     v_lote_codigo,
      'qr_code',    v_qr_code,
      'quantidade', v_qtd_i
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok',    true,
    'lotes', v_lotes_criados,
    'lote_id',               (v_lotes_criados->0->>'lote_id')::UUID,
    'lote_codigo',           v_lotes_criados->0->>'codigo',
    'qr_code',               v_lotes_criados->0->>'qr_code',
    'validade_pos_abertura', v_validade_calculada,
    'lote_grupo_id',         v_grupo_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 3. Migração de dados — renomeia lotes existentes ─────────
-- Regra:
--   • Grupos com 1 sublote  → código inalterado (LOTE-0001)
--   • Grupos com N sublotes → LOTE-XXXX.1/N … LOTE-XXXX.N/N
--     usando como XXXX o menor número já existente no grupo
-- Só processa lotes no formato original LOTE-DDDD (sem sufixo).
-- qr_code é atualizado junto.
DO $$
DECLARE
  v_grupo   RECORD;
  v_lote    RECORD;
  v_total   INTEGER;
  v_idx     INTEGER;
  v_base    TEXT;
  v_novo    TEXT;
BEGIN
  FOR v_grupo IN
    SELECT lote_grupo_id
    FROM lotes
    WHERE lote_grupo_id IS NOT NULL
      AND codigo ~ '^LOTE-\d{4}$'          -- ainda no formato antigo
    GROUP BY lote_grupo_id
    HAVING COUNT(*) > 1
    ORDER BY lote_grupo_id
  LOOP
    -- Conta total de sublotes no grupo
    SELECT COUNT(*) INTO v_total
    FROM lotes
    WHERE lote_grupo_id = v_grupo.lote_grupo_id
      AND codigo ~ '^LOTE-\d{4}$';

    -- Base = dígitos do menor código do grupo (ex: '0003')
    SELECT SUBSTRING(codigo FROM '^LOTE-(\d+)') INTO v_base
    FROM lotes
    WHERE lote_grupo_id = v_grupo.lote_grupo_id
      AND codigo ~ '^LOTE-\d{4}$'
    ORDER BY codigo ASC
    LIMIT 1;

    -- Renomeia cada sublote em ordem de criação
    v_idx := 0;
    FOR v_lote IN
      SELECT id
      FROM lotes
      WHERE lote_grupo_id = v_grupo.lote_grupo_id
        AND codigo ~ '^LOTE-\d{4}$'
      ORDER BY created_at ASC, codigo ASC
    LOOP
      v_idx  := v_idx + 1;
      v_novo := 'LOTE-' || v_base || '.' || v_idx || '/' || v_total;

      UPDATE lotes
      SET codigo  = v_novo,
          qr_code = 'QR-' || v_novo
      WHERE id = v_lote.id;
    END LOOP;
  END LOOP;
END;
$$;

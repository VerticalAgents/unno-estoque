-- ============================================================
-- Migration 077 — O recebimento passa a respeitar o tamanho da embalagem
--
-- Dois defeitos, e o segundo é mais grave que o pedido que o revelou.
--
-- 1. FARDO ABERTO NÃO ERA MARCADO. Receber 21 kg de farinha, num insumo cuja
--    embalagem é de 25 kg, cria um fardo aberto — não existe saco de 21 kg. A
--    etiqueta saía igual à de um fardo cheio, e na prateleira ninguém sabia que
--    aquele tinha menos. A marcação já existia (tarja "EMB. ABERTA"), mas só a
--    abertura de estoque a usava.
--
-- 2. A DIVISÃO EM SUBLOTES ERA IGUALITÁRIA, E ISSO INVENTA EMBALAGEM QUE NÃO
--    EXISTE. Receber 30 kg de farinha gerava DUAS etiquetas de 15 kg. Não há
--    saco de 15 kg: há um de 25 e um aberto com 5. O total fechava, então o
--    defeito era silencioso — a mesma armadilha da abertura de estoque, que o
--    usuário pegou em 05/08 com o açúcar (98 kg viravam dez fardos de 9,8).
--
-- Agora quem manda é o tamanho da embalagem do insumo: `fechadas` sublotes
-- cheios mais um com o resto, e o resto nasce marcado como aberto. Sem tamanho
-- cadastrado, nada muda — segue a divisão por número de etiquetas.
--
-- `embalagem_aberta` vira coluna. Até aqui isso era deduzido de um texto em
-- `observacoes` ("embalagem aberta"), o que funcionava com um produtor só; com
-- dois, procurar substring numa observação livre é frágil. A leitura antiga
-- fica como fallback para os lotes já gravados.
-- ============================================================

ALTER TABLE lotes
  ADD COLUMN IF NOT EXISTS embalagem_aberta BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN lotes.embalagem_aberta IS
  'O lote é uma embalagem incompleta: sobra de um fardo, ou pacote que já '
  'chegou começado. A etiqueta destaca isso para casar etiqueta com fardo na '
  'prateleira.';

-- Os lotes que a abertura de estoque marcou por texto passam a ter a coluna.
UPDATE lotes
   SET embalagem_aberta = true
 WHERE NOT embalagem_aberta
   AND lower(COALESCE(observacoes, '')) LIKE '%embalagem aberta%';

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
  p_numero_nf           TEXT     DEFAULT NULL,
  p_marca_id            UUID     DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_grupo_id           UUID    := uuid_generate_v4();
  v_insumo_codigo      TEXT;
  v_tam_embalagem      DECIMAL;
  v_lote_codigo_base   TEXT;
  v_lote_codigo        TEXT;
  v_qr_code            TEXT;
  v_validade_calculada DATE;
  v_lote_id            UUID;
  v_mov_id             UUID;
  v_mov_codigo         TEXT;
  v_lotes_criados      JSONB   := '[]'::JSONB;
  v_qtds               DECIMAL[];
  v_fechadas           INTEGER;
  v_resto              DECIMAL;
  v_total              INTEGER;
  i                    INTEGER;
  v_qtd_i              DECIMAL;
  v_aberta_i           BOOLEAN;
BEGIN
  IF p_num_etiquetas < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Número de etiquetas deve ser >= 1.');
  END IF;

  IF COALESCE(p_quantidade_recebida, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe a quantidade recebida.');
  END IF;

  SELECT codigo, tamanho_embalagem INTO v_insumo_codigo, v_tam_embalagem
    FROM insumos WHERE id = p_insumo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  -- ── Quanto vai em cada etiqueta ──
  -- Com tamanho de embalagem cadastrado, a divisão é a física: fardos cheios e,
  -- se sobrar, um aberto. Sem tamanho, cai na divisão por número de etiquetas,
  -- que é o que o sistema fazia antes desta migration.
  IF COALESCE(v_tam_embalagem, 0) > 0 THEN
    v_fechadas := FLOOR(p_quantidade_recebida / v_tam_embalagem)::INTEGER;
    v_resto    := ROUND((p_quantidade_recebida - v_fechadas * v_tam_embalagem)::NUMERIC, 3);

    v_qtds := ARRAY[]::DECIMAL[];
    FOR i IN 1..v_fechadas LOOP
      v_qtds := v_qtds || v_tam_embalagem;
    END LOOP;
    IF v_resto > 0 THEN
      v_qtds := v_qtds || v_resto;
    END IF;
  ELSE
    v_qtds := ARRAY[]::DECIMAL[];
    FOR i IN 1..p_num_etiquetas LOOP
      v_qtds := v_qtds || CASE
        WHEN i = p_num_etiquetas
        THEN ROUND((p_quantidade_recebida
             - ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3) * (p_num_etiquetas - 1))::NUMERIC, 3)
        ELSE ROUND((p_quantidade_recebida / p_num_etiquetas)::NUMERIC, 3)
      END;
    END LOOP;
  END IF;

  v_total := array_length(v_qtds, 1);

  v_validade_calculada := calcular_validade_pos_abertura(
    p_insumo_id, p_validade_original, p_data_recebimento
  );

  v_lote_codigo_base := gerar_proximo_codigo(p_empresa_id, 'lotes', v_insumo_codigo);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'entrada', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  FOR i IN 1..v_total LOOP
    v_qtd_i := v_qtds[i];
    -- Aberta é a que não completa a embalagem. Sem tamanho cadastrado não há
    -- como saber, e ninguém é marcado.
    v_aberta_i := COALESCE(v_tam_embalagem, 0) > 0 AND v_qtd_i < v_tam_embalagem;

    v_lote_codigo := CASE
      WHEN v_total = 1 THEN v_lote_codigo_base
      ELSE v_lote_codigo_base || '.' || i || '/' || v_total
    END;
    v_qr_code := 'QR-' || v_lote_codigo;

    INSERT INTO lotes (
      id, empresa_id, codigo, insumo_id, fornecedor_id,
      data_recebimento, data_fabricacao,
      validade_original, validade_pos_abertura,
      quantidade_recebida, unidade, quantidade_disponivel,
      recebido_por, qr_code, observacoes, numero_nf, lote_grupo_id, marca_id,
      embalagem_aberta
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes, p_numero_nf, v_grupo_id, p_marca_id,
      v_aberta_i
    ) RETURNING id INTO v_lote_id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, v_qtd_i, p_unidade::unidade_medida_enum);

    v_lotes_criados := v_lotes_criados || jsonb_build_object(
      'lote_id',    v_lote_id,
      'codigo',     v_lote_codigo,
      'qr_code',    v_qr_code,
      'quantidade', v_qtd_i,
      'embalagem_aberta', v_aberta_i
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok',    true,
    'lotes', v_lotes_criados,
    'lote_id',               (v_lotes_criados->0->>'lote_id')::UUID,
    'lote_codigo',           v_lotes_criados->0->>'codigo',
    'qr_code',               v_lotes_criados->0->>'qr_code',
    'validade_pos_abertura', v_validade_calculada,
    'lote_grupo_id',         v_grupo_id,
    'etiquetas',             v_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_entrada_lote IS
  'Registra a entrada e divide em sublotes pelo TAMANHO DA EMBALAGEM do insumo: '
  'fardos cheios mais um aberto com o resto. Antes dividia igualmente, o que '
  'inventava embalagens que não existem (30kg de farinha viravam dois sacos de '
  '15). Sem tamanho cadastrado, divide por número de etiquetas.';

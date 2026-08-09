-- ============================================================
-- Migration 078 — Temperatura de recebimento vira dado, não texto
--
-- Hoje quem precisa conferir temperatura escreve "chegou a 4 graus" no campo
-- de observações. Isso serve para a pessoa que lê a tela e para mais ninguém:
-- não dá para somar, comparar, alertar nem provar em auditoria. E o sistema
-- aceita qualquer coisa — inclusive um congelado que chegou a 12 °C.
--
-- Passa a ser configuração do insumo:
--   - `exige_temperatura`  liga a conferência no recebimento
--   - `temperatura_min/max` é a faixa aceitável, em °C
--
-- E `lotes.temperatura_recebimento` guarda o que foi medido. Quem não precisa
-- disso — a maioria dos insumos secos — não vê campo nenhum, porque o padrão
-- é desligado.
--
-- A recusa é do banco, não só da tela: fora da faixa, `registrar_entrada_lote`
-- devolve erro e não grava. Uma carga fora da faixa não deve virar lote — a
-- decisão certa é recusar a entrega, e um lote registrado seria exatamente a
-- afirmação contrária.
-- ============================================================

ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS exige_temperatura BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS temperatura_min   DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS temperatura_max   DECIMAL(6,2);

COMMENT ON COLUMN insumos.exige_temperatura IS
  'Se verdadeiro, o recebimento deste insumo pede a temperatura medida e '
  'recusa o que estiver fora de [temperatura_min, temperatura_max].';

-- Faixa completa e coerente, ou nenhuma faixa. Meia faixa ("no máximo 8")
-- parece útil, mas o campo que fica em branco vira dúvida na tela: ninguém
-- sabe se é aberto ou se esqueceram de preencher.
ALTER TABLE insumos DROP CONSTRAINT IF EXISTS chk_temperatura_faixa;
ALTER TABLE insumos ADD CONSTRAINT chk_temperatura_faixa CHECK (
  NOT exige_temperatura
  OR (temperatura_min IS NOT NULL AND temperatura_max IS NOT NULL
      AND temperatura_min <= temperatura_max)
);

ALTER TABLE lotes
  ADD COLUMN IF NOT EXISTS temperatura_recebimento DECIMAL(6,2);

COMMENT ON COLUMN lotes.temperatura_recebimento IS
  'Temperatura medida na chegada, em °C. Só é preenchida quando o insumo '
  'exigia a conferência no momento do recebimento.';

-- ── A RPC ────────────────────────────────────────────────────
-- Um parâmetro novo com DEFAULT cria uma ASSINATURA nova: as duas passam a
-- existir e a chamada por nome do PostgREST fica ambígua. Foi o que aconteceu
-- com esta mesma função (quatro overloads, migration 077). A antiga sai no fim
-- do arquivo, depois que a nova está no lugar.

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
  p_marca_id            UUID     DEFAULT NULL,
  p_temperatura         DECIMAL  DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_grupo_id           UUID    := uuid_generate_v4();
  v_insumo_codigo      TEXT;
  v_insumo_nome        TEXT;
  v_tam_embalagem      DECIMAL;
  v_exige_temp         BOOLEAN;
  v_temp_min           DECIMAL;
  v_temp_max           DECIMAL;
  v_temp_gravada       DECIMAL;
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

  SELECT codigo, nome, tamanho_embalagem, exige_temperatura, temperatura_min, temperatura_max
    INTO v_insumo_codigo, v_insumo_nome, v_tam_embalagem, v_exige_temp, v_temp_min, v_temp_max
    FROM insumos WHERE id = p_insumo_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  -- ── Temperatura ──
  IF v_exige_temp THEN
    IF p_temperatura IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        v_insumo_nome || ': informe a temperatura medida na chegada.');
    END IF;
    IF p_temperatura < v_temp_min OR p_temperatura > v_temp_max THEN
      RETURN jsonb_build_object('ok', false,
        'erro', v_insumo_nome || ' chegou a ' || trim(to_char(p_temperatura, 'FM999990.09'))
             || ' °C, fora da faixa aceita ('
             || trim(to_char(v_temp_min, 'FM999990.09')) || ' a '
             || trim(to_char(v_temp_max, 'FM999990.09')) || ' °C). A carga não pode ser recebida.',
        'fora_da_faixa', true);
    END IF;
    v_temp_gravada := p_temperatura;
  ELSE
    -- Insumo que não exige não guarda temperatura: um número solto, sem faixa
    -- que o julgue, só ocuparia coluna e enganaria quem for analisar depois.
    v_temp_gravada := NULL;
  END IF;

  -- ── Quanto vai em cada etiqueta ──
  -- Com tamanho de embalagem cadastrado, a divisão é a física: fardos cheios e,
  -- se sobrar, um aberto. Sem tamanho, cai na divisão por número de etiquetas.
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
      embalagem_aberta, temperatura_recebimento
    ) VALUES (
      uuid_generate_v4(), p_empresa_id, v_lote_codigo, p_insumo_id, p_fornecedor_id,
      p_data_recebimento, NULL,
      p_validade_original, v_validade_calculada,
      v_qtd_i, p_unidade::unidade_medida_enum, v_qtd_i,
      p_responsavel_id, v_qr_code, p_observacoes, p_numero_nf, v_grupo_id, p_marca_id,
      v_aberta_i, v_temp_gravada
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
    'total_lotes',           v_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- A assinatura sem p_temperatura sai de cena, senão a chamada por nome fica
-- ambígua ("function is not unique").
DROP FUNCTION IF EXISTS registrar_entrada_lote(
  UUID, UUID, UUID, DATE, DATE, DECIMAL, TEXT, INTEGER, TEXT, UUID, TEXT, UUID
);

COMMENT ON FUNCTION registrar_entrada_lote(
  UUID, UUID, UUID, DATE, DATE, DECIMAL, TEXT, INTEGER, TEXT, UUID, TEXT, UUID, DECIMAL
) IS
  'Entrada no Estoque Central. Divide pela embalagem do insumo, marca o fardo '
  'aberto e, quando o insumo exige, confere a temperatura contra a faixa '
  'cadastrada — fora dela, recusa sem gravar.';

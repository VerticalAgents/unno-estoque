-- ============================================================
-- Migration 130 — tamanho da embalagem por entrega, no recebimento
--
-- Até aqui as etiquetas saíam do `insumos.tamanho_embalagem`, e quando o
-- fornecedor mandava outro tamanho era preciso mudar o cadastro, receber e
-- desfazer (Lucca, 29/09/2026: a farinha veio em fardos de 10 kg). Agora o
-- recebimento manda o tamanho desta entrega, e o cadastro fica como está.
--
-- Parte do corpo em produção (pg_get_functiondef em 29/09/2026). O parâmetro
-- novo muda a assinatura: a antiga é removida, senão o PostgREST teria duas
-- funções com o mesmo nome para escolher e recusaria a chamada.

DROP FUNCTION IF EXISTS public.registrar_entrada_lote(UUID, UUID, UUID, DATE, DATE, NUMERIC, TEXT, INTEGER, TEXT, UUID, TEXT, UUID, NUMERIC);

CREATE OR REPLACE FUNCTION public.registrar_entrada_lote(p_empresa_id uuid, p_insumo_id uuid, p_fornecedor_id uuid, p_data_recebimento date, p_validade_original date, p_quantidade_recebida numeric, p_unidade text, p_num_etiquetas integer DEFAULT 1, p_observacoes text DEFAULT NULL::text, p_responsavel_id uuid DEFAULT NULL::uuid, p_numero_nf text DEFAULT NULL::text, p_marca_id uuid DEFAULT NULL::uuid, p_temperatura numeric DEFAULT NULL::numeric, p_tamanho_embalagem numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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

  -- O tamanho DESTA entrega, quando o fornecedor mandou diferente do cadastro
  -- (migration 130): a farinha que costuma vir em fardo de 25 kg chegou em
  -- fardos de 10. Vale só para esta chamada; o cadastro não muda.
  IF p_tamanho_embalagem IS NOT NULL THEN
    IF p_tamanho_embalagem <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'O tamanho da embalagem precisa ser maior que zero.');
    END IF;
    v_tam_embalagem := p_tamanho_embalagem;
  END IF;

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
    v_temp_gravada := NULL;
  END IF;

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
$function$;

REVOKE ALL ON FUNCTION registrar_entrada_lote(UUID, UUID, UUID, DATE, DATE, NUMERIC, TEXT, INTEGER, TEXT, UUID, TEXT, UUID, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_entrada_lote(UUID, UUID, UUID, DATE, DATE, NUMERIC, TEXT, INTEGER, TEXT, UUID, TEXT, UUID, NUMERIC, NUMERIC) TO authenticated, service_role;

-- ============================================================
-- Migration 127 — concordância no histórico do reabastecimento por unidade
--
-- A 126 gravava "0 pacotes fechadas": o texto tinha sido escrito pensando em
-- garrafa. Parte do corpo em produção (pg_get_functiondef em 28/09/2026).

CREATE OR REPLACE FUNCTION public.registrar_abastecimento_unidades(p_empresa_id uuid, p_responsavel_id uuid, p_insumo_id uuid, p_tinha integer, p_itens jsonb, p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_insumo     insumos%ROWTYPE;
  v_peso       DECIMAL;
  v_tipo       TEXT;
  v_local      UUID;
  v_it         RECORD;
  v_linha      RECORD;
  v_sistema    DECIMAL;
  v_medido     DECIMAL;
  v_fator      DECIMAL;
  v_novo       DECIMAL;
  v_dif        DECIMAL;
  v_acerto_mov UUID;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
  v_validade   DATE;
  v_levou      INTEGER := 0;
  v_primeiro   RECORD;
  v_orfao      DECIMAL := 0;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  SELECT e.subunidade_peso, COALESCE(e.subunidade_tipo, 'unidade')
    INTO v_peso, v_tipo
    FROM insumos_embalagem_config e
   WHERE e.insumo_id = p_insumo_id AND e.tem_subunidades AND e.subunidade_peso > 0;
  IF v_peso IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      '%s não tem cadastrado quanto pesa cada unidade.', v_insumo.nome));
  END IF;

  SELECT id INTO v_local FROM locais
   WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
     AND tipo = 'estoque_produtivo' AND ativo AND NOT efemero
   ORDER BY created_at DESC LIMIT 1;
  IF v_local IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      '%s não tem lugar na produção cadastrado.', v_insumo.nome));
  END IF;

  IF p_tinha IS NULL OR p_tinha < 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'Diga quantas %ss fechadas ainda estavam na produção.', v_tipo));
  END IF;

  DROP TABLE IF EXISTS _abu_itens;
  CREATE TEMP TABLE _abu_itens ON COMMIT DROP AS
  SELECT l.id, l.codigo, l.unidade, l.status, l.insumo_id, l.validade_original,
         l.validade_pos_abertura, l.quantidade_disponivel AS saldo,
         (e->>'unidades')::INTEGER AS unidades,
         ROUND((e->>'unidades')::INTEGER * v_peso, 3) AS qtd
    FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) e
    JOIN lotes l ON l.id = (e->>'lote_id')::UUID AND l.empresa_id = p_empresa_id;

  -- ── Conferência: nada é escrito antes de tudo passar ──────
  IF (SELECT COUNT(*) FROM _abu_itens) <> jsonb_array_length(COALESCE(p_itens, '[]'::JSONB)) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Embalagem não encontrada.');
  END IF;
  IF (SELECT COUNT(DISTINCT id) FROM _abu_itens) <> (SELECT COUNT(*) FROM _abu_itens) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'A mesma embalagem foi bipada duas vezes.');
  END IF;

  FOR v_it IN SELECT * FROM _abu_itens LOOP
    IF v_it.insumo_id <> p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s é de outro insumo.', v_it.codigo));
    END IF;
    IF v_it.status <> 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s não está ativa (%s).', v_it.codigo, v_it.status));
    END IF;
    IF COALESCE(v_it.unidades, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Diga quantas %ss saíram de %s.', v_tipo, v_it.codigo));
    END IF;
    IF v_it.qtd > v_it.saldo + 0.001 THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s só tem %s %ss, e foram informadas %s.',
        v_it.codigo, FLOOR(v_it.saldo / v_peso + 0.0001), v_tipo, v_it.unidades));
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(quantidade), 0) INTO v_sistema
    FROM locais_lotes WHERE local_id = v_local;
  v_medido := ROUND(p_tinha * v_peso, 3);

  -- Contou fechadas num lugar que o sistema acha vazio, e não entrou nada:
  -- não há lote a quem atribuir.
  IF v_sistema <= 0 AND v_medido > 0 AND NOT EXISTS (SELECT 1 FROM _abu_itens) THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'O sistema não tem %s na produção e não sabe de qual lote são essas %s. '
      'Registre junto com a próxima caixa que levar.', v_insumo.nome, p_tinha));
  END IF;

  -- ── Acerto: o que estava lá contra o que o sistema supunha ─
  IF ABS(v_medido - v_sistema) >= 0.001 THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
            p_responsavel_id, format(
              'Contagem no reabastecimento: %s %ss %s na produção.', p_tinha, v_tipo,
              -- "garrafa" é feminino, "pacote" masculino.
              CASE WHEN v_tipo LIKE '%a' THEN 'fechadas' ELSE 'fechados' END))
    RETURNING id INTO v_acerto_mov;

    IF v_sistema > 0 THEN
      -- Rateio na proporção de cada lote. O item sai antes do ajuste, enquanto
      -- as quantidades ainda são as velhas.
      v_fator := v_medido / v_sistema;
      FOR v_linha IN
        SELECT lote_id, quantidade, unidade FROM locais_lotes
         WHERE local_id = v_local AND quantidade > 0
      LOOP
        v_dif := ROUND(v_linha.quantidade * v_fator, 3) - v_linha.quantidade;
        CONTINUE WHEN ABS(v_dif) < 0.001;
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
        VALUES (v_acerto_mov, v_linha.lote_id,
                CASE WHEN v_dif < 0 THEN v_local END,
                CASE WHEN v_dif > 0 THEN v_local END,
                ABS(v_dif), v_linha.unidade);
      END LOOP;
      PERFORM ajustar_conteudo_recipiente(v_local, v_medido);
    ELSE
      -- O sistema acha vazio e a contagem diz que tem: vai para a primeira
      -- embalagem que está entrando, com a ressalva registrada — mesmo
      -- caminho do "órfão" do reabastecimento de pote.
      v_orfao := v_medido;
    END IF;
  END IF;

  -- ── Entrada ───────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM _abu_itens) THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
            p_responsavel_id, p_justificativa)
    RETURNING id INTO v_mov_id;

    FOR v_it IN SELECT * FROM _abu_itens ORDER BY validade_pos_abertura, codigo LOOP
      v_validade := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_it.validade_original)
        ELSE v_it.validade_original
      END;

      PERFORM abastecer_recipiente(v_local, v_it.id, v_it.qtd, v_it.unidade, v_validade);

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_it.id, v_local, v_it.qtd, v_it.unidade);

      UPDATE lotes
         SET quantidade_disponivel = GREATEST(ROUND(quantidade_disponivel - v_it.qtd, 3), 0),
             status = CASE WHEN quantidade_disponivel - v_it.qtd <= 0.001
                           THEN 'esgotado'::status_lote_enum ELSE status END,
             updated_at = NOW()
       WHERE id = v_it.id;

      IF v_orfao > 0 THEN
        PERFORM abastecer_recipiente(v_local, v_it.id, v_orfao, v_it.unidade, v_validade);
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_acerto_mov, v_it.id, v_local, v_orfao, v_it.unidade);
        PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'acerto_sem_lote',
          jsonb_build_object('quantidade', v_orfao, 'lote', v_it.codigo),
          COALESCE(NULLIF(trim(p_justificativa), ''),
                   'A produção tinha unidades que o sistema não conhecia.'));
        v_orfao := 0;
      END IF;

      v_levou := v_levou + v_it.unidades;
    END LOOP;
  END IF;

  -- Contou: o número é medição.
  UPDATE locais
     SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW(), updated_at = NOW()
   WHERE id = v_local;

  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id);

  RETURN jsonb_build_object(
    'ok',          true,
    'movimentacao', v_mov_codigo,
    'tipo',        v_tipo,
    'tinha',       p_tinha,
    'levou',       v_levou,
    'total',       p_tinha + v_levou,
    'acerto',      ROUND(v_medido - v_sistema, 3)
  );
END;
$function$;

REVOKE ALL ON FUNCTION registrar_abastecimento_unidades(UUID, UUID, UUID, INTEGER, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_abastecimento_unidades(UUID, UUID, UUID, INTEGER, JSONB, TEXT)
  TO authenticated, service_role;

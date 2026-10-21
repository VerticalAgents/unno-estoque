-- ============================================================
-- Migration 144 — óleo e ovo: quem reabastece diz o que levou, quem fecha conta
--
-- Em 20/10/2026 o Fernando levou óleo pelo "Levar embalagem original" e a
-- tela travou sem gravar nada: o INS006-0009.5/5 ficou com 15 garrafas que já
-- tinham sido usadas. Decisões do Lucca (21/10/2026):
--   · óleo e ovo moram em "Levar embalagem original" (é onde a equipe procura),
--     mas sem virar QR por unidade: só a caixa tem etiqueta;
--   · quem reabastece diz só as caixas que pegou e quantas sobraram nelas —
--     não conta mais o que havia na produção;
--   · a contagem do que sobrou na produção passa para o FECHAMENTO da sessão,
--     obrigatória;
--   · um botão "Zerar" no lote do estoque central, para o funcionário acertar
--     o que já acabou sem precisar de auditoria. Conta como diferença de
--     inventário (ajuste_inventario), não como descarte.
-- ============================================================


-- ── 1. Zerar um lote do estoque central ─────────────────────
CREATE OR REPLACE FUNCTION public.zerar_lote(p_lote_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_observacoes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
-- O lote acabou de verdade mas o sistema ainda conta saldo. Mesmo registro
-- que a contagem faz quando acha zero (aplicar_contagem, 117).
DECLARE
  v_lote       lotes%ROWTYPE;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;
  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro', format('%s não está ativo (%s).', v_lote.codigo, v_lote.status));
  END IF;
  IF v_lote.quantidade_disponivel <= 0.0005 THEN
    RETURN jsonb_build_object('ok', false, 'erro', format('%s já está zerado.', v_lote.codigo));
  END IF;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'ajuste_inventario', p_responsavel_id,
          'Lote zerado no estoque' || COALESCE(': ' || NULLIF(trim(p_observacoes), ''), '.'))
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
  VALUES (v_mov_id, v_lote.id, v_lote.quantidade_disponivel, v_lote.unidade);

  UPDATE lotes
     SET quantidade_disponivel = 0, status = 'esgotado'::status_lote_enum,
         saldo_estimado = FALSE, updated_at = NOW()
   WHERE id = v_lote.id;

  RETURN jsonb_build_object('ok', true, 'movimentacao', v_mov_codigo,
                            'zerado', v_lote.quantidade_disponivel, 'unidade', v_lote.unidade);
END;
$function$;

REVOKE ALL ON FUNCTION zerar_lote(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION zerar_lote(uuid, uuid, uuid, text) TO authenticated, service_role;


-- ── 2. Abastecimento por unidade sem a contagem ─────────────
-- p_tinha NULL = ninguém contou: pula o acerto e só registra as caixas.
-- Partiu do banco (pg_get_functiondef), não da 127.
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

  IF p_tinha < 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'Diga quantas %ss fechadas ainda estavam na produção.', v_tipo));
  END IF;
  IF p_tinha IS NULL AND jsonb_array_length(COALESCE(p_itens, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Escaneie a caixa que está levando.');
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

  -- ── Acerto: só quando alguém contou (antes da 144, sempre) ─
  IF p_tinha IS NOT NULL THEN
    v_medido := ROUND(p_tinha * v_peso, 3);

    -- Contou fechadas num lugar que o sistema acha vazio, e não entrou nada:
    -- não há lote a quem atribuir.
    IF v_sistema <= 0 AND v_medido > 0 AND NOT EXISTS (SELECT 1 FROM _abu_itens) THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        'O sistema não tem %s na produção e não sabe de qual lote são essas %s. '
        'Registre junto com a próxima caixa que levar.', v_insumo.nome, p_tinha));
    END IF;

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
        v_orfao := v_medido;
      END IF;
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

  -- Contou: o número é medição. Sem contagem o lugar segue estimado.
  IF p_tinha IS NOT NULL THEN
    UPDATE locais
       SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW(), updated_at = NOW()
     WHERE id = v_local;
  END IF;

  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id);

  RETURN jsonb_build_object(
    'ok',          true,
    'movimentacao', v_mov_codigo,
    'tipo',        v_tipo,
    'tinha',       p_tinha,
    'levou',       v_levou,
    'total',       CASE WHEN p_tinha IS NULL THEN NULL ELSE p_tinha + v_levou END,
    'acerto',      CASE WHEN p_tinha IS NULL THEN 0 ELSE ROUND(v_medido - v_sistema, 3) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION registrar_abastecimento_unidades(uuid, uuid, uuid, integer, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_abastecimento_unidades(uuid, uuid, uuid, integer, jsonb, text) TO authenticated, service_role;


-- ── 3. A contagem do fechamento ─────────────────────────────
-- Antes do fechar_sessao_producao. p_itens: [{insumo_id, unidades}] — as
-- garrafas/pacotes FECHADOS que sobraram na produção (o aberto não conta,
-- mesma regra do reabastecimento).
--
-- A contagem é o físico DEPOIS desta sessão: o consumo dela já está dentro do
-- número. Por isso, para o insumo contado:
--   · a sessão não deve mais nada (consumo_teorico desce ao aplicado, e o
--     fechamento não cria dívida);
--   · a dívida de sessões já fechadas é quitada sem tirar nada (como a
--     pesagem, modo 'pesagem' da 143) — senão sairia de novo na próxima caixa.
CREATE OR REPLACE FUNCTION public.registrar_contagem_unidades(p_sessao_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_sessao     sessoes_producao%ROWTYPE;
  v_e          JSONB;
  v_insumo     insumos%ROWTYPE;
  v_unidades   INTEGER;
  v_peso       DECIMAL;
  v_tipo       TEXT;
  v_local      UUID;
  v_sistema    DECIMAL;
  v_medido     DECIMAL;
  v_fator      DECIMAL;
  v_dif        DECIMAL;
  v_linha      RECORD;
  v_lote       RECORD;
  v_mov        UUID;
  v_res        JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao WHERE id = p_sessao_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;
  IF v_sessao.status <> 'aberta'::status_sessao_enum THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'A sessão não está aberta.');
  END IF;

  -- Conferência antes de escrever
  FOR v_e IN SELECT * FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) LOOP
    IF (v_e->>'unidades') IS NULL OR (v_e->>'unidades')::INTEGER < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Falta a contagem de um dos insumos.');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM insumos_embalagem_config e
       WHERE e.insumo_id = (v_e->>'insumo_id')::UUID AND e.tem_subunidades AND e.subunidade_peso > 0) THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Insumo sem peso por unidade cadastrado.');
    END IF;
  END LOOP;

  FOR v_e IN SELECT * FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) LOOP
    SELECT * INTO v_insumo FROM insumos
     WHERE id = (v_e->>'insumo_id')::UUID AND empresa_id = p_empresa_id;
    v_unidades := (v_e->>'unidades')::INTEGER;

    SELECT e.subunidade_peso, COALESCE(e.subunidade_tipo, 'unidade') INTO v_peso, v_tipo
      FROM insumos_embalagem_config e
     WHERE e.insumo_id = v_insumo.id AND e.tem_subunidades AND e.subunidade_peso > 0;

    SELECT id INTO v_local FROM locais
     WHERE empresa_id = p_empresa_id AND insumo_id = v_insumo.id
       AND tipo = 'estoque_produtivo' AND ativo AND NOT efemero
     ORDER BY created_at DESC LIMIT 1;
    IF v_local IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s não tem lugar na produção cadastrado.', v_insumo.nome));
    END IF;

    SELECT COALESCE(SUM(quantidade), 0) INTO v_sistema FROM locais_lotes WHERE local_id = v_local;
    v_medido := ROUND(v_unidades * v_peso, 3);
    v_mov := NULL;

    IF ABS(v_medido - v_sistema) >= 0.001 THEN
      INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, sessao_producao_id, observacoes)
      VALUES (uuid_generate_v4(), p_empresa_id,
              gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV'),
              'acerto_recipiente', p_responsavel_id, p_sessao_id, format(
                'Contagem no fechamento: %s %ss %s na produção.', v_unidades, v_tipo,
                CASE WHEN v_tipo LIKE '%a' THEN 'fechadas' ELSE 'fechados' END))
      RETURNING id INTO v_mov;

      IF v_sistema > 0 THEN
        v_fator := v_medido / v_sistema;
        FOR v_linha IN
          SELECT lote_id, quantidade, unidade FROM locais_lotes
           WHERE local_id = v_local AND quantidade > 0
        LOOP
          v_dif := ROUND(v_linha.quantidade * v_fator, 3) - v_linha.quantidade;
          CONTINUE WHEN ABS(v_dif) < 0.001;
          INSERT INTO movimentacoes_itens
            (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
          VALUES (v_mov, v_linha.lote_id,
                  CASE WHEN v_dif < 0 THEN v_local END,
                  CASE WHEN v_dif > 0 THEN v_local END,
                  ABS(v_dif), v_linha.unidade);
        END LOOP;
        PERFORM ajustar_conteudo_recipiente(v_local, v_medido);
      ELSE
        -- O sistema acha vazio e a contagem diz que tem: vai para o último lote
        -- que entrou neste lugar (ou o mais novo do insumo), com a ressalva.
        SELECT lo.id, lo.codigo, lo.unidade, lo.validade_original INTO v_lote
          FROM lotes lo
          LEFT JOIN locais_lotes ll ON ll.lote_id = lo.id AND ll.local_id = v_local
         WHERE lo.insumo_id = v_insumo.id AND lo.empresa_id = p_empresa_id
         ORDER BY (ll.lote_id IS NOT NULL) DESC, ll.updated_at DESC NULLS LAST, lo.data_recebimento DESC
         LIMIT 1;
        IF v_lote.id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'erro', format(
            '%s não tem nenhum lote cadastrado.', v_insumo.nome));
        END IF;
        PERFORM abastecer_recipiente(v_local, v_lote.id, v_medido, v_lote.unidade, v_lote.validade_original);
        INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_mov, v_lote.id, v_local, v_medido, v_lote.unidade);
        PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'acerto_sem_lote',
          jsonb_build_object('quantidade', v_medido, 'lote', v_lote.codigo, 'sessao', v_sessao.codigo),
          'Contagem do fechamento achou unidades que o sistema não conhecia.');
      END IF;
    END IF;

    UPDATE locais
       SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW(), updated_at = NOW()
     WHERE id = v_local;

    -- O consumo desta sessão já está dentro do número contado.
    UPDATE sessoes_producao_locais
       SET consumo_teorico = consumo_aplicado
     WHERE sessao_id = p_sessao_id AND insumo_id = v_insumo.id;
    UPDATE consumo_pendente
       SET status = 'quitado', resolvido_em = NOW()
     WHERE empresa_id = p_empresa_id AND insumo_id = v_insumo.id AND status = 'aberto'
       AND (sessao_id = p_sessao_id
            OR sessao_id IN (SELECT id FROM sessoes_producao WHERE status = 'fechada'::status_sessao_enum));

    v_res := v_res || jsonb_build_object('insumo', v_insumo.nome, 'unidades', v_unidades,
                                         'acerto', ROUND(v_medido - v_sistema, 3));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'itens', v_res);
END;
$function$;

REVOKE ALL ON FUNCTION registrar_contagem_unidades(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_contagem_unidades(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

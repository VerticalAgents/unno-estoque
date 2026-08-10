-- ============================================================
-- Migration 083 — Abastecimento declarado pelo operador
--
-- O QUE MUDA. Até aqui a transferência MOVIA QUANTIDADE POR ARITMÉTICA: o
-- sistema calculava quanto cabia no pote e truncava o último lote bipado. O
-- operador nunca dizia quanto havia despejado, então quem virava "embalagem
-- aberta" era decidido pela ORDEM DA BIPAGEM. Bipar o saco fechado primeiro e
-- abrir o terceiro deixava o estoque central com um pacote aberto no papel e
-- fechado na prateleira.
--
-- Agora o operador enche à vontade e DECLARA PESANDO: o peso do pote (de onde
-- sai quanto entrou) e o peso da sobra de cada lote. Quem diz qual embalagem
-- ficou aberta é quem a abriu.
--
-- A DIFERENÇA É PERDA, E VIRA DADO. Pesando as duas pontas, o que saiu dos
-- lotes nunca bate com o que entrou nos potes. Essa diferença é a perda do
-- abastecimento — gravada em perdas_insumo com motivo 'abastecimento'
-- (migration 082), sem travar nada e sem pedir confirmação. A perda de período
-- continua sendo apurada na contagem; esta aqui é a parcela que se consegue
-- medir na hora.
--
-- ARMADILHA (a razão deste comentário): a perda é gravada por INSERT direto, e
-- NÃO chamando registrar_perda_insumo. Aquela RPC desconta do lote, e o saldo
-- já foi ajustado para a sobra medida. Chamá-la subtrairia a mesma perda duas
-- vezes.
--
-- CAPACIDADE NÃO TRAVA MAIS. capacidade_max é um número escolhido com margem
-- para baixo; tratá-lo como limite físico obrigava a abrir uma embalagem para
-- devolver a sobra. O que aconteceu já aconteceu: aqui a capacidade só serve
-- como referência na tela.
--
-- realizar_transferencia_multipla FICA COMO ESTÁ: continua sendo o caminho dos
-- modos embalagem_fornecedor, porcionado e escolher.
-- ============================================================

CREATE OR REPLACE FUNCTION registrar_abastecimento(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_insumo_id      UUID,
  p_potes          JSONB,   -- [{local_id, colocou}]  na unidade do cadastro
  p_lotes          JSONB,   -- [{lote_id, sobra}]     sobra 0 = zerou
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_insumo       insumos%ROWTYPE;
  v_p            RECORD;
  v_l            RECORD;
  v_colocado     DECIMAL := 0;
  v_consumido    DECIMAL := 0;
  v_perda        DECIMAL;
  v_mov_id       UUID;
  v_mov_codigo   TEXT;
  v_perda_mov_id UUID;
  v_perda_cod    TEXT;
  v_falta        DECIMAL;
  v_leva         DECIMAL;
  v_validade_ep  DATE;
  v_perda_resta  DECIMAL;
  v_perda_lote   DECIMAL;
  v_n            INTEGER;
  v_i            INTEGER := 0;
  v_potes_txt    TEXT;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  IF jsonb_array_length(COALESCE(p_potes, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe o que entrou em pelo menos um recipiente.');
  END IF;
  IF jsonb_array_length(COALESCE(p_lotes, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Escaneie os lotes que foram usados.');
  END IF;

  -- Limpa antes de criar: uma validação que retorna cedo não chega ao fim da
  -- função, e a temporária sobreviveria para a próxima chamada da mesma sessão.
  DROP TABLE IF EXISTS _ab_lotes;
  DROP TABLE IF EXISTS _ab_potes;

  -- Fotografia do estado ANTES de qualquer escrita. Sem ela, a distribuição da
  -- perda leria saldos já baixados e daria zero.
  CREATE TEMP TABLE _ab_lotes ON COMMIT DROP AS
  SELECT l.id, l.codigo, l.unidade, l.status, l.insumo_id,
         l.validade_original, l.validade_pos_abertura,
         l.quantidade_disponivel                                  AS saldo,
         ROUND(COALESCE((e->>'sobra')::DECIMAL, 0), 3)            AS sobra,
         ROUND(l.quantidade_disponivel
               - ROUND(COALESCE((e->>'sobra')::DECIMAL, 0), 3), 3) AS gasto,
         0::DECIMAL                                                AS distribuido
    FROM jsonb_array_elements(p_lotes) e
    JOIN lotes l ON l.id = (e->>'lote_id')::UUID AND l.empresa_id = p_empresa_id;

  CREATE TEMP TABLE _ab_potes ON COMMIT DROP AS
  SELECT (e->>'local_id')::UUID              AS local_id,
         ROUND((e->>'colocou')::DECIMAL, 3)  AS colocou,
         ROW_NUMBER() OVER ()                AS ordem
    FROM jsonb_array_elements(p_potes) e;

  IF (SELECT COUNT(*) FROM _ab_lotes) <> jsonb_array_length(p_lotes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  FOR v_l IN SELECT * FROM _ab_lotes LOOP
    IF v_l.insumo_id <> p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s é de outro insumo.', v_l.codigo));
    END IF;
    IF v_l.status <> 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s não está ativo (%s).', v_l.codigo, v_l.status));
    END IF;
    IF v_l.sobra < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'A sobra não pode ser negativa.');
    END IF;
    IF v_l.sobra > v_l.saldo + 0.001 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Sobra de %s no lote %s, que tinha %s. Confira a balança.',
               qtd_legivel(v_l.sobra), v_l.codigo, qtd_legivel(v_l.saldo)));
    END IF;
  END LOOP;

  FOR v_p IN SELECT * FROM _ab_potes LOOP
    IF COALESCE(v_p.colocou, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Recipiente sem quantidade: pese o pote ou tire-o da lista.');
    END IF;
    PERFORM 1 FROM locais l
     WHERE l.id = v_p.local_id AND l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo' AND l.ativo
       AND (l.insumo_id IS NULL OR l.insumo_id = p_insumo_id);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Um dos recipientes não existe ou é de outro insumo.');
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(colocou), 0) INTO v_colocado  FROM _ab_potes;
  SELECT COALESCE(SUM(gasto),   0) INTO v_consumido FROM _ab_lotes;

  IF v_consumido <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'As sobras declaradas dizem que nada saiu das embalagens.');
  END IF;
  IF v_colocado > v_consumido + 0.001 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Os recipientes receberam %s, mas das embalagens só saíram %s. '
             'Confira os pesos.', qtd_legivel(v_colocado), qtd_legivel(v_consumido)));
  END IF;

  v_perda := ROUND(v_consumido - v_colocado, 3);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
          p_responsavel_id, p_justificativa)
  RETURNING id INTO v_mov_id;

  -- Qual lote foi para qual pote não é perguntado: na prática é um lote só, e
  -- os potes rodam todos na produção seguinte. Regra fixa (FEFO) para o
  -- resultado ser sempre explicável.
  FOR v_p IN SELECT * FROM _ab_potes ORDER BY ordem LOOP
    v_falta := v_p.colocou;

    FOR v_l IN
      SELECT * FROM _ab_lotes
       WHERE gasto - distribuido > 0
       ORDER BY validade_pos_abertura, codigo
    LOOP
      EXIT WHEN v_falta <= 0;
      v_leva := LEAST(v_falta, v_l.gasto - v_l.distribuido);
      CONTINUE WHEN v_leva <= 0;

      v_validade_ep := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_l.validade_original)
        ELSE v_l.validade_original
      END;

      PERFORM abastecer_recipiente(v_p.local_id, v_l.id, v_leva, v_l.unidade, v_validade_ep);

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_l.id, v_p.local_id, v_leva, v_l.unidade);

      UPDATE _ab_lotes SET distribuido = distribuido + v_leva WHERE id = v_l.id;
      v_falta := v_falta - v_leva;
    END LOOP;
  END LOOP;

  UPDATE lotes l
     SET quantidade_disponivel = a.sobra,
         status = CASE WHEN a.sobra <= 0 THEN 'esgotado'::status_lote_enum ELSE l.status END
    FROM _ab_lotes a
   WHERE l.id = a.id;

  -- INSERT direto de propósito: registrar_perda_insumo desconta do lote, e o
  -- saldo acima já é o medido. Chamá-la subtrairia a perda duas vezes.
  IF v_perda > 0 THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'perda_insumo', p_responsavel_id,
            'Diferença entre o que saiu das embalagens e o que entrou nos recipientes.')
    RETURNING id INTO v_perda_mov_id;

    v_perda_resta := v_perda;
    SELECT COUNT(*) INTO v_n FROM _ab_lotes WHERE gasto > 0;

    FOR v_l IN
      SELECT * FROM _ab_lotes WHERE gasto > 0 ORDER BY validade_pos_abertura, codigo
    LOOP
      v_i := v_i + 1;
      IF v_i = v_n THEN
        v_perda_lote := v_perda_resta;               -- a última fecha a conta
      ELSE
        v_perda_lote := LEAST(ROUND(v_perda * (v_l.gasto / v_consumido), 3), v_perda_resta);
      END IF;
      CONTINUE WHEN COALESCE(v_perda_lote, 0) <= 0;

      v_perda_cod := gerar_proximo_codigo(p_empresa_id, 'perdas_insumo', 'PERDA');
      INSERT INTO perdas_insumo (
        empresa_id, codigo, lote_id, insumo_id, local_id,
        quantidade, unidade, motivo, descricao, responsavel_id
      ) VALUES (
        p_empresa_id, v_perda_cod, v_l.id, p_insumo_id, NULL,
        v_perda_lote, v_l.unidade, 'abastecimento',
        format('Abastecimento: saiu %s das embalagens e entrou %s nos recipientes.',
               qtd_legivel(v_consumido), qtd_legivel(v_colocado)),
        p_responsavel_id
      );

      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
      VALUES (v_perda_mov_id, v_l.id, v_perda_lote, v_l.unidade);

      v_perda_resta := v_perda_resta - v_perda_lote;
    END LOOP;
  END IF;

  SELECT string_agg(l.nome, ', ' ORDER BY l.nome) INTO v_potes_txt
    FROM _ab_potes p JOIN locais l ON l.id = p.local_id;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id', v_mov_id,
    'colocado',  ROUND(v_colocado, 3),
    'consumido', ROUND(v_consumido, 3),
    'perda',     v_perda,
    'recipientes', v_potes_txt
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_abastecimento(UUID, UUID, UUID, JSONB, JSONB, TEXT) IS
  'Abastecimento do EP declarado pelo operador: peso do pote e peso da sobra. '
  'A diferença vira perda com motivo abastecimento. Capacidade não trava.';

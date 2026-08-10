-- ============================================================
-- Migration 084 — A folga de balança do abastecimento
--
-- O DEFEITO. A 083 recusava o abastecimento quando os potes recebiam mais do
-- que saiu das embalagens, com 1 grama de folga. Na primeira vez que foi usada
-- de verdade travou: 32,298 kg saíram e 32,300 kg entraram — 2 g em 32 kg.
--
-- POR QUE ISSO ACONTECE SEMPRE. São duas medições independentes: o peso do
-- pote (bruto menos tara) e o peso da sobra. Cada uma tem seu erro, e os erros
-- somam. Exigir que fechem no grama é exigir que duas réguas diferentes deem o
-- mesmo número.
--
-- A ASSIMETRIA. Faltar é normal: o que sobra no funil e na colher é a perda,
-- que é justamente o dado que se quer. Sobrar é fisicamente impossível — o
-- pote não pode receber mais do que saiu das embalagens. Então "a mais" só tem
-- duas explicações, de tamanhos muito diferentes: ruído de balança (gramas) ou
-- uma embalagem que não foi bipada (quilos). A trava só precisa pegar a
-- segunda.
--
-- A FOLGA É 2% do que saiu, percentual e não fixo: cada insumo tem uma
-- dimensão. Por baixo, precisa ser maior que o ruído — numa operação de 300 g
-- uma tara desatualizada em 5 g já é 1,7%, e 1% travaria os insumos pequenos.
-- Por cima, precisa ser menor que uma embalagem esquecida: com cinco
-- embalagens, esquecer uma dá ~25%. Com 2%, uma embalagem só passaria
-- despercebida numa operação com mais de cinquenta delas.
--
-- QUEM CEDE. A SOBRA. Ela é uma pesagem só, feita rápido, com a embalagem
-- suja e sem descontar tara; o conteúdo do pote é a base de tudo que a
-- produção vai consumir depois. Então o lote devolve um pouco menos ao estoque
-- e o pote fica com o que a balança disse.
--
-- Se todas as embalagens zeraram não há sobra para ceder, e aí o pote cede —
-- que é o correto: se não sobrou nada em lugar nenhum, quem pesou a mais foi
-- o pote. Isso já era o comportamento da 083, mas em silêncio; agora volta
-- declarado na resposta.
--
-- ACIMA DA FOLGA, AVISA — não bloqueia. Mesmo desenho das outras travas: diz
-- o que está estranho, pede explicação escrita e registra. Prender o operador
-- no meio da produção não desfaz o que já foi despejado.
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
  -- Folga de balança
  v_excesso      DECIMAL := 0;
  v_folga        DECIMAL;
  v_sobra_total  DECIMAL;
  v_ceder        DECIMAL;
  v_ceder_resta  DECIMAL;
  v_ceder_lote   DECIMAL;
  v_ajustes      JSONB := '[]'::JSONB;
  v_potes_cedem  DECIMAL := 0;
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

  -- ── Folga de balança ──────────────────────────────────────
  v_excesso := ROUND(v_colocado - v_consumido, 3);

  IF v_excesso > 0 THEN
    v_folga := ROUND(v_consumido * 0.02, 3);

    -- Acima da folga é grande demais para ser balança. Avisa e espera a
    -- explicação; com ela escrita, segue e fica registrado.
    IF v_excesso > v_folga
       AND COALESCE(length(trim(p_justificativa)), 0) < 5 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'trava', 'excesso_abastecimento',
        'excesso', v_excesso,
        'folga',   v_folga,
        'mensagem', format(
          'Os recipientes receberam %s e das embalagens só saíram %s — %s a mais, '
          'muito além da margem da balança (%s). Quase sempre isso quer dizer que '
          'faltou bipar uma embalagem.',
          qtd_legivel(v_colocado), qtd_legivel(v_consumido),
          qtd_legivel(v_excesso), qtd_legivel(v_folga)));
    END IF;

    -- A sobra cede: o lote devolve menos ao estoque e o pote fica com o que a
    -- balança disse. Proporcional ao tamanho de cada sobra, a última fechando
    -- a conta — mesma regra da distribuição da perda, logo abaixo.
    SELECT COALESCE(SUM(sobra), 0) INTO v_sobra_total FROM _ab_lotes;
    v_ceder := LEAST(v_excesso, v_sobra_total);

    IF v_ceder > 0 THEN
      v_ceder_resta := v_ceder;
      SELECT COUNT(*) INTO v_n FROM _ab_lotes WHERE sobra > 0;
      v_i := 0;

      FOR v_l IN
        SELECT * FROM _ab_lotes WHERE sobra > 0 ORDER BY validade_pos_abertura, codigo
      LOOP
        v_i := v_i + 1;
        IF v_i = v_n THEN
          v_ceder_lote := LEAST(v_ceder_resta, v_l.sobra);
        ELSE
          v_ceder_lote := LEAST(ROUND(v_ceder * (v_l.sobra / v_sobra_total), 3),
                                v_ceder_resta, v_l.sobra);
        END IF;
        CONTINUE WHEN COALESCE(v_ceder_lote, 0) <= 0;

        UPDATE _ab_lotes
           SET sobra = sobra - v_ceder_lote,
               gasto = gasto + v_ceder_lote
         WHERE id = v_l.id;

        v_ajustes := v_ajustes || jsonb_build_object(
          'codigo',          v_l.codigo,
          'sobra_declarada', v_l.sobra,
          'sobra_ajustada',  ROUND(v_l.sobra - v_ceder_lote, 3));

        v_ceder_resta := v_ceder_resta - v_ceder_lote;
      END LOOP;

      SELECT COALESCE(SUM(gasto), 0) INTO v_consumido FROM _ab_lotes;
    END IF;

    -- Não havia sobra suficiente para ceder: o resto sai do pote, que fica com
    -- um pouco menos do que a balança marcou. Volta declarado para a tela
    -- poder dizer isso em vez de o número mudar sozinho.
    v_potes_cedem := ROUND(GREATEST(v_colocado - v_consumido, 0), 3);
    v_i := 0;
  END IF;

  v_perda := GREATEST(ROUND(v_consumido - v_colocado, 3), 0);

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
        v_perda_lote := v_perda_resta;
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
    'recipientes', v_potes_txt,
    -- O que a folga de balança teve de acertar, para a tela poder contar em vez
    -- de deixar o número mudar sozinho.
    'excesso',        v_excesso,
    'sobras_ajustadas', v_ajustes,
    'potes_cederam',  v_potes_cedem
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_abastecimento(UUID, UUID, UUID, JSONB, JSONB, TEXT) IS
  'Abastecimento do EP declarado pelo operador: peso do pote e peso da sobra. '
  'Diferença a menos vira perda com motivo abastecimento. Diferença a mais até '
  '2% é folga de balança e a sobra cede; acima disso avisa e pede justificativa. '
  'Capacidade não trava.';

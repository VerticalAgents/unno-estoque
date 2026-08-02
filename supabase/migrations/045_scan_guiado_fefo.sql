-- ============================================================
-- Migration 045 — A trava age na leitura do QR, não no fim
--
-- TRÊS COISAS QUE FALTAVAM
--
-- 1. A trava `fefo` existia na configuração e não era aplicada por ninguém.
--    A regra real da operação: o lote que voltou aberto para o estoque tem que
--    ser escaneado. Onde ele vai parar dentro dos recipientes não importa —
--    o que importa é que ele saia do estoque central antes dos fechados.
--
-- 2. Não havia limite para o que o operador podia escanear. Dava para levar
--    para a produção 3 sublotes quando só cabia 1, e o excedente voltaria
--    inteiro depois. Carga carregada à toa.
--
--    O limite é o espaço livre somado dos recipientes daquele insumo. Só dá
--    para escanear mais um lote enquanto o acumulado ainda não cobriu esse
--    espaço — o último pode passar, e é dele que sai a sobra que volta.
--
--    Ex.: potes de açúcar somam 34 kg, já têm 10 → cabem 24.
--         5 (aberto) + 10 + 10 = 25. O quarto sublote não pode ser escaneado.
--         Vai 24 para os potes e 1 kg volta ao estoque, virando o novo aberto.
--
-- 3. `realizar_transferencia_multipla` transferia sempre o saldo inteiro de
--    cada lote. Não sabia parar na capacidade do recipiente. Agora enche até
--    onde cabe, na ordem em que os QR foram lidos, e devolve o que sobrou.
--
-- REGRA QUE CAI AQUI: "todos os sublotes do mesmo recebimento".
-- Ela vinha do tempo em que um recipiente só podia ter um lote (RO-003,
-- revogada na 035). Com a regra do lote aberto único ela virou impossível de
-- cumprir: o aberto que voltou é quase sempre de um recebimento anterior ao
-- dos fechados que vão junto. No lugar dela ficam duas exigências mais
-- honestas — mesmo insumo e mesma marca.
-- ============================================================

-- ============================================================
-- 1. validar_scan_lote — chamada a cada QR lido no estoque central
--
-- É aqui que as duas travas agem, porque é aqui que o operador ainda pode
-- corrigir: largar o sublote errado e pegar o certo, sem ter carregado nada.
-- ============================================================
CREATE OR REPLACE FUNCTION validar_scan_lote(
  p_empresa_id     UUID,
  p_lote_id        UUID,
  p_ja_escaneados  UUID[] DEFAULT ARRAY[]::UUID[],
  p_justificativa  TEXT   DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_primeiro      lotes%ROWTYPE;
  v_aberto        lotes%ROWTYPE;
  v_espaco        DECIMAL;
  v_potes         INTEGER;
  v_ja            DECIMAL := 0;
  v_trava         JSONB;
  v_marca_escan   UUID;
BEGIN
  SELECT * INTO v_lote
    FROM lotes
   WHERE id = p_lote_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' OR v_lote.quantidade_disponivel <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está disponível (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF p_lote_id = ANY(p_ja_escaneados) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este lote já foi escaneado.');
  END IF;

  -- ── Coerência com o que já foi lido ───────────────────────
  IF array_length(p_ja_escaneados, 1) > 0 THEN
    SELECT * INTO v_primeiro FROM lotes WHERE id = p_ja_escaneados[1];

    IF v_primeiro.insumo_id <> v_lote.insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Este lote é de outro insumo. Uma transferência leva um insumo só.');
    END IF;

    -- Marca continua sendo inegociável: não se mistura no recipiente, então
    -- não faz sentido nem carregar junto.
    SELECT (ARRAY_AGG(l.marca_id) FILTER (WHERE l.marca_id IS NOT NULL))[1]
      INTO v_marca_escan
      FROM lotes l WHERE l.id = ANY(p_ja_escaneados);

    IF v_marca_escan IS NOT NULL AND v_lote.marca_id IS NOT NULL
       AND v_marca_escan <> v_lote.marca_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Este lote é de outra marca. Marcas não podem ir juntas.');
    END IF;

    SELECT COALESCE(SUM(l.quantidade_disponivel), 0) INTO v_ja
      FROM lotes l WHERE l.id = ANY(p_ja_escaneados);
  END IF;

  -- ── Espaço livre somado dos recipientes deste insumo ──────
  SELECT COUNT(*), COALESCE(SUM(c.espaco_livre), 0)
    INTO v_potes, v_espaco
    FROM v_recipientes_composicao c
   WHERE c.empresa_id = p_empresa_id
     AND c.insumo_id  = v_lote.insumo_id;

  IF v_potes = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este insumo não tem recipiente cadastrado no estoque produtivo. '
      'Cadastre o recipiente antes de transferir.');
  END IF;

  -- ── TRAVA: fefo — o lote aberto tem que sair primeiro ─────
  -- Só faz sentido cobrar na primeira leitura: se o aberto já está na lista,
  -- a regra está cumprida e a ordem física de despejo não importa.
  IF NOT EXISTS (
    SELECT 1 FROM lotes l
     WHERE l.id = ANY(p_ja_escaneados)
       AND l.quantidade_disponivel < l.quantidade_recebida
  ) THEN
    SELECT * INTO v_aberto
      FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.insumo_id  = v_lote.insumo_id
       AND l.status     = 'ativo'
       AND l.quantidade_disponivel > 0
       AND l.quantidade_disponivel < l.quantidade_recebida
     ORDER BY l.validade_pos_abertura, l.codigo
     LIMIT 1;

    IF FOUND AND v_aberto.id <> p_lote_id THEN
      v_trava := avaliar_trava(p_empresa_id, 'fefo', p_justificativa);
      IF NOT (v_trava->>'permitido')::BOOLEAN THEN
        RETURN v_trava || jsonb_build_object(
          'ok', false, 'trava', 'fefo',
          'lote_esperado', v_aberto.codigo,
          'lote_esperado_saldo', ROUND(v_aberto.quantidade_disponivel, 3),
          'mensagem', format(
            'Comece pelo lote %s, que está aberto no estoque com %s %s. '
            'Ele tem que sair antes de qualquer embalagem fechada.',
            v_aberto.codigo,
            ROUND(v_aberto.quantidade_disponivel, 3),
            v_aberto.unidade));
      END IF;
      PERFORM registrar_excecao(p_empresa_id, NULL, 'fefo',
        jsonb_build_object('lote_lido', v_lote.codigo,
                           'lote_esperado', v_aberto.codigo),
        p_justificativa);
    END IF;
  END IF;

  -- ── TRAVA: escanear mais do que cabe ──────────────────────
  -- O acumulado ANTES desta leitura já cobria o espaço livre: este lote
  -- inteiro voltaria para o estoque. Carga inútil.
  IF v_ja >= v_espaco THEN
    v_trava := avaliar_trava(p_empresa_id, 'excede_capacidade', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object(
        'ok', false, 'trava', 'excede_capacidade',
        'mensagem', CASE
          WHEN v_espaco <= 0 THEN
            'Os recipientes deste insumo estão cheios. Não há onde colocar.'
          ELSE format(
            'Já foram escaneados %s %s e nos recipientes só cabem %s. '
            'Este lote voltaria inteiro para o estoque.',
            ROUND(v_ja, 3), v_lote.unidade, ROUND(v_espaco, 3))
        END);
    END IF;
    PERFORM registrar_excecao(p_empresa_id, NULL, 'excede_capacidade',
      jsonb_build_object('lote_lido', v_lote.codigo,
                         'ja_escaneado', v_ja, 'espaco_livre', v_espaco),
      p_justificativa);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'espaco_livre',   ROUND(v_espaco, 3),
    'ja_escaneado',   ROUND(v_ja, 3),
    'total_com_este', ROUND(v_ja + v_lote.quantidade_disponivel, 3),
    -- quanto deste lote deve efetivamente ficar nos recipientes
    'aproveita',      ROUND(LEAST(v_lote.quantidade_disponivel,
                                  GREATEST(v_espaco - v_ja, 0)), 3),
    'volta_ao_estoque', ROUND(GREATEST(
                          v_ja + v_lote.quantidade_disponivel - v_espaco, 0), 3)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION validar_scan_lote IS
  'Valida cada QR lido no estoque central: obriga a começar pelo lote aberto '
  '(trava fefo) e impede escanear mais do que cabe nos recipientes do insumo '
  '(trava excede_capacidade). É o ponto onde o operador ainda pode corrigir.';

-- ============================================================
-- 2. realizar_transferencia_multipla — enche até onde cabe
--
-- Antes despejava o saldo inteiro de todos os lotes, sem olhar a capacidade.
-- Agora coloca no recipiente só o que cabe, consumindo os lotes na ordem em
-- que foram lidos. O que sobrar continua no estoque central — e, como a
-- ordem começa pelo lote aberto, a sobra fica sempre no último lote lido.
-- Um aberto entra, um aberto sai.
-- ============================================================
DROP FUNCTION IF EXISTS realizar_transferencia_multipla(UUID[], UUID, UUID, UUID);
DROP FUNCTION IF EXISTS realizar_transferencia_multipla(UUID[], UUID, UUID, UUID, TEXT);

CREATE OR REPLACE FUNCTION realizar_transferencia_multipla(
  p_lote_ids       UUID[],
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID,
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote        lotes%ROWTYPE;
  v_lote_id     UUID;
  v_insumo_id   UUID;
  v_marca_id    UUID;
  v_qtd_total   DECIMAL := 0;
  v_insumo      insumos%ROWTYPE;
  v_local       locais%ROWTYPE;
  v_validade_ep DATE;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_total_atual DECIMAL;
  v_marca_conteudo UUID;
  v_espaco      DECIMAL;
  v_restante    DECIMAL;
  v_leva        DECIMAL;
  v_colocado    DECIMAL := 0;
  v_sobras      JSONB := '[]'::JSONB;
  v_trava       JSONB;
  v_contexto    JSONB;
BEGIN
  IF array_length(p_lote_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhum lote fornecido.');
  END IF;

  -- ── Conferência dos lotes ─────────────────────────────────
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id AND empresa_id = p_empresa_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro', format('Lote %s não encontrado.', v_lote_id));
    END IF;
    IF v_lote.status <> 'ativo' OR v_lote.quantidade_disponivel <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Lote %s não está disponível (status: %s).', v_lote.codigo, v_lote.status));
    END IF;

    -- Mesmo insumo (substitui a exigência de mesmo recebimento)
    IF v_insumo_id IS NULL THEN
      v_insumo_id := v_lote.insumo_id;
    ELSIF v_lote.insumo_id <> v_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Todos os lotes devem ser do mesmo insumo.');
    END IF;

    IF v_lote.marca_id IS NOT NULL THEN
      IF v_marca_id IS NULL THEN
        v_marca_id := v_lote.marca_id;
      ELSIF v_lote.marca_id <> v_marca_id THEN
        RETURN jsonb_build_object('ok', false, 'erro',
          'Os lotes são de marcas diferentes e não podem ir juntos.');
      END IF;
    END IF;

    v_qtd_total := v_qtd_total + v_lote.quantidade_disponivel;
  END LOOP;

  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_insumo_id THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este recipiente é dedicado a outro insumo.');
  END IF;

  SELECT COALESCE(SUM(ll.quantidade), 0),
         (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1]
    INTO v_total_atual, v_marca_conteudo
    FROM locais_lotes ll
    JOIN lotes lo ON lo.id = ll.lote_id
   WHERE ll.local_id = p_local_id AND ll.quantidade > 0;

  v_contexto := jsonb_build_object(
    'lotes', array_length(p_lote_ids, 1), 'recipiente', v_local.nome, 'quantidade', v_qtd_total
  );

  -- ── TRAVA: marca diferente ────────────────────────────────
  IF (v_marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
      AND v_marca_id <> v_local.marca_id)
     OR (v_marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
         AND v_marca_id <> v_marca_conteudo) THEN
    v_trava := avaliar_trava(p_empresa_id, 'marca_diferente', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'marca_diferente',
        'mensagem', 'Este recipiente é de outra marca. Misturar marcas compromete a rastreabilidade.');
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'marca_diferente',
                              v_contexto, p_justificativa);
  END IF;

  -- ── TRAVA: fefo (rede de segurança) ───────────────────────
  -- validar_scan_lote já barra isso na leitura do QR e registra a exceção
  -- quando o operador justifica. Aqui é só para quem chegar por fora da tela;
  -- por isso não registra de novo — só recusa.
  IF EXISTS (
    SELECT 1 FROM lotes l
     WHERE l.empresa_id = p_empresa_id
       AND l.insumo_id  = v_insumo_id
       AND l.status     = 'ativo'
       AND l.quantidade_disponivel > 0
       AND l.quantidade_disponivel < l.quantidade_recebida
       AND NOT (l.id = ANY(p_lote_ids))
  ) THEN
    v_trava := avaliar_trava(p_empresa_id, 'fefo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object('ok', false, 'trava', 'fefo',
        'mensagem', 'Há um lote aberto deste insumo no estoque que não foi escaneado. '
                    'Ele precisa sair antes das embalagens fechadas.');
    END IF;
  END IF;

  -- ── Quanto cabe ───────────────────────────────────────────
  -- Sem capacidade cadastrada não há como saber o limite: leva tudo, como antes.
  v_espaco := CASE
    WHEN v_local.capacidade_max IS NULL THEN v_qtd_total
    ELSE GREATEST(v_local.capacidade_max - v_total_atual, 0)
  END;

  IF v_espaco <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s já está cheio (%s de %s).', v_local.nome,
             ROUND(v_total_atual, 3), v_local.capacidade_max));
  END IF;

  v_restante := LEAST(v_qtd_total, v_espaco);

  SELECT * INTO v_insumo FROM insumos WHERE id = v_insumo_id;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
          p_responsavel_id, p_justificativa)
  RETURNING id INTO v_mov_id;

  -- ── Execução, na ordem em que os QR foram lidos ───────────
  FOREACH v_lote_id IN ARRAY p_lote_ids LOOP
    SELECT * INTO v_lote FROM lotes WHERE id = v_lote_id;

    v_leva := LEAST(v_lote.quantidade_disponivel, v_restante);

    IF v_leva <= 0 THEN
      -- Não coube nada deste lote: fica inteiro no estoque central.
      v_sobras := v_sobras || jsonb_build_object(
        'codigo', v_lote.codigo,
        'quantidade', ROUND(v_lote.quantidade_disponivel, 3));
      CONTINUE;
    END IF;

    v_validade_ep := CASE
      WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
      THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
      ELSE v_lote.validade_original
    END;

    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
    VALUES (v_mov_id, v_lote_id, p_local_id, v_leva, v_lote.unidade);

    PERFORM abastecer_recipiente(p_local_id, v_lote_id, v_leva, v_lote.unidade, v_validade_ep);

    UPDATE lotes
       SET quantidade_disponivel = quantidade_disponivel - v_leva,
           status = CASE
             WHEN quantidade_disponivel - v_leva <= 0 THEN 'esgotado'::status_lote_enum
             ELSE status
           END
     WHERE id = v_lote_id;

    IF v_lote.quantidade_disponivel - v_leva > 0 THEN
      v_sobras := v_sobras || jsonb_build_object(
        'codigo', v_lote.codigo,
        'quantidade', ROUND(v_lote.quantidade_disponivel - v_leva, 3));
    END IF;

    v_colocado := v_colocado + v_leva;
    v_restante := v_restante - v_leva;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao_id',   v_mov_id,
    'codigo',            v_mov_codigo,
    'quantidade_total',  ROUND(v_colocado, 3),
    'escaneado_total',   ROUND(v_qtd_total, 3),
    'volta_ao_estoque',  ROUND(v_qtd_total - v_colocado, 3),
    'sobras',            v_sobras,
    'recipiente_cheio',  v_local.capacidade_max IS NOT NULL
                         AND (v_total_atual + v_colocado) >= v_local.capacidade_max,
    'misturou',          v_total_atual > 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION realizar_transferencia_multipla IS
  'Enche o recipiente até a capacidade, consumindo os lotes na ordem em que os '
  'QR foram lidos. O que não coube continua no estoque central e volta em '
  'sobras. Exige mesmo insumo e mesma marca — a exigência de mesmo recebimento '
  'foi removida, era incompatível com a regra do lote aberto único.';

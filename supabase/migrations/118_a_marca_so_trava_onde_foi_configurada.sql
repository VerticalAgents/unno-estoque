-- ============================================================
-- Migration 118 — a marca só trava onde alguém disse que trava
--
-- O CASO, em 07/09/2026: o chocolate em pó do último recebimento é Sicao, o
-- que está no pote é Melken, e a produção não conseguia repor. A trava
-- recusava na hora de bipar o lote.
--
-- Os dois potes de chocolate NÃO TÊM MARCA CONFIGURADA. O que recusava era a
-- checagem contra o CONTEÚDO ATUAL — uma trava implícita, que ninguém ligou e
-- que aparecia só quando atrapalhava.
--
-- A regra passa a ser a do Lucca, e é melhor: **a marca trava quando o
-- recipiente tem marca configurada.** Sem configuração, entra o que for. Quem
-- decide é o cadastro do recipiente, não o acaso do que entrou primeiro.
--
-- ------ O que muda, e o que fica -----------------------------
--
-- FICA a trava contra `locais.marca_id`. São 31 recipientes hoje — doce de
-- leite, glucose, baunilha, alecrim, essência de DDL. Neles nada muda: a
-- embalagem do fornecedor É o ponto de consumo e a marca vem do lote.
--
-- SAI a trava contra a marca do conteúdo atual, nas duas funções que a faziam
-- (`validar_transferencia_para_local` e `realizar_transferencia`).
--
-- SAI TAMBÉM a checagem entre lotes bipados, em `validar_scan_lote`. Ela roda
-- ANTES do recipiente ser escaneado, então não tem como saber se o destino tem
-- marca fixa — recusar ali bloquearia o pote livre também. Quem precisa
-- recusar é a transferência, que já conhece o destino.
--
-- ------ O que se perde ---------------------------------------
--
-- Rastreabilidade: um pote com duas marcas dentro entrega as duas ao rateio, e
-- um recall de uma delas alcança produção feita com a outra. É custo aceito
-- conscientemente, e reversível — basta configurar a marca no recipiente que a
-- trava volta para ele.
--
-- Partiu de pg_get_functiondef — ver CLAUDE.md.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validar_transferencia_para_local(p_local_id uuid, p_lote_id uuid, p_quantidade numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_local        locais%ROWTYPE;
  v_lote         lotes%ROWTYPE;
  v_total_atual  DECIMAL;
  v_qtd_lotes    INTEGER;
  v_marca_conteudo UUID;
BEGIN
  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.tipo = 'estoque_central' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Não é possível transferir para o Estoque Central por este fluxo.');
  END IF;

  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  -- Insumo do recipiente
  IF v_local.insumo_id IS NOT NULL AND v_local.insumo_id <> v_lote.insumo_id THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este recipiente é dedicado a outro insumo.');
  END IF;

  -- Conteúdo atual do pote
  SELECT COALESCE(SUM(ll.quantidade), 0),
         COUNT(*) FILTER (WHERE ll.quantidade > 0),
         (ARRAY_AGG(lo.marca_id) FILTER (WHERE ll.quantidade > 0 AND lo.marca_id IS NOT NULL))[1]
    INTO v_total_atual, v_qtd_lotes, v_marca_conteudo
    FROM locais_lotes ll
    JOIN lotes lo ON lo.id = ll.lote_id
   WHERE ll.local_id = p_local_id AND ll.quantidade > 0;

  -- MARCA: contra a marca configurada no recipiente e contra o que já está dentro
  IF v_lote.marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
     AND v_lote.marca_id <> v_local.marca_id THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Marca do lote incompatível com o recipiente.');
  END IF;

  -- A marca do CONTEÚDO deixou de travar: ver o cabeçalho da migration.
  IF FALSE AND v_lote.marca_id IS NOT NULL AND v_marca_conteudo IS NOT NULL
     AND v_lote.marca_id <> v_marca_conteudo THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este recipiente já contém lote de outra marca. Não é permitido misturar marcas.');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'quantidade_atual', v_total_atual,
    'lotes_no_recipiente', COALESCE(v_qtd_lotes, 0),
    'vai_misturar', COALESCE(v_qtd_lotes, 0) > 0,
    -- aviso, não bloqueio: quem manda é a balança
    'excede_capacidade', (v_local.capacidade_max IS NOT NULL
                          AND v_total_atual + p_quantidade > v_local.capacidade_max)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.realizar_transferencia(p_lote_id uuid, p_local_id uuid, p_quantidade numeric, p_responsavel_id uuid, p_empresa_id uuid, p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  -- Só a marca CONFIGURADA no recipiente trava. O que já está dentro não
  -- manda: ver o cabeçalho da migration.
  IF v_lote.marca_id IS NOT NULL AND v_local.marca_id IS NOT NULL
     AND v_lote.marca_id <> v_local.marca_id THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.validar_scan_lote(p_empresa_id uuid, p_lote_id uuid, p_ja_escaneados uuid[] DEFAULT ARRAY[]::uuid[], p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_primeiro      lotes%ROWTYPE;
  v_aberto        lotes%ROWTYPE;
  v_espaco        DECIMAL;
  v_potes         INTEGER;
  v_ja            DECIMAL := 0;
  v_trava         JSONB;
  v_marca_escan   UUID;
  -- Como este insumo ocupa o estoque produtivo (migration 073)
  v_modo          TEXT;
  v_exige_pote    BOOLEAN;
BEGIN
  SELECT * INTO v_lote
    FROM lotes
   WHERE id = p_lote_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  -- Como este insumo ocupa o EP decide se um recipiente é obrigatório.
  -- `recipiente` e `porcionado` despejam em algo cadastrado; a embalagem do
  -- fornecedor É o ponto de consumo, e não ter pote é a definição dela.
  SELECT COALESCE(cfg.modo_ep::TEXT, 'recipiente') INTO v_modo
    FROM insumos i
    LEFT JOIN insumos_armazenamento_config cfg ON cfg.insumo_id = i.id
   WHERE i.id = v_lote.insumo_id;

  v_exige_pote := COALESCE(v_modo, 'recipiente') IN ('recipiente', 'porcionado');

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

    -- A checagem entre lotes bipados saiu junto. Ela é anterior ao recipiente
    -- — o destino só é escaneado depois —, então não tem como saber se aquele
    -- pote tem marca fixa. Recusar aqui bloquearia o pote livre também, e
    -- quem de fato precisa recusar é a transferência, que já conhece o destino.

    SELECT COALESCE(SUM(l.quantidade_disponivel), 0) INTO v_ja
      FROM lotes l WHERE l.id = ANY(p_ja_escaneados);
  END IF;

  -- ── Espaço livre somado dos recipientes deste insumo ──────
  SELECT COUNT(*), COALESCE(SUM(c.espaco_livre), 0)
    INTO v_potes, v_espaco
    FROM v_recipientes_composicao c
   WHERE c.empresa_id = p_empresa_id
     AND c.insumo_id  = v_lote.insumo_id;

  IF v_potes = 0 AND v_exige_pote THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este insumo não tem recipiente cadastrado no estoque produtivo. '
      'Cadastre o recipiente antes de transferir.');
  END IF;

  -- Sem pote e sem precisar de um: a embalagem carrega a si mesma, e não há
  -- espaço a disputar. Sem esta linha o espaço livre seria zero e as duas
  -- contas abaixo diriam "os recipientes estão cheios" e "aproveita: 0" --
  -- sobre recipientes que não existem nem deveriam existir.
  IF v_potes = 0 THEN
    v_espaco := v_ja + v_lote.quantidade_disponivel;
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
    'modo_ep',        v_modo,
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
$function$
;

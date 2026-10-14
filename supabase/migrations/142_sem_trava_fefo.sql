-- ============================================================
-- Migration 142 — a trava fefo sai por completo
--
-- O CASO, em 14/10/2026: ao abastecer, o bipe recusava a embalagem fechada
-- enquanto houvesse uma aberta do mesmo insumo no estoque central, e cobrava
-- justificativa escrita para passar. Na prática atrapalhava mais do que
-- protegia.
--
-- A REGRA (Lucca, 14/10/2026): tirar a trava inteira. O operador bipa a
-- embalagem que quiser, sem recusa e sem justificativa. A tela de
-- abastecimento passa a mostrar só uma dica fixa — usar primeiro a embalagem
-- que está há mais tempo no estoque —, sem dizer qual.
--
-- O QUE SAI
--   - validar_scan_lote: o bloco `fefo` (leitura do QR)
--   - realizar_transferencia_multipla: a rede de segurança `fefo`
--   - inicializar_travas_padrao: empresa nova não nasce mais com `fefo`
--   - travas_config: a linha `fefo` (some de Configurações → Travas)
-- O histórico em excecoes_registradas fica: é registro do que aconteceu.
--
-- Partiu de pg_get_functiondef — ver CLAUDE.md.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validar_scan_lote(p_empresa_id uuid, p_lote_id uuid, p_ja_escaneados uuid[] DEFAULT ARRAY[]::uuid[], p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lote          lotes%ROWTYPE;
  v_primeiro      lotes%ROWTYPE;
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

  -- A trava `fefo` saiu inteira na migration 142: o operador bipa a embalagem
  -- que quiser. A tela só sugere, sem nomear embalagem, usar antes a mais antiga.

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

CREATE OR REPLACE FUNCTION public.realizar_transferencia_multipla(p_lote_ids uuid[], p_local_id uuid, p_responsavel_id uuid, p_empresa_id uuid, p_justificativa text DEFAULT NULL::text, p_sobra_origem numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  v_ultimo_id   UUID;
  v_declarado   BOOLEAN;
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

  -- A rede de segurança da trava `fefo` saiu na migration 142.

  -- ── Quanto realmente saiu da origem ───────────────────────
  --
  -- Antes quem decidia era a CAPACIDADE do pote: enchia até o número do
  -- cadastro e descontava isso do lote. Nenhuma balança entrava na conta, e o
  -- erro de cada passagem virava divida no saldo do lote — até o dia em que
  -- sobrava mais no fardo do que o sistema achava, e a transferencia travava.
  --
  -- Agora quem decide é o operador, declarando O QUE SOBROU NA ORIGEM: quantos
  -- pacotes ficaram no fardo, ou quanto o saco esta pesando. Sobra se enxerga;
  -- o que saiu se estima. E como o saldo do lote passa a ser reancorado a cada
  -- passagem, o erro nunca acumula.
  --
  -- A capacidade vira aviso, como na abertura de estoque: ela é estimativa
  -- nossa, e o que coube no pote é fato.
  v_declarado := p_sobra_origem IS NOT NULL;

  IF v_declarado THEN
    v_ultimo_id := p_lote_ids[array_length(p_lote_ids, 1)];

    IF p_sobra_origem < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'A sobra não pode ser negativa.');
    END IF;

    SELECT * INTO v_lote FROM lotes WHERE id = v_ultimo_id;

    IF p_sobra_origem > v_lote.quantidade_disponivel THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Sobrou mais do que havia: o lote %s tinha %s %s.',
               v_lote.codigo, ROUND(v_lote.quantidade_disponivel, 3), v_lote.unidade));
    END IF;

    v_restante := v_qtd_total - p_sobra_origem;
  ELSE
    v_restante := v_qtd_total;
  END IF;

  IF v_restante <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Nada saiu da origem: a sobra declarada é tudo o que havia.');
  END IF;

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

  -- O teórico pendente da sessão aberta desce do que acabou de chegar.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, v_insumo_id);

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
    'passou_da_capacidade', v_local.capacidade_max IS NOT NULL
                         AND (v_total_atual + v_colocado) > v_local.capacidade_max,
    'misturou',          v_total_atual > 0
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.inicializar_travas_padrao(p_empresa_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO travas_config (empresa_id, chave, modo) VALUES
    (p_empresa_id, 'marca_diferente',     'bloqueia'),
    (p_empresa_id, 'segundo_lote_aberto', 'avisa'),
    (p_empresa_id, 'excede_capacidade',   'avisa'),
    (p_empresa_id, 'sessao_sem_insumo',   'avisa')
  ON CONFLICT (empresa_id, chave) DO NOTHING;
END;
$function$
;

DELETE FROM travas_config WHERE chave = 'fefo';

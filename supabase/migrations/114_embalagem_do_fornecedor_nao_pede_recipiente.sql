-- ============================================================
-- Migration 114 — a embalagem do fornecedor não precisa de recipiente
--
-- O DEFEITO. Transferência -> "Levar embalagem original", com uma garrafa de
-- Essência de Baunilha: ao bipar o lote, a tela recusa com
--
--     "Este insumo não tem recipiente cadastrado no estoque produtivo.
--      Cadastre o recipiente antes de transferir."
--
-- É o caminho em que o pacote do fornecedor vai inteiro para a produção e é
-- consumido de dentro dele. **Não ter recipiente cadastrado é a definição do
-- modo**, não um cadastro faltando.
--
-- A CAUSA. `validar_scan_lote` é da migration 045, de quando todo insumo
-- despejava num pote da cozinha. A 073 criou a embalagem do fornecedor como
-- ponto de consumo efêmero — nascido da transferência, morto quando esvazia —
-- e ninguém voltou para ensinar isso à validação do bipe. Ela cobra pote de
-- todo mundo.
--
-- POR QUE O DOCE DE LEITE FUNCIONA. Por acaso. Ele está em `escolher` e tem
-- dois baldes cadastrados, então a contagem de potes passa e a escolha da
-- embalagem acontece depois. A baunilha está em `embalagem_fornecedor` e tem
-- zero — como o Xarope de Glucose, o Óleo de Girassol e o Leite de Coco, que
-- estavam travados do mesmo jeito.
--
-- ------ O conserto ------------------------------------------
--
-- A validação passa a ler `modo_ep`. A recusa por falta de recipiente vale só
-- para `recipiente` e `porcionado`, que de fato despejam em algo cadastrado.
--
-- E, sem pote, o espaço livre deixa de ser zero: a embalagem carrega a si
-- mesma. Sem isso as duas travas seguintes diriam "os recipientes deste insumo
-- estão cheios" e mandariam aproveitar 0 — sobre recipientes que não existem
-- nem deveriam existir.
--
-- A resposta passa a devolver `modo_ep`, para a tela não precisar deduzir de
-- outra consulta o que a validação já sabe.
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

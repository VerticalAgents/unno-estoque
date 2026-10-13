-- ============================================================
-- Migration 141 — embalagem do fornecedor não cobra o lote aberto
--
-- O CASO, em 13/10/2026: o Fernando tentava levar baldes fechados de Doce de
-- Leite para a sala de produção, para começar o dia seguinte com tudo lá
-- dentro, e o bipe recusava: "Comece pelo lote INS014-0008.8/9, que está
-- aberto no estoque".
--
-- Para insumo consumido de dentro da embalagem do fornecedor, **sempre há uma
-- embalagem aberta** — é a que está em uso. Cobrar que ela "saia primeiro"
-- não protege nada: ela não é despejada em pote nenhum, e levar as fechadas
-- para perto dela é exatamente o que se quer. A regra nasceu para o fardo que
-- é despejado no recipiente (migration 045), onde o aberto de fato precisa
-- acabar antes.
--
-- A REGRA (Lucca, 13/10/2026): a trava `fefo` do bipe deixa de valer para os
-- insumos em `embalagem_fornecedor` e em `escolher` (o Doce de Leite, que pode
-- ir no balde original). Para `recipiente`, `porcionado` e `unidade` nada muda.
--
-- O QUE FICA. A rede de segurança de `realizar_transferencia_multipla`
-- continua: ela só é alcançada por quem DESPEJA num recipiente cadastrado, e
-- ali o aberto segue tendo de sair antes. `mover_embalagem_fornecedor`, que é
-- o caminho da embalagem original, nunca teve essa trava.
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
  --
  -- Não vale para o que é consumido de dentro da embalagem do fornecedor: ali
  -- sempre há uma aberta, a que está em uso, e levar as fechadas para perto
  -- dela é o que se quer (migration 141).
  IF COALESCE(v_modo, 'recipiente') NOT IN ('embalagem_fornecedor', 'escolher')
     AND NOT EXISTS (
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

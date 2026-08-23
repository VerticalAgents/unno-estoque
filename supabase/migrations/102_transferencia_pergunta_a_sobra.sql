-- ============================================================
-- Migration 102 — a transferência pergunta o que SOBROU na origem
--
-- Até aqui, quem decidia quanto saía do fardo era a capacidade cadastrada do
-- pote: o sistema enchia até o número do cadastro e descontava isso do lote.
-- Nenhuma balança entrava na conta.
--
-- O Lucca despejou 4 pacotes de chocolate num pote e o sistema anotou 4,112 kg
-- — que não era o peso dos pacotes, era o espaço que faltava para o pote
-- chegar aos 10 kg do cadastro. O erro de cada passagem vira dívida no saldo
-- do fardo, e um dia sobra mais no fardo do que o sistema acha que tem. Aí a
-- transferência trava, e a mensagem fala de um pote cheio que não está cheio.
--
-- ── O que muda ───────────────────────────────────────────────
--
-- Quem declara agora é o operador, dizendo O QUE SOBROU NA ORIGEM:
--
--   fardo com subembalagem  →  quantos pacotes ficaram
--   saco solto              →  quanto ele está pesando
--
-- Nos dois casos é medição direta, e nos dois o saldo do lote é reancorado na
-- realidade a cada passagem. O erro deixa de acumular: se o pacote vinha com
-- 18 g a mais, a diferença aparece uma vez e morre ali.
--
-- Sobra se enxerga; o que saiu se estima. Por isso a pergunta é sobre a sobra.
--
-- ── E a capacidade do pote vira aviso ────────────────────────
--
-- Mesma decisão já tomada na abertura de estoque (migration 100): capacidade é
-- estimativa digitada no cadastro, e o que coube no pote é fato. Ela deixa de
-- recusar e passa a informar, em 'passou_da_capacidade'.
--
-- `p_sobra_origem` é opcional. Sem ela, a transferência leva tudo o que foi
-- escaneado — que é o caso de quem esvazia o fardo inteiro no pote.
--
-- Partiu de `pg_get_functiondef` — ver CLAUDE.md.
-- ============================================================

-- Subembalagem: o fardo de chocolate tem 10 pacotes de 1,01 kg; o saco de
-- cobertura não tem nenhuma. É fato do produto, não escolha de fluxo — dá para
-- olhar a embalagem e responder. NULL = não tem.
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS tamanho_subembalagem NUMERIC(12,3);

COMMENT ON COLUMN insumos.tamanho_subembalagem IS
  'Peso de cada pacote dentro da embalagem principal, na unidade do insumo. '
  'NULL quando o insumo não vem subdividido. É o que decide se a transferência '
  'pergunta "quantos pacotes sobraram" ou "quanto está pesando".';

-- A assinatura antiga sai de cena: com as duas no catálogo, uma chamada com os
-- 5 argumentos de antes casaria com ela e o novo parâmetro nunca chegaria.
-- É a lição da migration 042, registrada no CLAUDE.md.
DROP FUNCTION IF EXISTS realizar_transferencia_multipla(UUID[], UUID, UUID, UUID, TEXT);

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


REVOKE EXECUTE ON FUNCTION realizar_transferencia_multipla(UUID[], UUID, UUID, UUID, TEXT, NUMERIC)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION realizar_transferencia_multipla(UUID[], UUID, UUID, UUID, TEXT, NUMERIC)
  TO authenticated, service_role;

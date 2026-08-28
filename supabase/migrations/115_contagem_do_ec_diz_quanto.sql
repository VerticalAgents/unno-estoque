-- ============================================================
-- Migration 115 — a contagem do EC passa a dizer QUANTO, não só se está lá
--
-- O DEFEITO, nas palavras do Lucca durante a auditoria de 28/08/2026:
--
--     "ele me permite bipar o QR code, mas não me permite dizer: o que estava
--      no sistema é isso mesmo que tinha, ou não? Tem um pouco menos."
--
-- A contagem do EC só sabia responder DUAS coisas: o lote está na prateleira,
-- ou não está. Quem abria o fardo, contava cinco pacotes de 1 kg e via o
-- sistema dizer outro número não tinha onde escrever isso — bipava, a linha
-- ficava verde, e a divergência morria ali.
--
-- Uma auditoria que só confere presença não é auditoria de estoque; é lista de
-- chamada. E era justamente o que estava faltando para fechar as divergências
-- que esta semana produziu.
--
-- ------ O desenho ------------------------------------------
--
-- `contagem_ec_lotes.qtd_contada`, que aceita NULL — e NULL não é zero:
--
--   NULL   não declarei número. O saldo do sistema fica como está.
--          É o que uma bipada sozinha continua significando.
--   X      contei, e tem X.
--   0      afirmação de que a embalagem está vazia; o lote esgota.
--
-- `encontrado = false` continua sendo outra coisa: o lote não está lá, e vai
-- para descartado, como sempre foi.
--
-- A comparação é com o saldo de AGORA, não com `qtd_lote` — que é a
-- fotografia do instante em que a contagem começou e envelhece numa contagem
-- que fica dias aberta. Mesma razão de `saldoAtual` existir na tela.
--
-- Lote contado à mão deixa de ser número deduzido: `saldo_estimado` cai e a
-- data de conferência é gravada (migration 113).
--
-- Partiu de pg_get_functiondef — ver CLAUDE.md.
-- ============================================================

ALTER TABLE contagem_ec_lotes ADD COLUMN IF NOT EXISTS qtd_contada NUMERIC(12,3);

COMMENT ON COLUMN contagem_ec_lotes.qtd_contada IS
  'Quanto a pessoa contou neste lote. NULL = não declarou número, e o saldo do '
  'sistema fica como está; zero afirma que a embalagem está vazia. Diferente '
  'de encontrado = false, que diz que o lote não está na prateleira.';

CREATE OR REPLACE FUNCTION public.aplicar_contagem(p_contagem_id uuid, p_usuario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_contagem   contagens%ROWTYPE;
  v_ec_lote    RECORD;
  v_ep_local   RECORD;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
  v_local_rec  locais%ROWTYPE;
  v_novo_total DECIMAL;
  v_descartados INTEGER := 0;
  v_ajustados   INTEGER := 0;
  v_ignorados   INTEGER := 0;
  -- Lote que a balança contradisse
  v_corrigidos  INTEGER := 0;
  v_saldo       DECIMAL;
  v_dif         DECIMAL;
BEGIN
  SELECT * INTO v_contagem FROM contagens WHERE id = p_contagem_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Contagem nao encontrada');
  END IF;

  IF v_contagem.status <> 'finalizada' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Contagem deve estar finalizada para ser aplicada');
  END IF;

  SELECT COUNT(*) INTO v_ignorados
    FROM contagem_insumos
   WHERE contagem_id = p_contagem_id AND status <> 'finalizado';

  IF v_contagem.tipo = 'ec' THEN
    FOR v_ec_lote IN
      SELECT cel.lote_id, cel.qtd_lote, ci.insumo_id
        FROM contagem_ec_lotes cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND ci.status = 'finalizado'
         AND cel.encontrado = false
    LOOP
      UPDATE lotes
         SET status = 'descartado', quantidade_disponivel = 0, updated_at = now()
       WHERE id = v_ec_lote.lote_id;

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem: lote nao encontrado no EC')
      RETURNING id INTO v_mov_id;

      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
      SELECT v_mov_id, v_ec_lote.lote_id, v_ec_lote.qtd_lote, i.unidade_medida
        FROM insumos i WHERE i.id = v_ec_lote.insumo_id;

      v_descartados := v_descartados + 1;
    END LOOP;

    -- ════════════════════════════════════════════════════════
    -- O LOTE QUE ESTÁ LÁ, MAS COM OUTRA QUANTIDADE
    --
    -- Até aqui a contagem do EC só sabia responder "está" ou "não está". Quem
    -- abria o fardo, contava cinco pacotes de 1 kg e via o sistema dizer outro
    -- número não tinha onde escrever isso: bipava, o lote ficava verde, e a
    -- divergência morria ali.
    --
    -- `qtd_contada` NULL não é zero: quer dizer "não declarei número", e o
    -- saldo do sistema fica como está. Zero é uma afirmação -- a embalagem
    -- está vazia -- e por isso esgota o lote.
    --
    -- Compara com o saldo de AGORA e não com `qtd_lote`, que é a fotografia
    -- do início da contagem. Numa contagem que fica dias aberta, a fotografia
    -- envelhece: é a mesma razão de `saldoAtual` existir na tela.
    -- ════════════════════════════════════════════════════════
    FOR v_ec_lote IN
      SELECT cel.lote_id, cel.qtd_contada, cel.lote_codigo, ci.insumo_id
        FROM contagem_ec_lotes cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND ci.status = 'finalizado'
         AND cel.encontrado = true
         AND cel.qtd_contada IS NOT NULL
    LOOP
      SELECT quantidade_disponivel INTO v_saldo FROM lotes WHERE id = v_ec_lote.lote_id;
      CONTINUE WHEN v_saldo IS NULL;

      v_dif := ROUND(v_ec_lote.qtd_contada - v_saldo, 3);
      CONTINUE WHEN ABS(v_dif) < 0.001;

      UPDATE lotes
         SET quantidade_disponivel = v_ec_lote.qtd_contada,
             status = CASE WHEN v_ec_lote.qtd_contada <= 0
                           THEN 'esgotado'::status_lote_enum ELSE status END,
             -- Foi contado na mão: deixa de ser número deduzido (migration 113).
             saldo_estimado = FALSE,
             saldo_conferido_em = now(),
             updated_at = now()
       WHERE id = v_ec_lote.lote_id;

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              format('Contagem do EC: %s foi contado e tinha %s, e não %s.',
                     v_ec_lote.lote_codigo,
                     qtd_legivel(v_ec_lote.qtd_contada), qtd_legivel(v_saldo)))
      RETURNING id INTO v_mov_id;

      -- A quantidade do movimento é o TAMANHO da diferença; o sinal dela está
      -- escrito na observação, que diz de quanto para quanto foi.
      INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
      SELECT v_mov_id, v_ec_lote.lote_id, ABS(v_dif), i.unidade_medida
        FROM insumos i WHERE i.id = v_ec_lote.insumo_id;

      v_corrigidos := v_corrigidos + 1;
    END LOOP;

  ELSIF v_contagem.tipo = 'ep' THEN
    FOR v_ep_local IN
      SELECT cel.local_id, cel.status_fisico, cel.qtd_liquida, ci.insumo_id
        FROM contagem_ep_locais cel
        JOIN contagem_insumos ci ON ci.id = cel.contagem_insumo_id
       WHERE ci.contagem_id = p_contagem_id
         AND ci.status = 'finalizado'
         AND cel.escaneado = true
    LOOP
      SELECT * INTO v_local_rec FROM locais WHERE id = v_ep_local.local_id;

      v_novo_total := CASE v_ep_local.status_fisico
        WHEN 'cheio' THEN COALESCE(v_local_rec.capacidade_max, 0)
        WHEN 'vazio' THEN 0
        ELSE COALESCE(v_ep_local.qtd_liquida, 0)
      END;

      PERFORM ajustar_conteudo_recipiente(v_ep_local.local_id, v_novo_total);

      v_mov_codigo := gerar_proximo_codigo(v_contagem.empresa_id, 'movimentacoes', 'MOV');
      INSERT INTO movimentacoes (empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
      VALUES (v_contagem.empresa_id, v_mov_codigo, 'ajuste_inventario', now(), p_usuario_id,
              'Contagem EP: ajuste recipiente ' || v_local_rec.nome);

      v_ajustados := v_ajustados + 1;
    END LOOP;
  END IF;

  UPDATE contagens
     SET status = 'aplicada', aplicada_at = now()
   WHERE id = p_contagem_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lotes_descartados', v_descartados,
    'lotes_corrigidos', v_corrigidos,
    'recipientes_ajustados', v_ajustados,
    'insumos_nao_conferidos', v_ignorados);
END;
$function$
;

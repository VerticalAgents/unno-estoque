-- ============================================================
-- Migration 063 — A produção não pesa mais os recipientes
--
-- POR QUE
-- O fechamento pedia o peso de cada pote: ~35 pesagens por sessão. O número
-- servia para calcular o consumo real e, dele, o fator de perda.
--
-- Só que o que importa é a TAXA DE PERDA POR INSUMO, não o valor por sessão.
-- Medir todo dia é preciosismo, e é trabalho da produção — que precisa é
-- produzir. A perda passa a ser apurada na auditoria de estoque, quando se
-- quiser.
--
-- O QUE MUDA
-- A baixa nos recipientes passa a usar `consumo_teorico`, que já está gravado
-- linha a linha desde a abertura (rateado por lote na 059). `p_locais` some da
-- assinatura: não há mais peso para informar.
--
-- POR QUE O ESTOQUE NÃO ENLOUQUECE ENTRE AUDITORIAS
-- A perda real é sempre >= a da ficha, então o teórico sempre SUPERESTIMA o
-- que resta no pote. O erro é sempre para o lado seguro: quando o sistema diz
-- que cabe mais um sublote, cabe mesmo. Nunca transborda.
--
-- `fator_perda_insumos` passa a ser NULL — não zero. Zero afirmaria que não
-- houve perda; a verdade é que ela não é medida aqui.
-- ============================================================

DROP FUNCTION IF EXISTS fechar_sessao_producao(UUID, UUID, UUID, JSONB, JSONB, TEXT);

CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao               sessoes_producao%ROWTYPE;
  v_sku                  JSONB;
  v_linha                RECORD;
  v_local_id             UUID;
  v_mov_codigo           TEXT;
  v_mov_id               UUID;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_produto        DECIMAL(8,4) := 0;
  v_ficha_id             UUID;
  v_produto_id           UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
  v_potes                INTEGER := 0;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  SELECT ftv.peso_medio_g, sps.quantidade_planejada, sps.ficha_tecnica_id
    INTO v_peso_medio_g, v_qtd_planejada, v_ficha_id
    FROM sessoes_producao_skus sps
    JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
   WHERE sps.sessao_id = p_sessao_id
   LIMIT 1;

  SELECT tipo, insumo_resultado_id INTO v_tipo_ficha, v_insumo_resultado_id
    FROM fichas_tecnicas WHERE id = v_ficha_id;

  -- ── SKUs: inalterado ──────────────────────────────────────
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_qtd_perdida_proc    := COALESCE((v_sku->>'quantidade_perdida')::INTEGER, 0);
    v_qtd_descartada_gram := COALESCE((v_sku->>'quantidade_descartada_gramatura')::INTEGER, 0);
    v_peso_descartado_g   := COALESCE((v_sku->>'peso_descartado_gramatura_g')::DECIMAL, 0);
    v_qtd_produzida       := GREATEST(v_qtd_planejada - v_qtd_perdida_proc - v_qtd_descartada_gram, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_produzida            = v_qtd_produzida,
           quantidade_perdida              = v_qtd_perdida_proc,
           quantidade_descartada_gramatura = v_qtd_descartada_gram,
           peso_descartado_gramatura_g     = NULLIF(v_peso_descartado_g, 0)
     WHERE sessao_id = p_sessao_id
       AND ficha_tecnica_id = (v_sku->>'ficha_id')::UUID;
  END LOOP;

  -- ── Recipientes: baixa pelo TEÓRICO ───────────────────────
  -- Uma movimentação por recipiente, como antes, para o histórico continuar
  -- mostrando de qual pote saiu cada grama.
  -- Só os potes que a produção de fato usou. Com o teórico enfileirado (059),
  -- a maioria fica com zero — criar movimentação para eles encheria o
  -- histórico de registros vazios.
  FOR v_local_id IN
    SELECT local_id FROM sessoes_producao_locais
     WHERE sessao_id = p_sessao_id
     GROUP BY local_id
    HAVING SUM(COALESCE(consumo_teorico, 0)) > 0
  LOOP
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, sessao_producao_id)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'consumo_producao',
            p_responsavel_id, p_sessao_id)
    RETURNING id INTO v_mov_id;

    FOR v_linha IN
      SELECT spl.lote_id, spl.quantidade_inicial, COALESCE(spl.consumo_teorico, 0) AS teorico
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_local_id
    LOOP
      -- O consumo não pode passar do que havia no pote. Se passar, o insumo
      -- acabou no meio e alguém abasteceu — a auditoria acerta a diferença.
      v_linha.teorico := LEAST(v_linha.teorico, v_linha.quantidade_inicial);

      UPDATE sessoes_producao_locais
         SET quantidade_final = v_linha.quantidade_inicial - v_linha.teorico,
             consumo_real     = v_linha.teorico,
             desvio           = 0
       WHERE sessao_id = p_sessao_id
         AND local_id  = v_local_id
         AND lote_id   = v_linha.lote_id;

      -- Baixa no RECIPIENTE, nunca no estoque central (ver 036).
      UPDATE locais_lotes
         SET quantidade = GREATEST(quantidade - v_linha.teorico, 0)
       WHERE local_id = v_local_id
         AND lote_id  = v_linha.lote_id;

      CONTINUE WHEN v_linha.teorico <= 0;

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
      SELECT v_mov_id, v_linha.lote_id, v_local_id, v_linha.teorico, unidade
        FROM lotes WHERE id = v_linha.lote_id;
    END LOOP;

    v_potes := v_potes + 1;
  END LOOP;

  -- Os que não foram usados fecham com o que tinham: sem isso ficariam com
  -- `quantidade_final` nula e a sessão pareceria incompleta no histórico.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial,
         consumo_real     = 0,
         desvio           = 0
   WHERE sessao_id = p_sessao_id
     AND COALESCE(consumo_teorico, 0) = 0
     AND quantidade_final IS NULL;

  -- ── Perda de produto: inalterada ──────────────────────────
  IF v_qtd_planejada > 0 THEN
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      v_fator_produto := (
        (v_qtd_perdida_proc::DECIMAL * v_peso_medio_g + v_peso_descartado_g)
        / (v_qtd_planejada::DECIMAL * v_peso_medio_g)
      ) * 100;
    ELSE
      v_fator_produto := (
        (v_qtd_perdida_proc + v_qtd_descartada_gram)::DECIMAL / v_qtd_planejada::DECIMAL
      ) * 100;
    END IF;
  END IF;

  UPDATE sessoes_producao
     SET status                 = 'fechada',
         fechada_por            = p_responsavel_id,
         data_fechamento        = NOW(),
         observacoes_fechamento = p_observacoes,
         -- NULL, não zero: a perda de insumo não é mais medida aqui.
         fator_perda_insumos    = NULL,
         fator_perda_produto    = v_fator_produto
   WHERE id = p_sessao_id;

  -- ── Lote resultante: inalterado ───────────────────────────
  IF v_ficha_id IS NOT NULL AND v_qtd_produzida > 0 THEN
    IF v_tipo_ficha = 'insumo' AND v_insumo_resultado_id IS NOT NULL THEN
      v_lote_result := registrar_lote_insumo_producao(
        p_empresa_id, v_insumo_resultado_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
    ELSE
      SELECT id INTO v_produto_id
        FROM produtos
       WHERE ficha_tecnica_id = v_ficha_id AND empresa_id = p_empresa_id AND ativo = true
       LIMIT 1;

      IF FOUND THEN
        v_lote_result := registrar_lote_produto(
          p_empresa_id, v_produto_id, p_sessao_id,
          v_data_producao, v_qtd_produzida, p_responsavel_id
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'recipientes_baixados', v_potes,
    'fator_perda_produto', v_fator_produto,
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'tipo_ficha', COALESCE(v_tipo_ficha, 'produto')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION fechar_sessao_producao IS
  'Fecha a sessão dando baixa do consumo TEÓRICO nos recipientes. A perda de '
  'insumo não é medida aqui: sai da auditoria de estoque.';

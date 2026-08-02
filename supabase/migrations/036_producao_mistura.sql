-- ============================================================
-- Migration 036 — Produção, contagem e esgotamento com mistura
--
-- Fecha o ciclo aberto na 034/035: agora que um recipiente pode ter vários
-- lotes, tudo que lê ou escreve o conteúdo do pote precisa saber disso.
--
-- ------------------------------------------------------------
-- BUG PREEXISTENTE CORRIGIDO AQUI (importante)
--
-- `fechar_sessao_producao` dava baixa do consumo em `lotes.quantidade_disponivel`
-- — que é o saldo no ESTOQUE CENTRAL. Mas o consumo acontece no recipiente do
-- estoque produtivo. Ou seja: transferir já baixava o EC, e produzir baixava o
-- EC de novo. Contagem dupla.
--
-- O bug ficava escondido porque o fluxo usado na prática era o de sublotes
-- (`realizar_transferencia_multipla`), que zera o lote no EC ao transferir —
-- e aí a segunda baixa não tinha o que subtrair (GREATEST(0 - x, 0) = 0).
--
-- Com a transferência parcial liberada na 035, o lote passa a manter saldo no
-- EC depois de transferido — e a segunda baixa passaria a comer estoque que
-- existe de verdade na prateleira.
--
-- Correção: o consumo de produção baixa `locais_lotes` (o pote), nunca o EC.
-- ------------------------------------------------------------
--
-- RATEIO: a balança pesa o POTE, não cada lote dentro dele. O consumo medido é
-- dividido entre os lotes na proporção do que cada um tinha. É o tratamento
-- padrão para produto misturado e o único honesto — depois de misturado,
-- ninguém sabe de qual lote veio cada grama.
-- ============================================================

-- ============================================================
-- 1. abrir_sessao_producao_v2 — uma linha por (recipiente, lote)
-- ============================================================
CREATE OR REPLACE FUNCTION abrir_sessao_producao_v2(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_producao  DATE,
  p_plano          JSONB,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_conteudo          RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_primeiro          BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM sessoes_producao
              WHERE empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Já existe uma sessão aberta. Feche-a antes de abrir uma nova.');
  END IF;

  IF p_plano IS NULL OR jsonb_array_length(p_plano) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe ao menos uma ficha com quantidade de formas.');
  END IF;

  v_sessao_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, observacoes_abertura
  )
  VALUES (
    p_empresa_id, v_sessao_codigo, p_data_producao, 'aberta',
    p_responsavel_id, NOW(), p_observacoes
  )
  RETURNING id INTO v_sessao_id;

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID   AS ficha_id,
           (e->>'versao_id')::UUID  AS versao_id,
           (e->>'formas')::INTEGER  AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes
     WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (
      v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
      v_rendimento * v_ficha.formas, v_ficha.formas
    );

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  -- Consumo teórico somado por insumo entre as fichas, depois vinculado a cada
  -- lote presente nos recipientes daquele insumo.
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    v_primeiro := true;

    -- Agora lê locais_lotes: um recipiente pode ter vários lotes
    FOR v_conteudo IN
      SELECT ll.local_id, ll.lote_id, ll.quantidade
        FROM locais_lotes ll
        JOIN locais l ON l.id = ll.local_id
       WHERE l.empresa_id = p_empresa_id
         AND l.tipo = 'estoque_produtivo'
         AND l.insumo_id = v_item.insumo_id
         AND ll.quantidade > 0
       ORDER BY l.nome, ll.validade_ep NULLS LAST
    LOOP
      INSERT INTO sessoes_producao_locais (
        sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
      )
      VALUES (
        v_sessao_id, v_conteudo.local_id, v_item.insumo_id, v_conteudo.lote_id,
        v_conteudo.quantidade,
        CASE WHEN v_primeiro THEN v_item.consumo_teorico ELSE 0 END
      )
      ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

      v_locais_vinculados := v_locais_vinculados + 1;
      v_primeiro := false;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', v_sessao_id,
    'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades,
    'locais_vinculados', v_locais_vinculados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 2. fechar_sessao_producao — rateio proporcional
--
-- p_locais passa a ser POR RECIPIENTE: [{local_id, quantidade_final}].
-- A balança pesa o pote inteiro. Se vier `lote_id` no payload (formato antigo),
-- é ignorado — com um lote só por pote o resultado é idêntico.
-- ============================================================
CREATE OR REPLACE FUNCTION fechar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_skus           JSONB,
  p_locais         JSONB,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao               sessoes_producao%ROWTYPE;
  v_sku                  JSONB;
  v_local_rec            JSONB;
  v_linha                RECORD;
  v_total_inicial        DECIMAL;
  v_qtd_final_pote       DECIMAL;
  v_consumo_pote         DECIMAL;
  v_consumo_lote         DECIMAL;
  v_mov_codigo           TEXT;
  v_mov_id               UUID;
  v_soma_consumo_real    DECIMAL := 0;
  v_soma_consumo_teorico DECIMAL := 0;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_insumos        DECIMAL(8,4) := 0;
  v_fator_produto        DECIMAL(8,4) := 0;
  v_ficha_id             UUID;
  v_produto_id           UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
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

  -- SKUs
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

  -- Recipientes: um peso por pote, rateado entre os lotes de dentro
  FOR v_local_rec IN
    SELECT DISTINCT ON ((e->>'local_id')::UUID) e
      FROM jsonb_array_elements(p_locais) e
     ORDER BY (e->>'local_id')::UUID
  LOOP
    SELECT COALESCE(SUM(quantidade_inicial), 0) INTO v_total_inicial
      FROM sessoes_producao_locais
     WHERE sessao_id = p_sessao_id
       AND local_id  = (v_local_rec->>'local_id')::UUID;

    v_qtd_final_pote := COALESCE((v_local_rec->>'quantidade_final')::DECIMAL, 0);
    v_consumo_pote   := GREATEST(v_total_inicial - v_qtd_final_pote, 0);

    CONTINUE WHEN v_total_inicial <= 0;

    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, sessao_producao_id)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'consumo_producao',
            p_responsavel_id, p_sessao_id)
    RETURNING id INTO v_mov_id;

    FOR v_linha IN
      SELECT spl.lote_id, spl.quantidade_inicial, spl.consumo_teorico
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id
         AND spl.local_id  = (v_local_rec->>'local_id')::UUID
    LOOP
      -- RATEIO: cada lote absorve o consumo na proporção do que tinha no pote
      v_consumo_lote := v_consumo_pote * (v_linha.quantidade_inicial / v_total_inicial);

      UPDATE sessoes_producao_locais
         SET quantidade_final = v_linha.quantidade_inicial - v_consumo_lote,
             consumo_real     = v_consumo_lote,
             desvio           = v_consumo_lote - COALESCE(v_linha.consumo_teorico, 0)
       WHERE sessao_id = p_sessao_id
         AND local_id  = (v_local_rec->>'local_id')::UUID
         AND lote_id   = v_linha.lote_id;

      -- Baixa no RECIPIENTE (não no estoque central — ver cabeçalho)
      UPDATE locais_lotes
         SET quantidade = GREATEST(quantidade - v_consumo_lote, 0)
       WHERE local_id = (v_local_rec->>'local_id')::UUID
         AND lote_id  = v_linha.lote_id;

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
      SELECT v_mov_id, v_linha.lote_id, (v_local_rec->>'local_id')::UUID,
             v_consumo_lote, unidade
        FROM lotes WHERE id = v_linha.lote_id;

      v_soma_consumo_real    := v_soma_consumo_real + v_consumo_lote;
      v_soma_consumo_teorico := v_soma_consumo_teorico + COALESCE(v_linha.consumo_teorico, 0);
    END LOOP;
  END LOOP;

  IF v_soma_consumo_teorico > 0 THEN
    v_fator_insumos := ((v_soma_consumo_real - v_soma_consumo_teorico) / v_soma_consumo_teorico) * 100;
  END IF;

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
         fator_perda_insumos    = v_fator_insumos,
         fator_perda_produto    = v_fator_produto
   WHERE id = p_sessao_id;

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
    'fator_perda_insumos', v_fator_insumos,
    'fator_perda_produto', v_fator_produto,
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'tipo_ficha', COALESCE(v_tipo_ficha, 'produto')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 3. esgotar_recipiente — encerra o episódio de mistura
--
-- Com rateio proporcional o saldo quase nunca chega a zero exato: sobra
-- poeira de cada lote. Quem raspa o pote marca aqui, e o que sobrava vira
-- ajuste de inventário registrado — não some sem explicação.
-- ============================================================
CREATE OR REPLACE FUNCTION esgotar_recipiente(
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_mov_codigo TEXT;
  v_mov_id     UUID;
  v_linha      RECORD;
  v_total      DECIMAL := 0;
  v_lotes      INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locais WHERE id = p_local_id AND empresa_id = p_empresa_id) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  SELECT COALESCE(SUM(quantidade), 0), COUNT(*) INTO v_total, v_lotes
    FROM locais_lotes WHERE local_id = p_local_id AND quantidade > 0;

  IF v_lotes = 0 THEN
    RETURN jsonb_build_object('ok', true, 'ja_estava_vazio', true, 'sobra_baixada', 0);
  END IF;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'ajuste_inventario',
          p_responsavel_id,
          COALESCE(p_observacoes, 'Recipiente marcado como esgotado'))
  RETURNING id INTO v_mov_id;

  FOR v_linha IN
    SELECT ll.lote_id, ll.quantidade, ll.unidade
      FROM locais_lotes ll
     WHERE ll.local_id = p_local_id AND ll.quantidade > 0
  LOOP
    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
    VALUES (v_mov_id, v_linha.lote_id, p_local_id, v_linha.quantidade, v_linha.unidade);
  END LOOP;

  DELETE FROM locais_lotes WHERE local_id = p_local_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sobra_baixada', v_total,
    'lotes_encerrados', v_lotes,
    'movimentacao', v_mov_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Migration 044 — Sessão validada na abertura e editável depois
--
-- PROBLEMA 1: a sessão abria mesmo sem insumo nos recipientes. O sintoma
-- aparecia lá no fim, no fechamento: "Nenhum recipiente vinculado" — porque
-- não havia o que vincular. Na prática significa produção que para no meio
-- para abastecer, que é justamente o que o planejador existe para evitar.
--
-- PROBLEMA 2: depois de aberta, não dava para mudar as formas. Mas a decisão
-- de fazer algumas formas a mais ou a menos acontece durante a produção.
--
-- A validação passa pela trava `sessao_sem_insumo` (migration 041): por padrão
-- avisa e deixa seguir com justificativa; se a empresa quiser, bloqueia.
-- ============================================================

DROP FUNCTION IF EXISTS abrir_sessao_producao_v2(UUID, UUID, DATE, JSONB, TEXT);

CREATE OR REPLACE FUNCTION abrir_sessao_producao_v2(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_producao  DATE,
  p_plano          JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_justificativa  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_inseridos         INTEGER;
  v_faltantes         JSONB;
  v_trava             JSONB;
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

  -- ── Insumo suficiente nos recipientes? ────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'codigo', x.codigo, 'nome', x.nome,
           'precisa', ROUND(x.demanda, 3), 'tem', ROUND(x.conteudo, 3),
           'falta', ROUND(x.demanda - x.conteudo, 3), 'unidade', x.unidade))
    INTO v_faltantes
    FROM (
      SELECT i.codigo, i.nome, i.unidade_medida AS unidade,
             SUM(fti.quantidade * (e->>'formas')::INTEGER) AS demanda,
             COALESCE((SELECT SUM(c.quantidade_total)
                         FROM v_recipientes_composicao c
                        WHERE c.empresa_id = p_empresa_id AND c.insumo_id = i.id), 0) AS conteudo
        FROM jsonb_array_elements(p_plano) e
        JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
        JOIN insumos i ON i.id = fti.insumo_id
       WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       GROUP BY i.id, i.codigo, i.nome, i.unidade_medida
    ) x
   WHERE x.demanda > x.conteudo;

  IF v_faltantes IS NOT NULL THEN
    v_trava := avaliar_trava(p_empresa_id, 'sessao_sem_insumo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object(
        'ok', false,
        'trava', 'sessao_sem_insumo',
        'mensagem', format('%s insumo(s) sem quantidade suficiente nos recipientes. '
                           'A produção pararia no meio para abastecer.',
                           jsonb_array_length(v_faltantes)),
        'faltantes', v_faltantes
      );
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'sessao_sem_insumo',
                              jsonb_build_object('faltantes', v_faltantes), p_justificativa);
  END IF;

  -- ── Cria a sessão ─────────────────────────────────────────
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
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas);

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT v_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.consumo_teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    GET DIAGNOSTICS v_inseridos = ROW_COUNT;
    v_locais_vinculados := v_locais_vinculados + v_inseridos;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'sessao_id', v_sessao_id, 'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades, 'locais_vinculados', v_locais_vinculados
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- atualizar_plano_sessao — mudar as formas com a sessão aberta
--
-- Recalcula quantidade planejada e consumo teórico. NÃO mexe em
-- `quantidade_inicial`: aquilo é a foto do que havia no pote quando a sessão
-- abriu, e é dela que sai o consumo real no fechamento. Adulterar destruiria
-- a medição.
-- ============================================================
CREATE OR REPLACE FUNCTION atualizar_plano_sessao(
  p_sessao_id  UUID,
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_ficha          RECORD;
  v_item           RECORD;
  v_rendimento     INTEGER;
  v_total_unidades INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessoes_producao
                  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou já fechada.');
  END IF;

  -- Fichas que saíram do plano
  DELETE FROM sessoes_producao_skus
   WHERE sessao_id = p_sessao_id
     AND ficha_tecnica_id NOT IN (
       SELECT (e->>'ficha_id')::UUID FROM jsonb_array_elements(p_plano) e
        WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     );

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Ficha sem rendimento cadastrado.');
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (p_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas)
    ON CONFLICT (sessao_id, ficha_tecnica_id) DO UPDATE SET
      ficha_versao_id      = EXCLUDED.ficha_versao_id,
      quantidade_planejada = EXCLUDED.quantidade_planejada,
      multiplicador        = EXCLUDED.multiplicador;

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  -- Consumo teórico recalculado e rateado entre os lotes já vinculados
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    UPDATE sessoes_producao_locais spl
       SET consumo_teorico = v_item.teorico * (spl.quantidade_inicial / t.total)
      FROM (SELECT SUM(quantidade_inicial) AS total
              FROM sessoes_producao_locais
             WHERE sessao_id = p_sessao_id AND insumo_id = v_item.insumo_id) t
     WHERE spl.sessao_id = p_sessao_id
       AND spl.insumo_id = v_item.insumo_id
       AND t.total > 0;
  END LOOP;

  -- Insumos que entraram com uma ficha nova ainda não têm recipiente vinculado
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM sessoes_producao_locais
                        WHERE sessao_id = p_sessao_id AND insumo_id = fti.insumo_id)
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT p_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'quantidade_planejada', v_total_unidades);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

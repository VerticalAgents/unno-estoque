-- ============================================================
-- Migration 030 — Sessão de produção com várias fichas
--
-- A padaria mistura receitas no mesmo dia ("24 formas de Tradicional +
-- 20 de Doce de Leite"). `sessoes_producao_skus` já é 1-N por sessão, mas a
-- RPC `abrir_sessao_producao` só aceitava uma ficha.
--
-- A v1 continua existindo e funcionando — nada que a chama quebra.
--
-- CUIDADO QUE A v1 NÃO PRECISAVA TER: quando duas fichas usam o mesmo insumo
-- (açúcar entra nas duas), o consumo teórico precisa ser SOMADO antes de
-- vincular o recipiente. Inserir por ficha violaria
-- UNIQUE(sessao_id, local_id, lote_id) e, pior, registraria consumo teórico
-- de uma receita só.
-- ============================================================

CREATE OR REPLACE FUNCTION abrir_sessao_producao_v2(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_data_producao  DATE,
  p_plano          JSONB,   -- [{ficha_id, versao_id, formas}]
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_local             RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_primeiro_local    BOOLEAN;
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessoes_producao
     WHERE empresa_id = p_empresa_id AND status = 'aberta'
  ) THEN
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

  -- 1. Um SKU por ficha do plano
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
      sessao_id, ficha_tecnica_id, ficha_versao_id,
      quantidade_planejada, multiplicador
    )
    VALUES (
      v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
      v_rendimento * v_ficha.formas, v_ficha.formas
    );

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  -- 2. Consumo teórico SOMADO por insumo, atravessando todas as fichas,
  --    e só então o vínculo com os recipientes.
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti
        ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    v_primeiro_local := true;

    FOR v_local IN
      SELECT l.id AS local_id, lea.lote_id, lea.quantidade AS qtd_disponivel
        FROM locais l
        JOIN locais_estado_atual lea ON lea.local_id = l.id
       WHERE l.empresa_id = p_empresa_id
         AND l.tipo = 'estoque_produtivo'
         AND l.insumo_id = v_item.insumo_id
         AND lea.quantidade > 0
         AND lea.lote_id IS NOT NULL
       ORDER BY l.nome ASC
    LOOP
      INSERT INTO sessoes_producao_locais (
        sessao_id, local_id, insumo_id, lote_id,
        quantidade_inicial, consumo_teorico
      )
      VALUES (
        v_sessao_id, v_local.local_id, v_item.insumo_id, v_local.lote_id,
        v_local.qtd_disponivel,
        -- o consumo teórico fica no primeiro recipiente; os demais entram
        -- como disponibilidade, mesma convenção da v1
        CASE WHEN v_primeiro_local THEN v_item.consumo_teorico ELSE 0 END
      );

      v_locais_vinculados := v_locais_vinculados + 1;
      v_primeiro_local := false;
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

COMMENT ON FUNCTION abrir_sessao_producao_v2 IS
  'Abre sessão de produção com uma ou mais fichas. p_plano = '
  '[{ficha_id, versao_id, formas}]. Soma o consumo teórico por insumo entre '
  'as fichas antes de vincular os recipientes.';

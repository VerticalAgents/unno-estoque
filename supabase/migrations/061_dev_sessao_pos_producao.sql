-- ============================================================
-- Migration 061 — Sessão fechada de mentira, para ver a Pós-produção
--
-- A tela de Pós-produção só lista sessões FECHADAS que ainda não foram
-- processadas (`v_pos_producao_pendente`). Sem nenhuma sessão fechada ela
-- aparece vazia, e não dá para conferir se ficou boa.
--
-- Fechar a sessão real só para olhar a tela seria caro: o fechamento dá baixa
-- no consumo dos recipientes e não se desfaz.
--
-- O QUE ESTA FUNÇÃO NÃO FAZ, DE PROPÓSITO
-- Não cria linhas em `sessoes_producao_locais`. Sem elas a sessão de teste
-- fica de fora de `v_perda_por_insumo` e não polui o relatório de perdas com
-- consumo que nunca existiu. Ela serve para ver a tela, não para simular
-- estoque.
-- ============================================================

CREATE OR REPLACE FUNCTION dev_criar_sessao_pos_producao(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  -- Ontem por padrão: é quando a pós-produção acontece de verdade.
  p_dias_atras     INTEGER DEFAULT 1,
  p_formas         INTEGER DEFAULT 4
)
RETURNS JSONB AS $$
DECLARE
  v_codigo  TEXT;
  v_sessao  UUID;
  v_ficha   RECORD;
  v_fichas  INTEGER := 0;
  v_unid    INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fichas_tecnicas f
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = f.id AND v.ativa
     WHERE f.empresa_id = p_empresa_id
       AND COALESCE(v.rendimento_fornada, 0) > 0
  ) THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Nenhuma ficha técnica ativa com rendimento cadastrado.');
  END IF;

  v_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, fechada_por, data_fechamento,
    observacoes_abertura, observacoes_fechamento
  )
  VALUES (
    p_empresa_id, v_codigo, CURRENT_DATE - GREATEST(p_dias_atras, 0), 'fechada',
    p_responsavel_id, NOW() - INTERVAL '1 day', p_responsavel_id, NOW(),
    'Sessão de teste (Dev Tools)', 'Fechada automaticamente para testes'
  )
  RETURNING id INTO v_sessao;

  FOR v_ficha IN
    SELECT f.id AS ficha_id, v.id AS versao_id, v.rendimento_fornada AS rend
      FROM fichas_tecnicas f
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = f.id AND v.ativa
     WHERE f.empresa_id = p_empresa_id
       AND COALESCE(v.rendimento_fornada, 0) > 0
     ORDER BY chave_natural(f.codigo)
     LIMIT 2
  LOOP
    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id,
      quantidade_planejada, multiplicador, formas_assadas, massa_sobra_g
    )
    VALUES (
      v_sessao, v_ficha.ficha_id, v_ficha.versao_id,
      v_ficha.rend * p_formas, p_formas, p_formas,
      -- Sobra de massa plausível: um pouco acima da margem de 50 g/forma.
      p_formas * 60
    );

    v_fichas := v_fichas + 1;
    v_unid   := v_unid + (v_ficha.rend * p_formas);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'codigo', v_codigo, 'sessao_id', v_sessao,
    'fichas', v_fichas, 'formas', p_formas * v_fichas,
    'unidades_teoricas', v_unid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_criar_sessao_pos_producao IS
  'Atalho de teste: cria uma sessão já fechada, sem consumo de estoque, só '
  'para a tela de Pós-produção ter o que listar.';

-- ============================================================
-- Contrapartida: apagar as sessões de teste
--
-- Sem isto elas ficariam para sempre no histórico de produção, misturadas com
-- as reais. Só apaga o que esta função criou.
-- ============================================================
CREATE OR REPLACE FUNCTION dev_limpar_sessoes_teste(p_empresa_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_apagadas INTEGER;
BEGIN
  WITH alvo AS (
    SELECT id FROM sessoes_producao
     WHERE empresa_id = p_empresa_id
       AND observacoes_abertura = 'Sessão de teste (Dev Tools)'
  ),
  d1 AS (
    DELETE FROM pos_producao_descartes
     WHERE pos_id IN (SELECT id FROM pos_producao WHERE sessao_id IN (SELECT id FROM alvo))
    RETURNING 1
  ),
  d2 AS (
    DELETE FROM pos_producao WHERE sessao_id IN (SELECT id FROM alvo) RETURNING 1
  ),
  d3 AS (
    DELETE FROM sessoes_producao_skus WHERE sessao_id IN (SELECT id FROM alvo) RETURNING 1
  ),
  d4 AS (
    DELETE FROM sessoes_producao_locais WHERE sessao_id IN (SELECT id FROM alvo) RETURNING 1
  )
  SELECT COUNT(*) INTO v_apagadas FROM alvo;

  DELETE FROM sessoes_producao
   WHERE empresa_id = p_empresa_id
     AND observacoes_abertura = 'Sessão de teste (Dev Tools)';

  RETURN jsonb_build_object('ok', true, 'sessoes_apagadas', v_apagadas);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_limpar_sessoes_teste IS
  'Apaga as sessões criadas por dev_criar_sessao_pos_producao e o que pendura '
  'nelas. Não toca em sessão real.';

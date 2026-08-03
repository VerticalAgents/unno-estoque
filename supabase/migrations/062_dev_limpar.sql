-- ============================================================
-- Migration 062 — "Limpar tudo" do Dev Tools passa a limpar de verdade
--
-- O botão dizia "Tudo limpo." e deixava o estoque central intacto. Três
-- motivos, todos escondidos pelo mesmo defeito: a tela emendava oito chamadas
-- ao PostgREST e não conferia o erro de nenhuma.
--
-- 1. `locais_lotes` (migration 034) nunca era apagada. Ela referencia `lotes`
--    com ON DELETE RESTRICT — então o DELETE em `lotes` era recusado pelo
--    banco, e o EC continuava lá. `lotes_unidades` bloqueia igual.
--
-- 2. A tela apagava `locais_estado_atual`, que é só o RESUMO de `locais_lotes`
--    mantido por trigger. Zerava o espelho e deixava o conteúdo.
--
-- 3. Apagava de `perdas_insumos`, tabela que não existe — o nome é
--    `perdas_insumo`, no singular.
--
-- A correção não é consertar a ordem das chamadas na tela: é fazer no banco,
-- onde ou tudo apaga ou nada apaga, e onde um erro não passa despercebido.
-- ============================================================

CREATE OR REPLACE FUNCTION dev_limpar_movimento(p_empresa_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_lotes   INTEGER := 0;
  v_sessoes INTEGER := 0;
  v_potes   INTEGER := 0;
  v_movs    INTEGER := 0;
BEGIN
  -- Pós-produção
  DELETE FROM pos_producao_descartes
   WHERE pos_id IN (SELECT id FROM pos_producao WHERE empresa_id = p_empresa_id);
  DELETE FROM pos_producao WHERE empresa_id = p_empresa_id;

  -- Expedição (pendura em lotes_produto, que pendura em sessão)
  DELETE FROM expedicoes_itens
   WHERE expedicao_id IN (SELECT id FROM expedicoes WHERE empresa_id = p_empresa_id);
  DELETE FROM expedicoes WHERE empresa_id = p_empresa_id;
  DELETE FROM lotes_produto WHERE empresa_id = p_empresa_id;

  -- Contagens
  DELETE FROM contagem_ec_lotes
   WHERE contagem_insumo_id IN (
     SELECT ci.id FROM contagem_insumos ci
       JOIN contagens c ON c.id = ci.contagem_id
      WHERE c.empresa_id = p_empresa_id);
  DELETE FROM contagem_ep_locais
   WHERE contagem_insumo_id IN (
     SELECT ci.id FROM contagem_insumos ci
       JOIN contagens c ON c.id = ci.contagem_id
      WHERE c.empresa_id = p_empresa_id);
  DELETE FROM contagem_insumos
   WHERE contagem_id IN (SELECT id FROM contagens WHERE empresa_id = p_empresa_id);
  DELETE FROM contagens WHERE empresa_id = p_empresa_id;

  -- Sessões de produção
  DELETE FROM sessoes_producao_locais
   WHERE sessao_id IN (SELECT id FROM sessoes_producao WHERE empresa_id = p_empresa_id);
  DELETE FROM sessoes_producao_skus
   WHERE sessao_id IN (SELECT id FROM sessoes_producao WHERE empresa_id = p_empresa_id);
  DELETE FROM sessoes_producao WHERE empresa_id = p_empresa_id;
  GET DIAGNOSTICS v_sessoes = ROW_COUNT;

  DELETE FROM excecoes_registradas WHERE empresa_id = p_empresa_id;
  DELETE FROM reembalagens         WHERE empresa_id = p_empresa_id;
  DELETE FROM perdas_insumo        WHERE empresa_id = p_empresa_id;

  DELETE FROM movimentacoes_itens
   WHERE movimentacao_id IN (SELECT id FROM movimentacoes WHERE empresa_id = p_empresa_id);
  DELETE FROM movimentacoes WHERE empresa_id = p_empresa_id;
  GET DIAGNOSTICS v_movs = ROW_COUNT;

  -- O CONTEÚDO dos recipientes, que é o que bloqueava tudo. A trigger da 034
  -- atualiza `locais_estado_atual` sozinha, mas ela sobrevive a lotes já
  -- apagados, então some com o resto na sequência.
  DELETE FROM locais_lotes
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);
  GET DIAGNOSTICS v_potes = ROW_COUNT;

  DELETE FROM locais_estado_atual
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);

  DELETE FROM lotes_unidades
   WHERE lote_id IN (SELECT id FROM lotes WHERE empresa_id = p_empresa_id);

  DELETE FROM lotes WHERE empresa_id = p_empresa_id;
  GET DIAGNOSTICS v_lotes = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'lotes', v_lotes, 'sessoes', v_sessoes,
    'recipientes_esvaziados', v_potes, 'movimentacoes', v_movs);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_limpar_movimento IS
  'Apaga todo o movimento da empresa (lotes, estoque, sessões, contagens, '
  'perdas, expedições) numa transação só. Não toca em cadastro.';

-- ============================================================
-- dev_limpar_estoque — só o estoque, preservando o histórico de sessões
--
-- Serve para recomeçar o teste de recebimento e transferência sem perder as
-- sessões já registradas.
-- ============================================================
CREATE OR REPLACE FUNCTION dev_limpar_estoque(p_empresa_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_lotes INTEGER := 0;
  v_potes INTEGER := 0;
BEGIN
  -- Sessões referenciam lotes sem CASCADE: sem apagar estas linhas o DELETE
  -- em `lotes` seria recusado e o estoque ficaria de pé, como ficava antes.
  DELETE FROM sessoes_producao_locais
   WHERE sessao_id IN (SELECT id FROM sessoes_producao WHERE empresa_id = p_empresa_id);

  DELETE FROM contagem_ec_lotes
   WHERE contagem_insumo_id IN (
     SELECT ci.id FROM contagem_insumos ci
       JOIN contagens c ON c.id = ci.contagem_id
      WHERE c.empresa_id = p_empresa_id);

  DELETE FROM reembalagens  WHERE empresa_id = p_empresa_id;
  DELETE FROM perdas_insumo WHERE empresa_id = p_empresa_id;

  DELETE FROM movimentacoes_itens
   WHERE movimentacao_id IN (SELECT id FROM movimentacoes WHERE empresa_id = p_empresa_id);
  DELETE FROM movimentacoes WHERE empresa_id = p_empresa_id;

  DELETE FROM locais_lotes
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);
  GET DIAGNOSTICS v_potes = ROW_COUNT;

  DELETE FROM locais_estado_atual
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);

  DELETE FROM lotes_unidades
   WHERE lote_id IN (SELECT id FROM lotes WHERE empresa_id = p_empresa_id);

  DELETE FROM lotes WHERE empresa_id = p_empresa_id;
  GET DIAGNOSTICS v_lotes = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true, 'lotes', v_lotes, 'recipientes_esvaziados', v_potes);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_limpar_estoque IS
  'Apaga lotes, conteúdo dos recipientes e movimentações, preservando os '
  'cadastros. Sessões perdem o vínculo com os recipientes.';

-- ============================================================
-- dev_esvaziar_recipientes — só o EP
-- ============================================================
CREATE OR REPLACE FUNCTION dev_esvaziar_recipientes(p_empresa_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_potes INTEGER := 0;
BEGIN
  DELETE FROM locais_lotes
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);
  GET DIAGNOSTICS v_potes = ROW_COUNT;

  DELETE FROM locais_estado_atual
   WHERE local_id IN (SELECT id FROM locais WHERE empresa_id = p_empresa_id);

  RETURN jsonb_build_object('ok', true, 'recipientes_esvaziados', v_potes);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dev_esvaziar_recipientes IS
  'Esvazia os recipientes do EP. O saldo do estoque central não é devolvido: '
  'a transferência já o havia debitado.';

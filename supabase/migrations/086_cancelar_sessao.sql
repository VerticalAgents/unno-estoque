-- ============================================================
-- Migration 086 — Cancelar sessão de produção
--
-- POR QUE AGORA. A 085 passou a descontar os recipientes na ABERTURA. Isso
-- resolveu o reabastecimento durante a produção, mas criou uma ponta solta:
-- uma sessão aberta por engano ficava com o insumo descontado para sempre, e
-- o único conserto era a contagem. Pior ainda, só existe uma sessão aberta por
-- vez — a sessão errada bloqueava a abertura da certa.
--
-- O status 'cancelada' já existia no enum desde a 001, sem nada que o usasse.
--
-- O QUE O CANCELAMENTO FAZ. Devolve aos potes tudo que a abertura tirou, e
-- fecha a sessão como cancelada. A devolução não é código novo: zera-se o
-- consumo teórico das linhas e chama-se a reconciliação da 085, que já sabe
-- devolver quando o alvo fica menor que o aplicado. O mesmo caminho que o
-- "mudar de 50 para 40 formas" usa.
--
-- A LINHA NÃO É APAGADA, de propósito — mesma decisão do cancelamento de
-- contagem. Uma sessão que some não deixa rastro de que alguém abriu, e o
-- motivo escrito é o que explica o buraco na numeração depois.
--
-- O MOTIVO É OBRIGATÓRIO. Cancelar mexe no estoque de volta, e se a produção
-- já tiver rodado o sistema vai ficar com mais insumo do que a prateleira. Não
-- há como o banco saber se isso aconteceu: quem sabe é quem está lá. Por isso
-- a tela avisa e o motivo fica registrado.
-- ============================================================

ALTER TABLE sessoes_producao
  ADD COLUMN IF NOT EXISTS cancelada_por       UUID REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS data_cancelamento   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

COMMENT ON COLUMN sessoes_producao.motivo_cancelamento IS
  'Por que a sessão foi cancelada. Obrigatório: cancelar devolve insumo aos '
  'recipientes, e o motivo é o que explica a devolução na auditoria.';

CREATE OR REPLACE FUNCTION cancelar_sessao_producao(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_motivo         TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_sessao    sessoes_producao%ROWTYPE;
  v_aplicacao JSONB;
  v_insumos   TEXT;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;

  IF v_sessao.status <> 'aberta' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Esta sessão está %s. Só dá para cancelar uma sessão aberta.', v_sessao.status));
  END IF;

  IF COALESCE(length(trim(p_motivo)), 0) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Escreva o motivo do cancelamento — ele é o que explica a devolução depois.');
  END IF;

  -- Quais insumos voltam, para a tela poder dizer o que aconteceu.
  SELECT string_agg(DISTINCT i.nome, ', ')
    INTO v_insumos
    FROM sessoes_producao_locais spl
    JOIN insumos i ON i.id = spl.insumo_id
   WHERE spl.sessao_id = p_sessao_id AND spl.consumo_aplicado > 0;

  -- Zerar o alvo e reconciliar devolve tudo: é o mesmo caminho de quando o
  -- plano diminui (085), sem uma segunda implementação para manter em pé.
  UPDATE sessoes_producao_locais
     SET consumo_teorico = 0
   WHERE sessao_id = p_sessao_id;

  v_aplicacao := aplicar_teorico_nos_recipientes(p_sessao_id);

  -- A sessão fecha com as linhas dizendo que nada foi consumido, que é a
  -- verdade depois da devolução.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial,
         consumo_real     = 0,
         desvio           = 0
   WHERE sessao_id = p_sessao_id;

  UPDATE sessoes_producao
     SET status              = 'cancelada',
         cancelada_por       = p_responsavel_id,
         data_cancelamento   = NOW(),
         motivo_cancelamento = trim(p_motivo)
   WHERE id = p_sessao_id;

  RETURN jsonb_build_object(
    'ok', true,
    'codigo', v_sessao.codigo,
    'devolvido',   COALESCE((v_aplicacao->>'devolvido')::DECIMAL, 0),
    'recipientes', COALESCE((v_aplicacao->>'recipientes')::INTEGER, 0),
    'insumos', COALESCE(v_insumos, '')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cancelar_sessao_producao(UUID, UUID, UUID, TEXT) IS
  'Cancela uma sessão aberta e devolve aos recipientes o que a abertura '
  'descontou. A linha da sessão fica no histórico, com o motivo.';

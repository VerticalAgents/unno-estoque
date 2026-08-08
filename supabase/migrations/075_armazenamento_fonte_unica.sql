-- ============================================================
-- Migration 075 — Uma fonte só para "que tipo de recipiente"
--
-- Duas colunas diziam a mesma coisa:
--   `insumos.recipiente_subtipo`                    (migration 013, tem tela)
--   `insumos_armazenamento_config.tipo_armazenamento` (sem tela nenhuma)
--
-- A divisão que faz sentido é outra: `insumos.recipiente_*` descreve o
-- RECIPIENTE (que tipo, que capacidade — e é o que a tela de insumos já edita e
-- o planejador já lê), enquanto `insumos_armazenamento_config` descreve o
-- COMPORTAMENTO (modo_ep, porção, formato).
--
-- Então `tipo_armazenamento` fica vestigial: ninguém mais lê.
--
-- O NOT NULL dela precisa cair junto. Descoberto testando o payload da tela
-- nova antes de publicá-la: criar um insumo gravaria a config sem
-- `tipo_armazenamento` e estouraria a constraint — a tela quebraria no salvar,
-- e só no cadastro de insumo NOVO, que é o caminho que menos se testa à mão.
--
-- A coluna não é removida: remover é irreversível, e ela ainda pode explicar
-- dados antigos. Fica anotada como substituída, para o próximo não usar.
-- ============================================================

ALTER TABLE insumos_armazenamento_config
  ALTER COLUMN tipo_armazenamento DROP NOT NULL;

COMMENT ON COLUMN insumos_armazenamento_config.tipo_armazenamento IS
  'SUBSTITUÍDA por insumos.recipiente_subtipo (migration 075). Não é mais lida '
  'por nenhuma tela nem RPC. Mantida só para explicar dados antigos.';

-- `mover_embalagem_fornecedor` era o último leitor: passa a tirar o subtipo do
-- modelo de recipiente do insumo, que é o campo que o usuário edita.
CREATE OR REPLACE FUNCTION mover_embalagem_fornecedor(
  p_lote_id        UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID
)
RETURNS JSONB AS $$
DECLARE
  v_lote      lotes%ROWTYPE;
  v_insumo    insumos%ROWTYPE;
  v_modo      modo_ep_enum;
  v_subtipo   TEXT;
  v_local_id  UUID;
  v_nome      TEXT;
  v_resultado JSONB;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF COALESCE(v_lote.quantidade_disponivel, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não tem saldo para mover.', v_lote.codigo));
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  SELECT c.modo_ep INTO v_modo
    FROM insumos_armazenamento_config c
   WHERE c.insumo_id = v_lote.insumo_id;

  IF v_modo IS NULL OR v_modo NOT IN ('embalagem_fornecedor', 'escolher') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s não é armazenado na embalagem do fornecedor. '
             || 'Escaneie o recipiente de destino.', v_insumo.nome));
  END IF;

  SELECT id INTO v_local_id
    FROM locais
   WHERE origem_lote_id = p_lote_id AND ativo
   LIMIT 1;

  IF v_local_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'local_id', v_local_id, 'ja_existia', true);
  END IF;

  v_subtipo := v_insumo.recipiente_subtipo;
  IF v_subtipo IS NULL OR v_subtipo NOT IN (
    'prateleira','balde','balde_fornecedor','caixa_plastica',
    'garrafa','garrafa_fornecedor','saco_confeitar','lata'
  ) THEN
    v_subtipo := 'balde_fornecedor';
  END IF;

  v_nome := v_insumo.nome || ' · ' || v_lote.codigo;

  INSERT INTO locais (
    empresa_id, nome, tipo, subtipo, insumo_id, marca_id,
    capacidade_max, unidade_capacidade, qr_code_fixo,
    origem_lote_id, efemero, ativo, observacoes
  ) VALUES (
    p_empresa_id, v_nome, 'estoque_produtivo', v_subtipo::subtipo_local_enum,
    v_lote.insumo_id, v_lote.marca_id,
    v_lote.quantidade_disponivel, v_lote.unidade,
    'QR-LOTE-' || v_lote.codigo,
    p_lote_id, true, true,
    'Embalagem do fornecedor — criada pela transferência do lote ' || v_lote.codigo
  ) RETURNING id INTO v_local_id;

  v_resultado := realizar_transferencia(
    p_lote_id, v_local_id, v_lote.quantidade_disponivel,
    p_responsavel_id, p_empresa_id
  );

  IF NOT (v_resultado->>'ok')::BOOLEAN THEN
    DELETE FROM locais WHERE id = v_local_id;
    RETURN v_resultado;
  END IF;

  RETURN v_resultado
    || jsonb_build_object('local_id', v_local_id, 'local_nome', v_nome,
                          'quantidade', v_lote.quantidade_disponivel);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

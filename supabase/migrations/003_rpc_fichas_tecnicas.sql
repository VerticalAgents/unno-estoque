-- ============================================================
-- MISCHAOS — RPC: Fichas Técnicas
-- Operações atômicas para criar e versionar receitas
-- ============================================================

-- ============================================================
-- RPC: criar_ficha_tecnica
-- Cria ficha + primeira versão + itens atomicamente
-- ============================================================
CREATE OR REPLACE FUNCTION criar_ficha_tecnica(
  p_empresa_id   UUID,
  p_responsavel_id UUID,
  p_codigo       TEXT,
  p_nome         TEXT,
  p_descricao    TEXT,
  p_notas        TEXT,
  p_itens        JSONB   -- [{insumo_id, quantidade, unidade, observacoes}]
)
RETURNS JSONB AS $$
DECLARE
  v_ficha_id  UUID;
  v_versao_id UUID;
  v_item      JSONB;
BEGIN
  -- Valida código único
  IF EXISTS (SELECT 1 FROM fichas_tecnicas WHERE empresa_id = p_empresa_id AND codigo = p_codigo) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Código já existe para esta empresa.');
  END IF;

  -- Insere ficha
  INSERT INTO fichas_tecnicas (empresa_id, codigo, nome, descricao, versao_atual)
  VALUES (p_empresa_id, p_codigo, p_nome, p_descricao, 1)
  RETURNING id INTO v_ficha_id;

  -- Insere versão 1
  INSERT INTO fichas_tecnicas_versoes (ficha_id, versao, criado_por, notas_alteracao, ativa)
  VALUES (v_ficha_id, 1, p_responsavel_id, p_notas, true)
  RETURNING id INTO v_versao_id;

  -- Insere itens
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade, observacoes)
    VALUES (
      v_versao_id,
      (v_item->>'insumo_id')::UUID,
      (v_item->>'quantidade')::DECIMAL,
      (v_item->>'unidade')::unidade_medida_enum,
      v_item->>'observacoes'
    );
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'ficha_id', v_ficha_id, 'versao_id', v_versao_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC: criar_nova_versao_ficha
-- Cria nova versão de uma ficha existente (desativa a anterior)
-- ============================================================
CREATE OR REPLACE FUNCTION criar_nova_versao_ficha(
  p_ficha_id       UUID,
  p_responsavel_id UUID,
  p_notas          TEXT,
  p_itens          JSONB   -- [{insumo_id, quantidade, unidade, observacoes}]
)
RETURNS JSONB AS $$
DECLARE
  v_ficha      fichas_tecnicas%ROWTYPE;
  v_nova_versao INTEGER;
  v_versao_id  UUID;
  v_item       JSONB;
BEGIN
  SELECT * INTO v_ficha FROM fichas_tecnicas WHERE id = p_ficha_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Ficha não encontrada.');
  END IF;

  v_nova_versao := v_ficha.versao_atual + 1;

  -- Desativa versão anterior
  UPDATE fichas_tecnicas_versoes SET ativa = false WHERE ficha_id = p_ficha_id AND ativa = true;

  -- Insere nova versão
  INSERT INTO fichas_tecnicas_versoes (ficha_id, versao, criado_por, notas_alteracao, ativa)
  VALUES (p_ficha_id, v_nova_versao, p_responsavel_id, p_notas, true)
  RETURNING id INTO v_versao_id;

  -- Insere itens
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade, observacoes)
    VALUES (
      v_versao_id,
      (v_item->>'insumo_id')::UUID,
      (v_item->>'quantidade')::DECIMAL,
      (v_item->>'unidade')::unidade_medida_enum,
      v_item->>'observacoes'
    );
  END LOOP;

  -- Atualiza versão atual
  UPDATE fichas_tecnicas SET versao_atual = v_nova_versao, updated_at = NOW() WHERE id = p_ficha_id;

  RETURN jsonb_build_object('ok', true, 'ficha_id', p_ficha_id, 'versao_id', v_versao_id, 'versao', v_nova_versao);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

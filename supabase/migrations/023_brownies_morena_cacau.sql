-- ============================================================
-- Migration 023 — Brownies Morena Cacau
-- Adiciona insumos novos + 2 fichas técnicas (Tradicional e Vegano)
-- Rendimento: 60 unidades de 70g = 4200g por fornada
-- ============================================================

DO $$
DECLARE
  v_empresa_id UUID;
  v_user_id    UUID;
  v_cat_baldes UUID;
  v_cat_liquidos UUID;
  v_cat_conservantes UUID;

  -- Insumos existentes
  v_ovo_po     UUID;
  v_propionato UUID;
  v_ac_citrico UUID;
  v_sorbato    UUID;

  -- Insumos novos
  v_acucar_demerara      UUID;
  v_choco_zero_lactose   UUID;
  v_farinha_aveia        UUID;
  v_oleo_girassol        UUID;
  v_cacau_100            UUID;
  v_leite_coco           UUID;
  v_farinha_sem_gluten   UUID;

  -- Fichas
  v_ficha_id  UUID;
  v_versao_id UUID;
BEGIN

  -- ── Busca empresa e usuário admin ──
  SELECT id INTO v_empresa_id FROM empresas WHERE nome = 'Mischa''s Bakery' LIMIT 1;
  SELECT id INTO v_user_id FROM usuarios WHERE empresa_id = v_empresa_id AND papel = 'admin' LIMIT 1;

  -- ── Busca categorias ──
  SELECT id INTO v_cat_baldes FROM categorias_insumo WHERE empresa_id = v_empresa_id AND nome = 'BALDES';
  SELECT id INTO v_cat_liquidos FROM categorias_insumo WHERE empresa_id = v_empresa_id AND nome = 'LIQUIDOS';
  SELECT id INTO v_cat_conservantes FROM categorias_insumo WHERE empresa_id = v_empresa_id AND nome = 'CONSERVANTES';

  -- ── Busca insumos existentes ──
  SELECT id INTO v_ovo_po     FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS005';
  SELECT id INTO v_propionato FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS016';
  SELECT id INTO v_ac_citrico FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS017';
  SELECT id INTO v_sorbato    FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS018';

  -- ============================================================
  -- NOVOS INSUMOS
  -- ============================================================

  -- INS028 — Açúcar Demerara
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS028', 'Açúcar Demerara', v_cat_baldes, 'kg', 365, 10)
  RETURNING id INTO v_acucar_demerara;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_acucar_demerara, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_acucar_demerara, 'balde', false, false);

  -- INS029 — Chocolate Zero Lactose
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS029', 'Chocolate Zero Lactose', v_cat_baldes, 'kg', 180, 5)
  RETURNING id INTO v_choco_zero_lactose;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_choco_zero_lactose, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_choco_zero_lactose, 'balde', false, false);

  -- INS030 — Farinha de Aveia
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS030', 'Farinha de Aveia', v_cat_baldes, 'kg', 180, 5)
  RETURNING id INTO v_farinha_aveia;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_farinha_aveia, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_farinha_aveia, 'balde', false, false);

  -- INS031 — Óleo de Girassol
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS031', 'Óleo de Girassol', v_cat_liquidos, 'kg', 365, 5)
  RETURNING id INTO v_oleo_girassol;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_oleo_girassol, 'garrafa', 900, 'ml', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_oleo_girassol, 'garrafa_fornecedor', false, false);

  -- INS032 — Cacau em Pó 100%
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS032', 'Cacau em Pó 100%', v_cat_baldes, 'kg', 365, 2)
  RETURNING id INTO v_cacau_100;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_cacau_100, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_cacau_100, 'balde', false, false);

  -- INS033 — Leite de Coco
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS033', 'Leite de Coco', v_cat_liquidos, 'ml', 30, 5)
  RETURNING id INTO v_leite_coco;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_leite_coco, 'caixa', 1, 'L', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_leite_coco, 'garrafa_fornecedor', false, false);

  -- INS034 — Farinha Sem Glúten Urbano
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS034', 'Farinha Sem Glúten Urbano', v_cat_baldes, 'kg', 180, 5)
  RETURNING id INTO v_farinha_sem_gluten;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_farinha_sem_gluten, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_farinha_sem_gluten, 'balde', false, false);

  -- ============================================================
  -- FICHA TÉCNICA 1 — Brownie Tradicional (Morena Cacau)
  -- 4200g → 60 unidades de 70g
  -- Quantidades em g por unidade (total / 60)
  -- ============================================================
  INSERT INTO fichas_tecnicas (empresa_id, codigo, nome, descricao, versao_atual, ativo, tipo)
  VALUES (v_empresa_id, 'FT-001', 'Brownie Tradicional (Morena Cacau)', 'Brownie tradicional marca Morena Cacau — fornada 4200g', 1, true, 'produto')
  RETURNING id INTO v_ficha_id;

  INSERT INTO fichas_tecnicas_versoes (ficha_id, versao, criado_por, notas_alteracao, ativa, rendimento_fornada, peso_medio_g)
  VALUES (v_ficha_id, 1, v_user_id, 'Versão inicial — receita Morena Cacau', true, 60, 70)
  RETURNING id INTO v_versao_id;

  -- Itens: quantidade POR UNIDADE (total ÷ 60), unidade = g
  -- Itens <= 10g arredondados para 1 casa decimal
  INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade) VALUES
    (v_versao_id, v_ovo_po,             20.8667, 'g'),  -- 1252 / 60
    (v_versao_id, v_acucar_demerara,    20.5333, 'g'),  -- 1232 / 60
    (v_versao_id, v_choco_zero_lactose, 11.9667, 'g'),  -- 718 / 60
    (v_versao_id, v_farinha_aveia,       8.4,    'g'),  -- 505 / 60
    (v_versao_id, v_oleo_girassol,       5.9,    'g'),  -- 353 / 60
    (v_versao_id, v_cacau_100,           2.1,    'g'),  -- 123 / 60
    (v_versao_id, v_propionato,          0.1,    'g'),  -- 8.4 / 60
    (v_versao_id, v_sorbato,             0.1,    'g'),  -- 4.2 / 60
    (v_versao_id, v_ac_citrico,          0.1,    'g');  -- 4.2 / 60

  -- ============================================================
  -- FICHA TÉCNICA 2 — Brownie Vegano (Morena Cacau)
  -- 4200g → 60 unidades de 70g
  -- ============================================================
  INSERT INTO fichas_tecnicas (empresa_id, codigo, nome, descricao, versao_atual, ativo, tipo)
  VALUES (v_empresa_id, 'FT-002', 'Brownie Vegano (Morena Cacau)', 'Brownie vegano marca Morena Cacau — fornada 4200g', 1, true, 'produto')
  RETURNING id INTO v_ficha_id;

  INSERT INTO fichas_tecnicas_versoes (ficha_id, versao, criado_por, notas_alteracao, ativa, rendimento_fornada, peso_medio_g)
  VALUES (v_ficha_id, 1, v_user_id, 'Versão inicial — receita Morena Cacau vegano', true, 60, 70)
  RETURNING id INTO v_versao_id;

  -- Itens <= 10g arredondados para 1 casa decimal
  INSERT INTO fichas_tecnicas_itens (versao_id, insumo_id, quantidade, unidade) VALUES
    (v_versao_id, v_acucar_demerara,    23.2333, 'g'),  -- 1394 / 60
    (v_versao_id, v_leite_coco,         15.1,    'g'),  -- 906 / 60
    (v_versao_id, v_farinha_sem_gluten, 15.1,    'g'),  -- 906 / 60
    (v_versao_id, v_choco_zero_lactose,  7.0,    'g'),  -- 422 / 60
    (v_versao_id, v_oleo_girassol,       5.8,    'g'),  -- 348 / 60
    (v_versao_id, v_cacau_100,           3.5,    'g'),  -- 209 / 60
    (v_versao_id, v_propionato,          0.1,    'g'),  -- 8.4 / 60
    (v_versao_id, v_sorbato,             0.1,    'g'),  -- 4.2 / 60
    (v_versao_id, v_ac_citrico,          0.1,    'g');  -- 4.2 / 60

END $$;

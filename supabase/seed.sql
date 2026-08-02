-- ============================================================
-- MISCHAOS ESTOQUE — SEED COMPLETO
-- Mischa's Bakery · Porto Alegre, RS
-- ============================================================
-- INSTRUÇÕES DE USO:
-- 1. Execute o schema principal (MischaOS_schema.sql) primeiro
-- 2. Execute migrations/002_rpc_transfer.sql
-- 3. Crie os 3 usuários no Supabase Auth (Authentication → Users → Add user)
--    - lucca@mischasbakery.com.br  (ou email de sua preferência)
--    - enzo@mischasbakery.com.br
--    - beatriz@mischasbakery.com.br
-- 4. Copie os UUIDs gerados e substitua os placeholders abaixo
-- 5. Execute este seed
-- ============================================================

-- ── VARIÁVEIS ───────────────────────────────────────────────
DO $$
DECLARE
  v_empresa_id   UUID;
  v_cat_baldes   UUID;
  v_cat_liquidos UUID;
  v_cat_coberturas UUID;
  v_cat_conservantes UUID;

  -- v_ins é reutilizada por todos os blocos de insumo abaixo.
  -- Precisa ser declarada aqui (escopo do bloco externo): declarada
  -- dentro do primeiro bloco, ficava invisível para os seguintes.
  v_ins UUID;

  -- Admin: UUID real do auth.users (criado em Authentication → Add user)
  v_uid_admin UUID := 'e145c637-58dd-43b9-bc48-43068f7e6a9d';

BEGIN

-- ============================================================
-- 1. EMPRESA
-- ============================================================
INSERT INTO empresas (id, nome, cidade, estado, ativa)
VALUES (uuid_generate_v4(), 'Mischa''s Bakery', 'Porto Alegre', 'RS', true)
RETURNING id INTO v_empresa_id;

-- ============================================================
-- 2. USUÁRIOS (id deve bater com auth.users)
-- ============================================================
-- Apenas o admin. Os demais funcionários devem ser criados pela tela
-- Configurações → Funcionários, que cria o login no Auth junto com a linha aqui.
INSERT INTO usuarios (id, empresa_id, nome, email, papel, ativo)
VALUES
  (v_uid_admin, v_empresa_id, 'Lucca', 'mischas.bakery@gmail.com', 'admin', true);

-- ============================================================
-- 3. CATEGORIAS
-- ============================================================
INSERT INTO categorias_insumo (id, empresa_id, nome, cor_hex, descricao)
VALUES
  (uuid_generate_v4(), v_empresa_id, 'BALDES',       '#3498DB', 'Ingredientes secos armazenados em baldes no EP')
  RETURNING id INTO v_cat_baldes;

INSERT INTO categorias_insumo (id, empresa_id, nome, cor_hex, descricao)
VALUES
  (uuid_generate_v4(), v_empresa_id, 'LIQUIDOS',     '#E67E22', 'Ingredientes líquidos e semilíquidos')
  RETURNING id INTO v_cat_liquidos;

INSERT INTO categorias_insumo (id, empresa_id, nome, cor_hex, descricao)
VALUES
  (uuid_generate_v4(), v_empresa_id, 'COBERTURAS',   '#8E44AD', 'Coberturas, ganaches e recheios')
  RETURNING id INTO v_cat_coberturas;

INSERT INTO categorias_insumo (id, empresa_id, nome, cor_hex, descricao)
VALUES
  (uuid_generate_v4(), v_empresa_id, 'CONSERVANTES', '#27AE60', 'Conservantes e aditivos em pequenas quantidades')
  RETURNING id INTO v_cat_conservantes;

-- ============================================================
-- 4. INSUMOS + CONFIGS
-- ============================================================

-- Helper block: insere insumo + embalagem + armazenamento
-- ─── BALDES ─────────────────────────────────────────────────

-- INS001 — AÇÚCAR
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS001', 'Açúcar', v_cat_baldes, 'kg', 30, 25)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'fardo', 10, 'kg', true, 'pacote', 10, 1, 'kg');
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS002 — FARINHA DE TRIGO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS002', 'Farinha de Trigo', v_cat_baldes, 'kg', 30, 25)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'fardo', 10, 'kg', true, 'pacote', 10, 1, 'kg');
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS003 — CHOCO EM PÓ 50%
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS003', 'Choco em Pó 50%', v_cat_baldes, 'kg', 90, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'caixa', 10, 'kg', true, 'saco', 10, 1, 'kg');
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS004 — SORBITOL
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS004', 'Sorbitol', v_cat_baldes, 'kg', 180, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 25, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS005 — OVO EM PÓ
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS005', 'Ovo em Pó', v_cat_baldes, 'kg', 90, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 25, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS022 — CACAU BLACK
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS022', 'Cacau Black', v_cat_baldes, 'kg', 180, 2)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 0.5, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- ─── LÍQUIDOS ────────────────────────────────────────────────

-- INS006 — ÓLEO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS006', 'Óleo', v_cat_liquidos, 'kg', 180, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'caixa', 16.2, 'kg', true, 'garrafa', 20, 0.810, 'kg');
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'caixa_plastica', false, false, 'As 20 garrafas vão para uma caixa plástica no EP. A caixa plástica tem QR Code fixo.');
END;

-- INS007 — AÇÚCAR INVERTIDO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS007', 'Açúcar Invertido', v_cat_liquidos, 'kg', 180, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'balde', 10, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'balde_fornecedor', false, false, 'O balde do fornecedor vai direto para o EP.');
END;

-- INS008 — XAROPE DE GLUCOSE
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS008', 'Xarope de Glucose', v_cat_liquidos, 'kg', 365, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'balde', 10, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'balde_fornecedor', false, false, 'Balde do fornecedor vai direto ao EP.');
END;

-- INS009 — GLICERINA
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS009', 'Glicerina', v_cat_liquidos, 'kg', 730, 2)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'garrafa', 5, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'garrafa_fornecedor', false, false, 'Garrafa do fornecedor vai direto ao EP com QR fixo colado nela.');
END;

-- INS010 — ESSÊNCIA DE BAUNILHA
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS010', 'Essência de Baunilha', v_cat_liquidos, 'ml', 365, 1)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'garrafa', 960, 'ml', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'garrafa_fornecedor', false, false);
END;

-- INS020 — SPRAY DESMOLDANTE
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS020', 'Spray Desmoldante', v_cat_liquidos, 'unid', 365, 2)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'lata', 0.6, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'lata', false, false, 'Uma lata por vez no EP. Controlado por unidade.');
END;

-- ─── COBERTURAS ──────────────────────────────────────────────

-- INS011 — COBERTURA BRANCA
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS011', 'Cobertura Branca', v_cat_coberturas, 'kg', 60, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 20, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS012 — COBERTURA AO LEITE
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS012', 'Cobertura Ao Leite', v_cat_coberturas, 'kg', 60, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 20, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS013 — COBERTURA CARAMELO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS013', 'Cobertura Caramelo', v_cat_coberturas, 'kg', 60, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'caixa', 10, 'kg', true, 'saco', 10, 1, 'kg');
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS014 — DOCE DE LEITE
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS014', 'Doce de Leite', v_cat_coberturas, 'kg', 14, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'balde', 4.8, 'kg', false);
  INSERT INTO insumos_armazenamento_config (
    insumo_id, tipo_armazenamento, passa_reembalagem,
    reembalagem_formato, reembalagem_tamanho_porcao, reembalagem_unidade,
    destino_multiplo, destino_multiplo_descricao, observacoes
  ) VALUES (
    v_ins, 'balde', true,
    'saco_confeitar', 600, 'g',
    true, 'Parte do balde vai para balde de massa. Outra parte é porcionada em sacos de confeitar 600g para topping.',
    'DESTINO DUPLO: o Enzo define na tela de transferência quanto vai para cada destino.'
  );
END;

-- INS021 — COBERTURA MEIO AMARGO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS021', 'Cobertura Meio Amargo', v_cat_coberturas, 'kg', 60, 10)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 20, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS023 — STIKADINHO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS023', 'Stikadinho', v_cat_coberturas, 'g', 30, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades, subunidade_tipo, subunidade_quantidade, subunidade_peso, subunidade_unidade)
  VALUES (v_ins, 'display', 393.6, 'g', true, 'unidade', 32, 12.3, 'g');
  INSERT INTO insumos_armazenamento_config (
    insumo_id, tipo_armazenamento, passa_reembalagem,
    reembalagem_formato, reembalagem_tamanho_porcao, reembalagem_unidade,
    destino_multiplo, observacoes
  ) VALUES (
    v_ins, 'balde', true,
    -- 12.3g = uma barra do display (32 barras). O check chk_reembalagem exige
    -- tamanho_porcao preenchido sempre que passa_reembalagem = true.
    'porcionamento', 12.3, 'g',
    false, 'As 32 barras são abertas e cortadas antes de ir ao balde. Display inteiro → balde após corte.'
  );
END;

-- INS027 — NUTELLA
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS027', 'Nutella', v_cat_coberturas, 'kg', 30, 3)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'balde', 3, 'kg', false);
  INSERT INTO insumos_armazenamento_config (
    insumo_id, tipo_armazenamento, passa_reembalagem,
    reembalagem_formato, reembalagem_tamanho_porcao, reembalagem_unidade,
    destino_multiplo, observacoes
  ) VALUES (
    v_ins, 'saco_confeitar', true,
    'saco_confeitar', 625, 'g',
    false, 'REEMBALAGEM OBRIGATÓRIA: balde 3kg → 4 sacos 625g + 500g sobra. Cada saco recebe QR Code próprio.'
  );
END;

-- ─── CONSERVANTES ────────────────────────────────────────────

-- INS015 — SAL
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS015', 'Sal', v_cat_conservantes, 'kg', 1080, 2)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS016 — PROPIONATO DE CÁLCIO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS016', 'Propionato de Cálcio', v_cat_conservantes, 'kg', 365, 1)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS017 — ÁCIDO CÍTRICO ANIDRO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS017', 'Ácido Cítrico Anidro', v_cat_conservantes, 'kg', 730, 1)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saco', 1, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS018 — SORBATO DE POTÁSSIO
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS018', 'Sorbato de Potássio', v_cat_conservantes, 'kg', 730, 5)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'saca', 25, 'kg', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo)
  VALUES (v_ins, 'balde', false, false);
END;

-- INS019 — EXTRATO DE ALECRIM
BEGIN
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, shelf_life_dias_pos_abertura, estoque_minimo)
  VALUES (v_empresa_id, 'INS019', 'Extrato de Alecrim', v_cat_conservantes, 'ml', 365, 2)
  RETURNING id INTO v_ins;
  INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
  VALUES (v_ins, 'garrafa', 250, 'ml', false);
  INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
  VALUES (v_ins, 'garrafa_fornecedor', false, false, 'Uma garrafinha de 250ml por vez no EP.');
END;

-- ============================================================
-- 5. CONFIGURAÇÕES DO SISTEMA
-- ============================================================
INSERT INTO configuracoes_sistema (empresa_id, dias_alerta_validade, percentual_estoque_alerta)
VALUES (v_empresa_id, 7, 20.00);

END $$;

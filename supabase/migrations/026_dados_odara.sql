-- ============================================================
-- Migration 026 — Dados reais da operação Odara
--
-- Fonte: duas planilhas usadas diariamente na padaria
--   "Planejador de Recipientes por Produção"  (abas Recipientes / Fichas)
--   "PLANEJAMENTO DE REABASTECIMENTO"         (aba Insumos)
-- e as fichas técnicas em PDF (Tradicional 4x v10 e Doce de Leite 4x).
--
-- Decisão do usuário: onde planilha e sistema divergem, a PLANILHA manda —
-- ela reflete a operação real; a seed original era estimativa.
--
-- O que esta migration faz:
--   1. Cria INS024 (Lecitina de Soja) e INS025 (Essência de Doce de Leite)
--   2. Corrige 7 embalagens divergentes
--   3. Preenche o modelo de recipiente por insumo (colunas da migration 013)
--   4. Cria os 72 recipientes físicos em `locais`, com QR fixo
--   5. Aposenta as fichas Morena Cacau e cadastra as duas fichas Odara
-- ============================================================

DO $$
DECLARE
  v_empresa_id UUID;
  v_user_id    UUID;
  v_cat_liq    UUID;
  v_ins        UUID;
  v_rec        RECORD;
  v_i          INTEGER;
  v_qr         TEXT;
  v_itens      JSONB;
BEGIN

  SELECT id INTO v_empresa_id FROM empresas WHERE nome = 'Mischa''s Bakery' LIMIT 1;
  SELECT id INTO v_user_id FROM usuarios WHERE empresa_id = v_empresa_id AND papel = 'admin' LIMIT 1;
  SELECT id INTO v_cat_liq FROM categorias_insumo WHERE empresa_id = v_empresa_id AND nome = 'LIQUIDOS';

  IF v_empresa_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Empresa ou usuário admin não encontrados — rode o seed antes desta migration.';
  END IF;

  -- ============================================================
  -- 1. INSUMOS NOVOS
  -- Aparecem nas duas fichas Odara mas não existiam no cadastro.
  -- Recipiente ainda não definido na planilha (células amarelas) — por isso
  -- não recebem modelo de recipiente nem locais físicos aqui.
  -- ============================================================

  -- INS024 — Lecitina de Soja (0,25% no Tradicional, 0,30% no DDL)
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, estoque_minimo)
  VALUES (v_empresa_id, 'INS024', 'Lecitina de Soja', v_cat_liq, 'kg', 5)
  ON CONFLICT (empresa_id, codigo) DO NOTHING
  RETURNING id INTO v_ins;

  IF v_ins IS NOT NULL THEN
    INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
    VALUES (v_ins, 'balde', 25, 'kg', false);
    INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
    VALUES (v_ins, 'balde', false, false, 'Recipiente do EP ainda não definido (pendência da planilha).');
  END IF;

  -- INS025 — Essência de Doce de Leite (0,25% no DDL, não usada no Tradicional)
  v_ins := NULL;
  INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida, estoque_minimo)
  VALUES (v_empresa_id, 'INS025', 'Essência de Doce de Leite', v_cat_liq, 'kg', 2)
  ON CONFLICT (empresa_id, codigo) DO NOTHING
  RETURNING id INTO v_ins;

  IF v_ins IS NOT NULL THEN
    INSERT INTO insumos_embalagem_config (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
    VALUES (v_ins, 'saco', 15, 'kg', false);
    INSERT INTO insumos_armazenamento_config (insumo_id, tipo_armazenamento, passa_reembalagem, destino_multiplo, observacoes)
    VALUES (v_ins, 'balde', false, false, 'Recipiente do EP ainda não definido (pendência da planilha).');
  END IF;

  -- ============================================================
  -- 2. CORREÇÃO DAS EMBALAGENS (aba Insumos do reabastecimento)
  -- ============================================================

  -- INS002 Farinha de Trigo: fardo 10kg → 25kg.
  -- O fardo continua sendo composto de pacotes de 1kg; só a contagem muda.
  UPDATE insumos_embalagem_config SET quantidade_total = 25, subunidade_quantidade = 25
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS002');

  -- INS005 Ovo em Pó: saca 25kg → 20kg
  UPDATE insumos_embalagem_config SET quantidade_total = 20
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS005');

  -- INS007 Açúcar Invertido: balde 10kg → 25kg
  UPDATE insumos_embalagem_config SET quantidade_total = 25
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS007');

  -- INS009 Glicerina: garrafa 5kg → galão 50kg (planilha: tipo "gl")
  UPDATE insumos_embalagem_config SET quantidade_total = 50
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS009');

  -- INS012 Cobertura Ao Leite: saca 20kg → caixa 10kg com 10 sacos de 1kg,
  -- mesmo formato do INS013 (moedas de caramelo), que é o produto irmão.
  UPDATE insumos_embalagem_config
     SET tipo_embalagem = 'caixa', quantidade_total = 10,
         tem_subunidades = true, subunidade_tipo = 'saco',
         subunidade_quantidade = 10, subunidade_peso = 1, subunidade_unidade = 'kg'
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS012');

  -- INS018 Sorbato de Potássio: saca 25kg → saco 1kg
  UPDATE insumos_embalagem_config SET tipo_embalagem = 'saco', quantidade_total = 1
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS018');

  -- INS019 Extrato de Alecrim: garrafa 250ml → balde 5kg.
  -- A unidade do insumo passa de ml para kg para acompanhar a embalagem.
  UPDATE insumos SET unidade_medida = 'kg'
  WHERE empresa_id = v_empresa_id AND codigo = 'INS019';
  UPDATE insumos_embalagem_config SET tipo_embalagem = 'balde', quantidade_total = 5, unidade_total = 'kg'
  WHERE insumo_id = (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = 'INS019');

  -- ============================================================
  -- 3 e 4. MODELO DE RECIPIENTE POR INSUMO + RECIPIENTES FÍSICOS
  --
  -- Da aba "Recipientes": modelo, capacidade e "Nº atual" (quantos existem).
  -- A capacidade é gravada na unidade do próprio insumo (ml para essências,
  -- unid para o spray), não em kg como na planilha.
  --
  -- O enum subtipo_local_enum não tem "pote"; Pote G/PP/5L/10L/20L entram como
  -- 'balde' e o modelo real fica no nome do recipiente.
  -- ============================================================

  FOR v_rec IN
    SELECT * FROM (VALUES
      -- código,  modelo,                subtipo,              cap,    unid,   qtd
      ('INS001', 'Pote G',              'balde',              17,     'kg',   2),
      ('INS002', 'Pote G',              'balde',              11,     'kg',   3),
      ('INS003', 'Pote G',              'balde',              10,     'kg',   2),
      ('INS004', 'Pote G',              'balde',              10,     'kg',   2),
      ('INS005', 'Caixa plástica',      'caixa_plastica',     5,      'kg',   4),
      ('INS006', 'Caixa plástica',      'caixa_plastica',     16.2,   'kg',   2),
      ('INS007', 'Pote PP',             'balde',              2,      'kg',   6),
      ('INS008', 'Balde forn. 10kg',    'balde_fornecedor',   10,     'kg',   1),
      ('INS009', 'Garrafa 1L',          'garrafa',            1,      'kg',   6),
      ('INS010', 'Garrafa forn. 960mL', 'garrafa_fornecedor', 960,    'ml',   4),
      ('INS011', 'Pote G',              'balde',              12,     'kg',   1),
      ('INS012', 'Pote G',              'balde',              12,     'kg',   3),
      ('INS013', 'Pote G',              'balde',              12,     'kg',   3),
      ('INS014', 'Balde forn. 4,8kg',   'balde_fornecedor',   4.8,    'kg',   9),
      ('INS015', 'Pote PP',             'balde',              1.5,    'kg',   1),
      ('INS016', 'Pote PP',             'balde',              1,      'kg',   1),
      ('INS017', 'Pote PP',             'balde',              1,      'kg',   1),
      ('INS018', 'Pote 10L',            'balde',              6,      'kg',   1),
      ('INS019', 'Garrafa 1L',          'garrafa',            1,      'kg',   2),
      ('INS020', 'Lata forn. 600g',     'lata',               1,      'unid', 3),
      ('INS021', 'Pote 20L',            'balde',              10,     'kg',   0),
      ('INS022', 'Pote 5L',             'balde',              2.25,   'kg',   0),
      ('INS023', 'Pote 10L',            'balde',              5000,   'g',    0),
      ('INS027', 'Saco de Conf. 750g',  'saco_confeitar',     0.75,   'kg',   15)
    ) AS t(codigo, modelo, subtipo, cap, unid, qtd)
  LOOP
    SELECT id INTO v_ins FROM insumos
     WHERE empresa_id = v_empresa_id AND codigo = v_rec.codigo;

    CONTINUE WHEN v_ins IS NULL;

    -- Modelo salvo no insumo: a tela de Recipientes usa isto para pré-preencher
    UPDATE insumos
       SET recipiente_subtipo        = v_rec.subtipo,
           recipiente_capacidade_max = v_rec.cap,
           recipiente_unidade_cap    = v_rec.unid
     WHERE id = v_ins;

    -- Recipientes físicos, um registro por pote/balde/garrafa que existe hoje
    FOR v_i IN 1..v_rec.qtd LOOP
      v_qr := 'QR-EP-' || upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12));

      INSERT INTO locais (
        empresa_id, nome, tipo, subtipo, insumo_id,
        capacidade_max, unidade_capacidade, qr_code_fixo, ativo
      )
      VALUES (
        v_empresa_id,
        v_rec.modelo || ' ' || (SELECT nome FROM insumos WHERE id = v_ins) || ' #' || v_i,
        'estoque_produtivo',
        v_rec.subtipo::subtipo_local_enum,
        v_ins,
        v_rec.cap,
        v_rec.unid::unidade_medida_enum,
        v_qr,
        true
      )
      ON CONFLICT (empresa_id, nome) DO NOTHING;
    END LOOP;
  END LOOP;

  -- ============================================================
  -- 5. FICHAS TÉCNICAS
  -- ============================================================

  -- 5a. Aposenta as fichas Morena Cacau (migration 023) e libera FT-001/FT-002.
  -- Não são apagadas: qualquer produção histórica continua rastreável.
  UPDATE fichas_tecnicas
     SET codigo = 'FT-9' || substring(codigo from 4), ativo = false
   WHERE empresa_id = v_empresa_id
     AND codigo IN ('FT-001', 'FT-002')
     AND nome LIKE '%Morena Cacau%';

  -- 5b. Odara — Brownie Tradicional
  --
  -- Ficha original: 4 formas × 4.100 g = 16.400 g. Cada forma rende 60 unidades.
  -- Portanto quantidade por unidade = valor da ficha ÷ 4 ÷ 60.
  --
  -- Fora da conta, de propósito:
  --   • Água (do ovo e dos conservantes) — vem da torneira, não é insumo de estoque
  --   • Spray desmoldante — aplicado na forma, não dosado pela receita
  -- Somados, por serem o mesmo insumo em usos diferentes:
  --   • Cobertura Ao Leite = derretida 662,8 g + gotas 2.591,2 g = 3.254,0 g
  SELECT jsonb_agg(jsonb_build_object(
           'insumo_id', (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = x.cod),
           'quantidade', x.qtd, 'unidade', x.un, 'observacoes', x.obs))
    INTO v_itens
    FROM (VALUES
      ('INS001', 11.6533, 'g',  NULL),                                   -- Açúcar Refinado
      ('INS012', 13.5583, 'g',  'derretida + gotas, somadas'),           -- Cobertura Ao Leite
      ('INS002',  7.4225, 'g',  NULL),                                   -- Farinha de Trigo
      ('INS006',  7.0625, 'g',  NULL),                                   -- Óleo
      ('INS003',  6.4958, 'g',  NULL),                                   -- Choco em Pó 50%
      ('INS014',  4.6383, 'g',  NULL),                                   -- Doce de Leite
      ('INS007',  3.3404, 'g',  NULL),                                   -- Açúcar Invertido
      ('INS005',  2.6483, 'g',  NULL),                                   -- Ovo em Pó
      ('INS009',  1.7654, 'g',  NULL),                                   -- Glicerina
      ('INS008',  1.6704, 'g',  NULL),                                   -- Xarope de Glucose
      ('INS004',  0.7063, 'g',  NULL),                                   -- Sorbitol
      ('INS010',  0.1854, 'ml', NULL),                                   -- Essência de Baunilha
      ('INS015',  0.1854, 'g',  NULL),                                   -- Sal
      ('INS024',  0.1708, 'g',  'travado em 0,25% da receita'),          -- Lecitina de Soja
      ('INS016',  0.1367, 'g',  'travado em 0,20% da receita'),          -- Propionato de Cálcio
      ('INS017',  0.0683, 'g',  'travado em 0,10% da receita'),          -- Ácido Cítrico Anidro
      ('INS018',  0.0683, 'g',  'travado em 0,10% da receita'),          -- Sorbato de Potássio
      ('INS019',  0.0342, 'g',  'travado em 0,05% da receita')           -- Extrato de Alecrim
    ) AS x(cod, qtd, un, obs);

  PERFORM criar_ficha_tecnica(
    v_empresa_id, v_user_id, 'FT-001', 'Brownie Tradicional Odara',
    'Odara — 4 formas × 4.100 g de insumos (16,4 kg). Pesar 4.050 g/forma; 50 g/forma de margem de perda. Forno: pré 250 °C, assar 160 °C por 22 min 30 s.',
    'Versão inicial — Ficha Técnica Tradicional Odara 4x v10',
    60, 67.5, v_itens, 'produto', NULL
  );

  -- 5c. Odara — Doce de Leite
  -- Doce de Leite = massa 2.235,6 g + topping 800 g (200 g/forma) = 3.035,6 g
  SELECT jsonb_agg(jsonb_build_object(
           'insumo_id', (SELECT id FROM insumos WHERE empresa_id = v_empresa_id AND codigo = x.cod),
           'quantidade', x.qtd, 'unidade', x.un, 'observacoes', x.obs))
    INTO v_itens
    FROM (VALUES
      ('INS014', 12.6483, 'g',  'massa + topping de 200 g/forma, somados'), -- Doce de Leite
      ('INS001', 11.0646, 'g',  NULL),                                   -- Açúcar Refinado
      ('INS002', 10.7404, 'g',  NULL),                                   -- Farinha de Trigo
      ('INS013', 10.3183, 'g',  'travado em 15,10% da receita'),         -- Cobertura Caramelo
      ('INS011',  4.9875, 'g',  NULL),                                   -- Cobertura Branca
      ('INS006',  4.3383, 'g',  NULL),                                   -- Óleo
      ('INS004',  1.8983, 'g',  NULL),                                   -- Sorbitol
      ('INS007',  1.7379, 'g',  NULL),                                   -- Açúcar Invertido
      ('INS005',  1.4721, 'g',  NULL),                                   -- Ovo em Pó
      ('INS009',  1.1408, 'g',  NULL),                                   -- Glicerina
      ('INS008',  0.8683, 'g',  NULL),                                   -- Xarope de Glucose
      ('INS010',  0.4329, 'ml', NULL),                                   -- Essência de Baunilha
      ('INS015',  0.4329, 'g',  NULL),                                   -- Sal
      ('INS024',  0.2050, 'g',  'travado em 0,30% da receita'),          -- Lecitina de Soja
      ('INS025',  0.1708, 'g',  'travado em 0,25% da receita'),          -- Essência de Doce de Leite
      ('INS016',  0.1367, 'g',  'travado em 0,20% da receita'),          -- Propionato de Cálcio
      ('INS017',  0.0683, 'g',  'travado em 0,10% da receita'),          -- Ácido Cítrico Anidro
      ('INS018',  0.0683, 'g',  'travado em 0,10% da receita'),          -- Sorbato de Potássio
      ('INS019',  0.0342, 'g',  'travado em 0,05% da receita')           -- Extrato de Alecrim
    ) AS x(cod, qtd, un, obs);

  PERFORM criar_ficha_tecnica(
    v_empresa_id, v_user_id, 'FT-002', 'Brownie Doce de Leite Odara',
    'Odara — 4 formas × 4.100 g de insumos (16,4 kg). Pesar 3.850 g/forma de massa; topping de 200 g/forma porcionado por cima. Forno: pré 250 °C, assar 160 °C por 23 min 30 s.',
    'Versão inicial — Ficha Técnica Doce de Leite 4x',
    60, 67.5, v_itens, 'produto', NULL
  );

END $$;

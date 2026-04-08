-- ============================================================
-- MISCHAOS — MÓDULO DE ESTOQUE & RASTREABILIDADE
-- Schema Supabase / PostgreSQL
-- Versão: 1.0.0
-- ============================================================

-- ── EXTENSÕES ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- busca por texto

-- ── ENUMS ───────────────────────────────────────────────────

CREATE TYPE sexo_enum AS ENUM ('M', 'F', 'Outro');

CREATE TYPE papel_usuario_enum AS ENUM (
  'admin',       -- dono, acesso total
  'gestao',      -- gerente, acesso total exceto config empresa
  'producao',    -- Beatriz/Enzo, sem acesso a custos/config
  'compras'      -- acesso recebimento e estoque
);

CREATE TYPE tipo_embalagem_fornecedor_enum AS ENUM (
  'fardo',
  'caixa',
  'saca',
  'balde',
  'garrafa',
  'lata',
  'display',
  'saco',
  'unidade'
);

CREATE TYPE tipo_armazenamento_ep_enum AS ENUM (
  'balde',                -- ingredientes secos e líquidos viscosos
  'garrafa_fornecedor',   -- garrafa original do fornecedor
  'balde_fornecedor',     -- balde original do fornecedor
  'caixa_plastica',       -- caixa plástica (ex: garrafas de óleo)
  'saco_confeitar',       -- saco de confeitar (ex: Nutella, DDL topping)
  'lata',                 -- lata original (ex: spray desmoldante)
  'unidade'               -- unidade avulsa
);

CREATE TYPE unidade_medida_enum AS ENUM (
  'kg', 'g', 'L', 'ml', 'unid'
);

CREATE TYPE status_lote_enum AS ENUM (
  'ativo',       -- em uso
  'esgotado',    -- quantidade zerada normalmente
  'descartado',  -- descartado por perda/vencimento
  'vencido'      -- passou da validade
);

CREATE TYPE status_lote_unidade_enum AS ENUM (
  'no_estoque_central',
  'no_estoque_produtivo',
  'parcialmente_transferida', -- fardo aberto mas não totalmente transferido (não permitido no modelo atual)
  'esgotada',
  'descartada'
);

CREATE TYPE tipo_movimentacao_enum AS ENUM (
  'entrada',           -- recebimento de lote
  'transferencia',     -- EC → EP (balde, caixa plástica, etc.)
  'reembalagem',       -- transformação (Nutella → sacos de confeitar)
  'consumo_producao',  -- baixa por produção
  'perda_insumo',      -- baixa por acidente, vencimento, qualidade
  'ajuste_inventario'  -- correção manual
);

CREATE TYPE tipo_local_enum AS ENUM (
  'estoque_central',
  'estoque_produtivo'
);

CREATE TYPE subtipo_local_enum AS ENUM (
  'prateleira',
  'balde',
  'balde_fornecedor',
  'caixa_plastica',
  'garrafa',
  'garrafa_fornecedor',
  'saco_confeitar',
  'lata'
);

CREATE TYPE status_sessao_enum AS ENUM (
  'planejada',    -- criada, baldes ainda não confirmados
  'aberta',       -- produção em andamento
  'fechada',      -- produção encerrada e registrada
  'cancelada'
);

CREATE TYPE motivo_perda_enum AS ENUM (
  'vencimento',
  'embalagem_danificada',
  'contaminacao',
  'queda_acidente',
  'qualidade_reprovada',
  'outro'
);

-- ============================================================
-- 1. EMPRESAS
-- ============================================================
CREATE TABLE empresas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome            VARCHAR(255) NOT NULL,
  cnpj            VARCHAR(18)  UNIQUE,
  email           VARCHAR(255),
  telefone        VARCHAR(20),
  endereco        TEXT,
  cidade          VARCHAR(100),
  estado          CHAR(2),
  cep             VARCHAR(9),
  logo_url        TEXT,
  ativa           BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE empresas IS
  'Cada conta no sistema representa uma empresa. '
  'O admin que cria a conta vincula todos os dados a esta empresa.';

-- ============================================================
-- 2. USUÁRIOS
-- Integra com auth.users do Supabase.
-- O admin (papel=admin) é criado ao registrar a empresa.
-- Usuários secundários são criados pelo admin em Configurações.
-- ============================================================
CREATE TABLE usuarios (
  id              UUID PRIMARY KEY, -- mesmo UUID do auth.users
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome            VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  sexo            sexo_enum,
  cpf             VARCHAR(14),
  celular         VARCHAR(20),
  papel           papel_usuario_enum NOT NULL DEFAULT 'producao',
  ativo           BOOLEAN NOT NULL DEFAULT true,
  ultimo_acesso   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE usuarios IS
  'Usuários vinculados a uma empresa. O campo id é o mesmo UUID do Supabase Auth. '
  'Papel admin = acesso total. Demais papéis com acesso total por enquanto (evolução futura).';

COMMENT ON COLUMN usuarios.papel IS
  'admin: dono/criador da empresa. '
  'gestao: gerente. producao: equipe de chão de fábrica. compras: responsável por recebimento.';

-- ============================================================
-- 3. CATEGORIAS DE INSUMO
-- ============================================================
CREATE TABLE categorias_insumo (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome        VARCHAR(100) NOT NULL,
  cor_hex     VARCHAR(7),  -- ex: #F3294E
  descricao   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, nome)
);

COMMENT ON TABLE categorias_insumo IS
  'Categorias como BALDES, LIQUIDOS, COBERTURAS, CONSERVANTES. '
  'Indica o modo de armazenamento no EP e agrupa insumos no dashboard.';

-- ============================================================
-- 4. FORNECEDORES
-- ============================================================
CREATE TABLE fornecedores (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome        VARCHAR(255) NOT NULL,
  marca       VARCHAR(255),
  cnpj        VARCHAR(18),
  contato     VARCHAR(255),
  telefone    VARCHAR(20),
  email       VARCHAR(255),
  cidade      VARCHAR(100),
  observacoes TEXT,
  ativo       BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, nome)
);

-- ============================================================
-- 5. INSUMOS (catálogo de ingredientes)
-- ============================================================
CREATE TABLE insumos (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id                UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo                    VARCHAR(20) NOT NULL,   -- INS001, INS002...
  nome                      VARCHAR(255) NOT NULL,
  categoria_id              UUID REFERENCES categorias_insumo(id),
  unidade_medida            unidade_medida_enum NOT NULL DEFAULT 'kg',
  shelf_life_dias_pos_abertura INTEGER,             -- dias de validade após abertura/manipulação
  estoque_minimo            DECIMAL(10,3),          -- quantidade mínima no EC para alerta
  ativo                     BOOLEAN NOT NULL DEFAULT true,
  observacoes               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo),
  UNIQUE (empresa_id, nome)
);

COMMENT ON COLUMN insumos.shelf_life_dias_pos_abertura IS
  'Quantidade de dias de validade após abertura/manipulação da embalagem. '
  'Usado no cálculo: validade_pos_abertura = MIN(validade_original, data_recebimento + shelf_life_dias).';

COMMENT ON COLUMN insumos.estoque_minimo IS
  'Quantidade mínima total (EC + EP) que dispara alerta de reposição no dashboard.';

-- ============================================================
-- 5A. CONFIGURAÇÃO DE EMBALAGEM DO FORNECEDOR
-- Como o insumo vem embalado pelo fornecedor
-- ============================================================
CREATE TABLE insumos_embalagem_config (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  insumo_id             UUID NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  tipo_embalagem        tipo_embalagem_fornecedor_enum NOT NULL,
  -- Peso/volume total da embalagem completa
  quantidade_total      DECIMAL(10,3) NOT NULL,
  unidade_total         unidade_medida_enum NOT NULL,
  -- Sub-unidades dentro da embalagem (ex: fardo com 10 pacotes de 1kg)
  tem_subunidades       BOOLEAN NOT NULL DEFAULT false,
  subunidade_tipo       VARCHAR(100),   -- 'pacote', 'saco', 'garrafa', 'unidade'
  subunidade_quantidade INTEGER,        -- quantas sub-unidades por embalagem (ex: 10)
  subunidade_peso       DECIMAL(10,3),  -- peso de cada sub-unidade (ex: 1)
  subunidade_unidade    unidade_medida_enum,  -- unidade da sub-unidade (ex: kg)
  observacoes           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (insumo_id),
  -- Validação: se tem sub-unidades, os campos de sub-unidade são obrigatórios
  CONSTRAINT chk_subunidades CHECK (
    (tem_subunidades = false) OR
    (tem_subunidades = true AND subunidade_tipo IS NOT NULL
      AND subunidade_quantidade IS NOT NULL
      AND subunidade_peso IS NOT NULL
      AND subunidade_unidade IS NOT NULL)
  )
);

COMMENT ON TABLE insumos_embalagem_config IS
  'Define como cada insumo chega do fornecedor. '
  'Ex: Açúcar vem em fardo (10kg) com 10 pacotes de 1kg cada. '
  'Caixa de óleo vem com 20 garrafas de 810g cada. '
  'Saca de farinha vem como 10kg sem sub-unidades.';

-- ============================================================
-- 5B. CONFIGURAÇÃO DE ARMAZENAMENTO NO ESTOQUE PRODUTIVO
-- Como o insumo é armazenado e usado no EP
-- ============================================================
CREATE TABLE insumos_armazenamento_config (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  insumo_id                 UUID NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  tipo_armazenamento        tipo_armazenamento_ep_enum NOT NULL,
  -- Reembalagem (ex: Nutella vira sacos de confeitar)
  passa_reembalagem         BOOLEAN NOT NULL DEFAULT false,
  reembalagem_formato       VARCHAR(100),    -- 'saco_confeitar', 'porcionamento'
  reembalagem_tamanho_porcao DECIMAL(10,3),  -- tamanho de cada porção (ex: 625)
  reembalagem_unidade       unidade_medida_enum, -- unidade da porção (ex: g)
  -- Destino múltiplo (ex: DDL vai para balde E para sacos de confeitar)
  destino_multiplo          BOOLEAN NOT NULL DEFAULT false,
  destino_multiplo_descricao TEXT,  -- descreve os destinos
  observacoes               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (insumo_id),
  CONSTRAINT chk_reembalagem CHECK (
    (passa_reembalagem = false) OR
    (passa_reembalagem = true AND reembalagem_formato IS NOT NULL
      AND reembalagem_tamanho_porcao IS NOT NULL
      AND reembalagem_unidade IS NOT NULL)
  )
);

COMMENT ON TABLE insumos_armazenamento_config IS
  'Define como o insumo é armazenado no Estoque Produtivo. '
  'Ex: Açúcar → balde. Óleo → caixa_plastica. Nutella → saco_confeitar (passa reembalagem). '
  'DDL → destino_multiplo (balde para massa + saco confeitar para topping). '
  'Extrato de Alecrim → garrafa_fornecedor (vai na garrafa original).';

-- ============================================================
-- 6. LOCAIS DE ARMAZENAMENTO
-- Inclui EC (estoque central) e EP (estoque produtivo)
-- Cada balde, caixa plástica, garrafa do EP tem QR Code fixo
-- ============================================================
CREATE TABLE locais (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome            VARCHAR(255) NOT NULL,
  tipo            tipo_local_enum NOT NULL,
  subtipo         subtipo_local_enum,
  -- Insumo dedicado (ex: Balde de Açúcar só recebe açúcar)
  insumo_id       UUID REFERENCES insumos(id),
  capacidade_max  DECIMAL(10,3),
  unidade_capacidade unidade_medida_enum,
  -- QR Code fixo colado no recipiente físico (só EP e recipientes físicos)
  qr_code_fixo    VARCHAR(100) UNIQUE,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  observacoes     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, nome)
);

COMMENT ON TABLE locais IS
  'Locais de armazenamento físicos. '
  'EC: prateleiras da sala de estoque (sem QR fixo, usa QR do lote). '
  'EP: baldes, caixas plásticas, garrafas, sacos — cada um com QR fixo colado permanentemente. '
  'Um local EP é sempre dedicado a um único insumo (campo insumo_id). '
  'Um local EP nunca pode ter dois lotes ativos simultaneamente (regra de negócio).';

COMMENT ON COLUMN locais.qr_code_fixo IS
  'QR Code permanente colado fisicamente no recipiente. '
  'No EC, os QR codes ficam nos lotes (embalagens). '
  'No EP, o QR fica no recipiente (balde, caixa, etc.) e o lote atual é rastreado pelo sistema.';

-- ============================================================
-- 7. FICHAS TÉCNICAS (RECEITAS)
-- Com versionamento imutável — cada produção histórica
-- fica vinculada à versão ativa no dia da produção.
-- ============================================================
CREATE TABLE fichas_tecnicas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo          VARCHAR(20) NOT NULL,   -- FT-001
  nome            VARCHAR(255) NOT NULL,  -- 'Brownie Clássico 90g'
  descricao       TEXT,
  versao_atual    INTEGER NOT NULL DEFAULT 1,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo),
  UNIQUE (empresa_id, nome)
);

CREATE TABLE fichas_tecnicas_versoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ficha_id        UUID NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE RESTRICT,
  versao          INTEGER NOT NULL,
  criado_por      UUID NOT NULL REFERENCES usuarios(id),
  notas_alteracao TEXT NOT NULL,  -- obrigatório: descrever o que mudou
  ativa           BOOLEAN NOT NULL DEFAULT true,  -- apenas 1 ativa por ficha
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ficha_id, versao),
  -- Garantia: no máximo 1 versão ativa por ficha
  CONSTRAINT chk_uma_versao_ativa UNIQUE (ficha_id, ativa)
    DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE fichas_tecnicas_versoes IS
  'Cada alteração na receita cria uma nova versão imutável. '
  'As versões anteriores são desativadas mas nunca deletadas. '
  'Produções históricas ficam vinculadas à versão que estava ativa no dia.';

COMMENT ON COLUMN fichas_tecnicas_versoes.notas_alteracao IS
  'Obrigatório descrever o que mudou nesta versão. '
  'Funciona como um commit message do Git.';

CREATE TABLE fichas_tecnicas_itens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  versao_id       UUID NOT NULL REFERENCES fichas_tecnicas_versoes(id) ON DELETE RESTRICT,
  insumo_id       UUID NOT NULL REFERENCES insumos(id),
  quantidade      DECIMAL(12,4) NOT NULL,  -- quantidade por unidade do produto final
  unidade         unidade_medida_enum NOT NULL,
  observacoes     TEXT,
  UNIQUE (versao_id, insumo_id)
);

COMMENT ON TABLE fichas_tecnicas_itens IS
  'Ingredientes de uma versão específica de receita. '
  'quantidade = consumo por unidade do produto final (ex: 0.018 kg de farinha por brownie). '
  'O consumo teórico de uma produção = quantidade * qtd_planejada.';

-- ============================================================
-- 8. LOTES
-- Gerado a cada recebimento de insumo.
-- Um lote = uma embalagem (fardo, caixa, saca, balde...).
-- A validade_pos_abertura é calculada no momento do recebimento.
-- ============================================================
CREATE TABLE lotes (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id              UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo                  VARCHAR(30) NOT NULL,     -- LOTE-001
  insumo_id               UUID NOT NULL REFERENCES insumos(id),
  fornecedor_id           UUID REFERENCES fornecedores(id),
  data_recebimento        DATE NOT NULL DEFAULT CURRENT_DATE,
  data_fabricacao         DATE,
  validade_original       DATE NOT NULL,            -- validade impressa na embalagem
  validade_pos_abertura   DATE NOT NULL,            -- MIN(validade_original, data_rec + shelf_life)
  -- Quantidade
  quantidade_recebida     DECIMAL(12,3) NOT NULL,
  unidade                 unidade_medida_enum NOT NULL,
  quantidade_disponivel   DECIMAL(12,3) NOT NULL,   -- decrementado a cada movimentação
  -- Localização atual no EC (no EP, o controle é pelo local_id do lote_unidade)
  status                  status_lote_enum NOT NULL DEFAULT 'ativo',
  -- Rastreabilidade
  recebido_por            UUID NOT NULL REFERENCES usuarios(id),
  qr_code                 VARCHAR(100) UNIQUE,      -- QR-LOTE-001 (impresso na embalagem)
  observacoes             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo),
  CONSTRAINT chk_validade CHECK (validade_pos_abertura <= validade_original),
  CONSTRAINT chk_quantidade CHECK (quantidade_disponivel >= 0)
);

COMMENT ON TABLE lotes IS
  'Cada recebimento gera um lote. Um lote representa uma embalagem física (fardo, caixa, etc). '
  'O QR Code é impresso no momento do recebimento e colado na embalagem. '
  'quantidade_disponivel é decrementada a cada movimentação (transferência, consumo, perda). '
  'validade_pos_abertura = MIN(validade_original, data_recebimento + insumo.shelf_life_dias_pos_abertura).';

COMMENT ON COLUMN lotes.qr_code IS
  'QR Code único gerado pelo sistema e impresso na etiqueta colada na embalagem. '
  'Escanear este QR identifica o lote no sistema para todas as operações.';

-- ============================================================
-- 8A. UNIDADES DE LOTE
-- Sub-unidades de um lote (ex: cada garrafa de uma caixa de óleo,
-- cada pacote de um fardo, cada saco de confeitar gerado).
-- Nem todo insumo tem sub-unidades cadastradas individualmente
-- (apenas os que requerem rastreio individual por unidade).
-- ============================================================
CREATE TABLE lotes_unidades (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lote_id         UUID NOT NULL REFERENCES lotes(id) ON DELETE RESTRICT,
  codigo          VARCHAR(50) NOT NULL UNIQUE,    -- LOTE-001-U01
  tipo_unidade    VARCHAR(100) NOT NULL,           -- 'garrafa', 'saco_confeitar', 'pacote'
  peso_volume     DECIMAL(10,3),
  unidade         unidade_medida_enum,
  status          status_lote_unidade_enum NOT NULL DEFAULT 'no_estoque_central',
  local_atual_id  UUID REFERENCES locais(id),
  qr_code         VARCHAR(100) UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE lotes_unidades IS
  'Sub-unidades físicas de um lote, quando há rastreio individual. '
  'Ex: Cada garrafa da caixa de óleo (20 por caixa). '
  'Cada saco de confeitar gerado a partir de um balde de Nutella. '
  'Insumos em granel (açúcar, farinha) não têm lotes_unidades — controle é por peso no lote.';

-- ============================================================
-- 9. MOVIMENTAÇÕES DE ESTOQUE
-- Toda movimentação de insumo gera um registro aqui.
-- É o log auditável completo de tudo que aconteceu.
-- ============================================================
CREATE TABLE movimentacoes (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id          UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo              VARCHAR(30) NOT NULL,     -- MOV-001
  tipo                tipo_movimentacao_enum NOT NULL,
  data_hora           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responsavel_id      UUID NOT NULL REFERENCES usuarios(id),
  sessao_producao_id  UUID,   -- FK adicionada depois (referência circular)
  observacoes         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo)
);

CREATE TABLE movimentacoes_itens (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  movimentacao_id     UUID NOT NULL REFERENCES movimentacoes(id) ON DELETE CASCADE,
  lote_id             UUID NOT NULL REFERENCES lotes(id),
  lote_unidade_id     UUID REFERENCES lotes_unidades(id),  -- NULL para granel
  local_origem_id     UUID REFERENCES locais(id),           -- NULL para entradas
  local_destino_id    UUID REFERENCES locais(id),           -- NULL para consumos/perdas
  quantidade          DECIMAL(12,3) NOT NULL,
  unidade             unidade_medida_enum NOT NULL,
  observacoes         TEXT
);

COMMENT ON TABLE movimentacoes IS
  'Log imutável de todas as movimentações. '
  'ENTRADA: recebimento → EC. '
  'TRANSFERENCIA: EC → EP (balde, caixa plástica, etc.). '
  'REEMBALAGEM: Nutella/DDL → sacos de confeitar. '
  'CONSUMO_PRODUCAO: baixa gerada pelo fechamento de sessão. '
  'PERDA_INSUMO: descarte por acidente/vencimento/qualidade. '
  'AJUSTE_INVENTARIO: correção manual pelo admin.';

COMMENT ON COLUMN movimentacoes_itens.lote_unidade_id IS
  'Preenchido quando o movimento é de uma sub-unidade específica (ex: garrafa de óleo). '
  'NULL para insumos em granel (ex: açúcar pesado em kg).';

-- ============================================================
-- 10. REEMBALAGENS
-- Processo de transformação de embalagem original em
-- novas unidades para o EP (Nutella → sacos de confeitar,
-- DDL → sacos de confeitar para topping).
-- ============================================================
CREATE TABLE reembalagens (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id                  UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo                      VARCHAR(30) NOT NULL UNIQUE,   -- REMB-001
  lote_id                     UUID NOT NULL REFERENCES lotes(id),
  insumo_id                   UUID NOT NULL REFERENCES insumos(id),
  data_hora                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responsavel_id              UUID NOT NULL REFERENCES usuarios(id),
  -- Origem
  quantidade_utilizada        DECIMAL(10,3) NOT NULL,  -- quanto do lote foi usado
  unidade_utilizada           unidade_medida_enum NOT NULL,
  -- Resultado
  tipo_resultado              VARCHAR(100) NOT NULL,   -- 'saco_confeitar'
  tamanho_porcao              DECIMAL(10,3) NOT NULL,  -- 625g, 600g
  unidade_porcao              unidade_medida_enum NOT NULL,
  quantidade_unidades_geradas INTEGER NOT NULL,         -- quantos sacos foram feitos
  peso_total_gerado           DECIMAL(10,3) NOT NULL,  -- tamanho_porcao * qtd_unidades
  sobra                       DECIMAL(10,3) NOT NULL DEFAULT 0,  -- descartada ou registrada como perda
  local_destino_id            UUID REFERENCES locais(id),
  observacoes                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reembalagem_totais CHECK (
    quantidade_utilizada >= (tamanho_porcao * quantidade_unidades_geradas)
  )
);

COMMENT ON TABLE reembalagens IS
  'Registra a transformação de embalagem original em novas unidades para o EP. '
  'Ex: Balde de Nutella 3kg → 4 sacos de confeitar de 625g + 500g de sobra. '
  'Ex: Balde de DDL 4,8kg → X sacos de 600g para topping. '
  'Cada saco gerado recebe um QR Code próprio em lotes_unidades, vinculado ao lote pai.';

-- ============================================================
-- 11. ESTADO ATUAL DOS LOCAIS (EP)
-- Controla qual lote está ativo em cada recipiente do EP.
-- REGRA DE OURO: um local EP só pode ter UM lote ativo por vez.
-- ============================================================
CREATE TABLE locais_estado_atual (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  local_id        UUID NOT NULL REFERENCES locais(id) ON DELETE RESTRICT,
  lote_id         UUID REFERENCES lotes(id),             -- NULL = vazio
  lote_unidade_id UUID REFERENCES lotes_unidades(id),    -- para sub-unidades (sacos confeitar)
  quantidade      DECIMAL(12,3) NOT NULL DEFAULT 0,       -- quantidade atual no local
  unidade         unidade_medida_enum,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por  UUID REFERENCES usuarios(id),
  UNIQUE (local_id)  -- um estado por local
);

COMMENT ON TABLE locais_estado_atual IS
  'Snapshot do estado atual de cada recipiente no EP. '
  'Atualizado automaticamente a cada movimentação (transferência, consumo, perda). '
  'CONSTRAINT de negócio: se quantidade > 0 e local já tem lote ativo de insumo diferente, '
  'o sistema rejeita a transferência (nunca misturar lotes). '
  'Esta tabela é a fonte de verdade para o dashboard de estoque.';

-- ============================================================
-- 12. SESSÕES DE PRODUÇÃO
-- Uma sessão = um dia de produção.
-- Pode ter múltiplos SKUs na mesma sessão.
-- Lucca abre, Beatriz fecha.
-- ============================================================
CREATE TABLE sessoes_producao (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id          UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo              VARCHAR(40) NOT NULL,   -- SESS-2025-04-03-001
  data_producao       DATE NOT NULL,
  status              status_sessao_enum NOT NULL DEFAULT 'planejada',
  aberta_por          UUID NOT NULL REFERENCES usuarios(id),
  fechada_por         UUID REFERENCES usuarios(id),
  data_abertura       TIMESTAMPTZ,
  data_fechamento     TIMESTAMPTZ,
  observacoes_abertura  TEXT,
  observacoes_fechamento TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo),
  CONSTRAINT chk_datas_sessao CHECK (
    data_fechamento IS NULL OR data_fechamento >= data_abertura
  )
);

COMMENT ON TABLE sessoes_producao IS
  'Uma sessão de produção representa um dia de fabricação. '
  'Pode conter múltiplos SKUs (ex: Brownie Clássico + Brownie DDL no mesmo dia). '
  'Status: planejada → aberta → fechada. '
  'Lucca abre (define SKUs e valida baldes). Beatriz fecha (registra sobras e perdas).';

-- ============================================================
-- 12A. SKUs PLANEJADOS PARA A SESSÃO
-- ============================================================
CREATE TABLE sessoes_producao_skus (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sessao_id             UUID NOT NULL REFERENCES sessoes_producao(id) ON DELETE CASCADE,
  ficha_tecnica_id      UUID NOT NULL REFERENCES fichas_tecnicas(id),
  ficha_versao_id       UUID NOT NULL REFERENCES fichas_tecnicas_versoes(id),
  quantidade_planejada  INTEGER NOT NULL,
  quantidade_produzida  INTEGER,  -- preenchido no fechamento
  quantidade_perdida    INTEGER,  -- perdas de processo (brownies quebrados, etc.)
  -- fator_perda = quantidade_perdida / quantidade_produzida (calculado na aplicação ou view)
  UNIQUE (sessao_id, ficha_tecnica_id)
);

COMMENT ON TABLE sessoes_producao_skus IS
  'SKUs planejados para uma sessão. '
  'quantidade_planejada: definido na abertura. '
  'quantidade_produzida / quantidade_perdida: preenchido no fechamento por Beatriz. '
  'fator_perda = quantidade_perdida / quantidade_produzida — calculado na aplicação.';

-- ============================================================
-- 12B. BALDES/RECIPIENTES USADOS NA SESSÃO
-- Vincula cada recipiente EP ao lote que estava nele durante a produção.
-- ============================================================
CREATE TABLE sessoes_producao_locais (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sessao_id             UUID NOT NULL REFERENCES sessoes_producao(id) ON DELETE CASCADE,
  local_id              UUID NOT NULL REFERENCES locais(id),  -- balde/recipiente EP
  insumo_id             UUID NOT NULL REFERENCES insumos(id),
  lote_id               UUID NOT NULL REFERENCES lotes(id),   -- lote que estava no balde
  -- Quantidades
  quantidade_inicial    DECIMAL(12,3) NOT NULL,  -- confirmado na abertura (ou estimado)
  quantidade_final      DECIMAL(12,3),           -- sobra registrada por Beatriz no fechamento
  consumo_real          DECIMAL(12,3),           -- calculado: inicial - final
  consumo_teorico       DECIMAL(12,3),           -- calculado pela ficha técnica * qtd_planejada
  desvio                DECIMAL(12,3),           -- consumo_real - consumo_teorico
  UNIQUE (sessao_id, local_id, lote_id)
);

COMMENT ON TABLE sessoes_producao_locais IS
  'Registra quais recipientes EP foram usados em cada sessão, com qual lote. '
  'Permite ter dois lotes do mesmo insumo numa sessão (ex: sobra do dia anterior no balde 1 + '
  'lote novo no balde 2) — são duas linhas diferentes nesta tabela. '
  'consumo_real = quantidade_inicial - quantidade_final (preenchido no fechamento). '
  'desvio = consumo_real - consumo_teorico (indicador de eficiência). '
  'Fonte da rastreabilidade: liga sessão → lote → insumo → produção.';

-- ============================================================
-- 13. PERDAS DE INSUMO
-- Separado das perdas de processo (que ficam em sessoes_producao_skus).
-- São perdas por acidentes, vencimento, qualidade.
-- ============================================================
CREATE TABLE perdas_insumo (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo          VARCHAR(30) NOT NULL,   -- PERDA-001
  data            DATE NOT NULL DEFAULT CURRENT_DATE,
  lote_id         UUID NOT NULL REFERENCES lotes(id),
  lote_unidade_id UUID REFERENCES lotes_unidades(id),  -- NULL para granel
  insumo_id       UUID NOT NULL REFERENCES insumos(id),
  local_id        UUID REFERENCES locais(id),
  quantidade      DECIMAL(12,3) NOT NULL,
  unidade         unidade_medida_enum NOT NULL,
  motivo          motivo_perda_enum NOT NULL,
  descricao       TEXT,
  responsavel_id  UUID NOT NULL REFERENCES usuarios(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, codigo),
  CONSTRAINT chk_quantidade_perda CHECK (quantidade > 0)
);

COMMENT ON TABLE perdas_insumo IS
  'Perdas de insumo por motivos externos à produção normal. '
  'Ex: saco de farinha rasgou (embalagem_danificada). '
  'Ex: ovos caíram (queda_acidente). '
  'Ex: manteiga venceu no estoque (vencimento). '
  'NÃO confundir com quantidade_perdida em sessoes_producao_skus '
  '(que são brownies perdidos no processo de fabricação).';

-- ============================================================
-- 14. CONFIGURAÇÕES DO SISTEMA
-- ============================================================
CREATE TABLE configuracoes_sistema (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id                  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  dias_alerta_validade        INTEGER NOT NULL DEFAULT 7,
  percentual_estoque_alerta   DECIMAL(5,2) NOT NULL DEFAULT 20.00, -- % abaixo do mínimo
  notificacoes_email          BOOLEAN NOT NULL DEFAULT false,
  notificacoes_whatsapp       BOOLEAN NOT NULL DEFAULT false,
  tema                        VARCHAR(20) NOT NULL DEFAULT 'light',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id)
);

-- ============================================================
-- FK CIRCULAR: movimentacoes → sessoes_producao
-- ============================================================
ALTER TABLE movimentacoes
  ADD CONSTRAINT fk_movimentacoes_sessao
  FOREIGN KEY (sessao_producao_id)
  REFERENCES sessoes_producao(id)
  ON DELETE SET NULL;

-- ============================================================
-- ÍNDICES DE PERFORMANCE
-- ============================================================

-- Lotes
CREATE INDEX idx_lotes_empresa        ON lotes(empresa_id);
CREATE INDEX idx_lotes_insumo         ON lotes(insumo_id);
CREATE INDEX idx_lotes_status         ON lotes(status);
CREATE INDEX idx_lotes_validade       ON lotes(validade_pos_abertura);
CREATE INDEX idx_lotes_qr             ON lotes(qr_code);

-- Movimentações
CREATE INDEX idx_mov_empresa          ON movimentacoes(empresa_id);
CREATE INDEX idx_mov_tipo             ON movimentacoes(tipo);
CREATE INDEX idx_mov_data             ON movimentacoes(data_hora);
CREATE INDEX idx_mov_sessao           ON movimentacoes(sessao_producao_id);
CREATE INDEX idx_mov_itens_lote       ON movimentacoes_itens(lote_id);
CREATE INDEX idx_mov_itens_local_orig ON movimentacoes_itens(local_origem_id);
CREATE INDEX idx_mov_itens_local_dest ON movimentacoes_itens(local_destino_id);

-- Sessões
CREATE INDEX idx_sessoes_empresa      ON sessoes_producao(empresa_id);
CREATE INDEX idx_sessoes_data         ON sessoes_producao(data_producao);
CREATE INDEX idx_sessoes_status       ON sessoes_producao(status);

-- Locais
CREATE INDEX idx_locais_empresa       ON locais(empresa_id);
CREATE INDEX idx_locais_tipo          ON locais(tipo);
CREATE INDEX idx_locais_qr            ON locais(qr_code_fixo);

-- Insumos
CREATE INDEX idx_insumos_empresa      ON insumos(empresa_id);
CREATE INDEX idx_insumos_categoria    ON insumos(categoria_id);

-- Perdas
CREATE INDEX idx_perdas_empresa       ON perdas_insumo(empresa_id);
CREATE INDEX idx_perdas_data          ON perdas_insumo(data);
CREATE INDEX idx_perdas_lote          ON perdas_insumo(lote_id);

-- ============================================================
-- VIEWS ÚTEIS
-- ============================================================

-- View: estoque atual consolidado (EC + EP por insumo)
CREATE OR REPLACE VIEW v_estoque_consolidado AS
SELECT
  i.empresa_id,
  i.id AS insumo_id,
  i.codigo AS insumo_codigo,
  i.nome AS insumo_nome,
  i.unidade_medida,
  i.estoque_minimo,
  -- Total EC
  COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_central' THEN l.quantidade_disponivel ELSE 0 END), 0)
    AS qtd_estoque_central,
  -- Total EP
  COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_produtivo' THEN lea.quantidade ELSE 0 END), 0)
    AS qtd_estoque_produtivo,
  -- Total geral
  COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_central' THEN l.quantidade_disponivel ELSE 0 END), 0) +
  COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_produtivo' THEN lea.quantidade ELSE 0 END), 0)
    AS qtd_total,
  -- Alerta de reposição
  CASE
    WHEN (
      COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_central' THEN l.quantidade_disponivel ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN loc.tipo = 'estoque_produtivo' THEN lea.quantidade ELSE 0 END), 0)
    ) < COALESCE(i.estoque_minimo, 0) THEN true
    ELSE false
  END AS alerta_reposicao
FROM insumos i
LEFT JOIN lotes l ON l.insumo_id = i.id AND l.status = 'ativo'
LEFT JOIN locais loc ON loc.id = (
  SELECT mi.local_destino_id FROM movimentacoes_itens mi
  WHERE mi.lote_id = l.id ORDER BY mi.rowid DESC LIMIT 1
)
LEFT JOIN locais_estado_atual lea ON lea.lote_id = l.id
GROUP BY i.empresa_id, i.id, i.codigo, i.nome, i.unidade_medida, i.estoque_minimo;

-- View: lotes próximos ao vencimento
CREATE OR REPLACE VIEW v_lotes_vencendo AS
SELECT
  l.empresa_id,
  l.id AS lote_id,
  l.codigo AS lote_codigo,
  i.nome AS insumo_nome,
  l.validade_pos_abertura,
  (l.validade_pos_abertura - CURRENT_DATE) AS dias_para_vencer,
  l.quantidade_disponivel,
  l.unidade,
  l.status
FROM lotes l
JOIN insumos i ON i.id = l.insumo_id
WHERE l.status = 'ativo'
  AND l.validade_pos_abertura <= CURRENT_DATE + INTERVAL '7 days'
ORDER BY l.validade_pos_abertura ASC;

-- View: rastreabilidade completa de produções
CREATE OR REPLACE VIEW v_rastreabilidade_producao AS
SELECT
  sp.data_producao,
  sp.codigo AS sessao_codigo,
  ft.nome AS produto_final,
  spsku.quantidade_produzida,
  spsku.quantidade_perdida,
  ROUND(
    CASE WHEN spsku.quantidade_produzida > 0
    THEN spsku.quantidade_perdida::DECIMAL / spsku.quantidade_produzida * 100
    ELSE 0 END, 2
  ) AS fator_perda_pct,
  i.nome AS insumo,
  spl.lote_id,
  l.codigo AS lote_codigo,
  spl.consumo_real,
  spl.consumo_teorico,
  spl.desvio,
  loc.nome AS recipiente_ep,
  sp.aberta_por AS aberto_por_id,
  sp.fechada_por AS fechado_por_id
FROM sessoes_producao sp
JOIN sessoes_producao_skus spsku ON spsku.sessao_id = sp.id
JOIN fichas_tecnicas ft ON ft.id = spsku.ficha_tecnica_id
JOIN sessoes_producao_locais spl ON spl.sessao_id = sp.id
JOIN insumos i ON i.id = spl.insumo_id
JOIN lotes l ON l.id = spl.lote_id
JOIN locais loc ON loc.id = spl.local_id
WHERE sp.status = 'fechada'
ORDER BY sp.data_producao DESC, ft.nome, i.nome;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Garante que cada empresa só enxerga seus próprios dados
-- ============================================================

ALTER TABLE empresas                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias_insumo        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fornecedores             ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos_embalagem_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE insumos_armazenamento_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE locais                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas_versoes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas_itens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes_unidades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimentacoes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimentacoes_itens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reembalagens             ENABLE ROW LEVEL SECURITY;
ALTER TABLE locais_estado_atual      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes_producao         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes_producao_skus    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes_producao_locais  ENABLE ROW LEVEL SECURITY;
ALTER TABLE perdas_insumo            ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes_sistema    ENABLE ROW LEVEL SECURITY;

-- Política base: usuário só acessa dados da sua empresa
CREATE OR REPLACE FUNCTION get_empresa_id_do_usuario()
RETURNS UUID AS $$
  SELECT empresa_id FROM usuarios WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER;

-- Política para tabelas com empresa_id direto
CREATE POLICY "acesso_por_empresa" ON lotes
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON insumos
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON fornecedores
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON locais
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON sessoes_producao
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON movimentacoes
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON perdas_insumo
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON fichas_tecnicas
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON usuarios
  USING (empresa_id = get_empresa_id_do_usuario());

-- ============================================================
-- FUNÇÃO: calcular validade_pos_abertura
-- Usada no momento do recebimento
-- ============================================================
CREATE OR REPLACE FUNCTION calcular_validade_pos_abertura(
  p_insumo_id UUID,
  p_validade_original DATE,
  p_data_recebimento DATE DEFAULT CURRENT_DATE
)
RETURNS DATE AS $$
DECLARE
  v_shelf_life INTEGER;
  v_calculada DATE;
BEGIN
  SELECT shelf_life_dias_pos_abertura INTO v_shelf_life
  FROM insumos WHERE id = p_insumo_id;

  IF v_shelf_life IS NULL THEN
    RETURN p_validade_original;
  END IF;

  v_calculada := p_data_recebimento + (v_shelf_life || ' days')::INTERVAL;
  RETURN LEAST(p_validade_original, v_calculada);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNÇÃO: validar transferência (regra: balde não mistura lotes)
-- ============================================================
CREATE OR REPLACE FUNCTION validar_transferencia_para_local(
  p_local_id UUID,
  p_lote_id UUID,
  p_quantidade DECIMAL
)
RETURNS JSONB AS $$
DECLARE
  v_estado locais_estado_atual%ROWTYPE;
  v_local locais%ROWTYPE;
BEGIN
  SELECT * INTO v_local FROM locais WHERE id = p_local_id;
  SELECT * INTO v_estado FROM locais_estado_atual WHERE local_id = p_local_id;

  -- Local não existe
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Local não encontrado.');
  END IF;

  -- Só locais EP recebem transferências
  IF v_local.tipo = 'estoque_central' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Não é possível transferir para o Estoque Central via este fluxo.');
  END IF;

  -- Se o local tem quantidade > 0 com lote diferente, rejeita
  IF v_estado.quantidade > 0 AND v_estado.lote_id IS NOT NULL AND v_estado.lote_id != p_lote_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'erro', 'REGRA DE OURO VIOLADA: este recipiente já contém outro lote ativo. Zere o recipiente antes de abastecer com novo lote.',
      'lote_atual', v_estado.lote_id,
      'quantidade_atual', v_estado.quantidade
    );
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGER: atualiza updated_at automaticamente
-- ============================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON empresas
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON insumos
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lotes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON locais
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON fichas_tecnicas
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sessoes_producao
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON configuracoes_sistema
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- DADOS INICIAIS: Categorias padrão (inseridos via seed)
-- ============================================================
-- (Executar após inserir a empresa)
-- INSERT INTO categorias_insumo (empresa_id, nome, cor_hex, descricao) VALUES
--   (:empresa_id, 'BALDES',       '#3498DB', 'Ingredientes secos armazenados em baldes no EP'),
--   (:empresa_id, 'LIQUIDOS',     '#E67E22', 'Ingredientes líquidos e semilíquidos'),
--   (:empresa_id, 'COBERTURAS',   '#8E44AD', 'Coberturas, ganaches e recheios'),
--   (:empresa_id, 'CONSERVANTES', '#27AE60', 'Conservantes e aditivos em pequenas quantidades');

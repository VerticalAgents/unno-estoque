-- Migration 017: Produtos acabados, lotes de produto e expedição
-- Cria o ciclo completo: cadastro produto → lote pós-produção → expedição

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE status_lote_produto_enum AS ENUM ('ativo', 'esgotado', 'vencido', 'descartado');
CREATE TYPE status_expedicao_enum AS ENUM ('preparando', 'expedida', 'cancelada');

-- ============================================================
-- TABELAS
-- ============================================================

-- Cadastro de produto acabado
CREATE TABLE produtos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  ficha_tecnica_id UUID REFERENCES fichas_tecnicas(id),
  codigo          TEXT NOT NULL,
  nome            TEXT NOT NULL,
  descricao       TEXT,
  peso_unitario_g DECIMAL(10,2),
  validade_dias   INTEGER,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(empresa_id, codigo)
);

COMMENT ON TABLE produtos IS
  'Produto acabado vinculado a uma ficha técnica. '
  'peso_unitario_g: peso por unidade (ex: 65g por brownie). '
  'validade_dias: prazo de validade a partir da data de produção.';

-- Hierarquia de embalagem (N níveis genéricos)
CREATE TABLE produtos_embalagens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  produto_id      UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nivel           INTEGER NOT NULL,
  nome            TEXT NOT NULL,
  quantidade      INTEGER NOT NULL,
  peso_embalagem_g DECIMAL(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(produto_id, nivel)
);

COMMENT ON TABLE produtos_embalagens IS
  'Hierarquia de embalagem do produto. '
  'nivel 1 = primeira embalagem acima da unidade (ex: display com 12 un). '
  'nivel 2 = segunda embalagem (ex: caixa embarque com 16 displays). '
  'quantidade = quantas unidades do nível anterior cabem neste nível.';

-- Lotes de produto acabado (análogo a lotes de insumo)
CREATE TABLE lotes_produto (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id            UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo                TEXT NOT NULL,
  produto_id            UUID NOT NULL REFERENCES produtos(id),
  sessao_id             UUID NOT NULL REFERENCES sessoes_producao(id),
  data_producao         DATE NOT NULL,
  validade              DATE NOT NULL,
  quantidade_produzida  INTEGER NOT NULL,
  quantidade_disponivel INTEGER NOT NULL,
  status                status_lote_produto_enum NOT NULL DEFAULT 'ativo',
  qr_code               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(empresa_id, codigo)
);

COMMENT ON TABLE lotes_produto IS
  'Cada sessão de produção fechada gera um lote de produto acabado '
  '(se o produto está cadastrado e vinculado à ficha). '
  'quantidade_disponivel é decrementada a cada expedição.';

-- Expedições
CREATE TABLE expedicoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  codigo          TEXT NOT NULL,
  data_expedicao  DATE NOT NULL,
  responsavel_id  UUID NOT NULL REFERENCES usuarios(id),
  destinatario    TEXT,
  observacoes     TEXT,
  status          status_expedicao_enum NOT NULL DEFAULT 'preparando',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(empresa_id, codigo)
);

-- Itens de expedição
CREATE TABLE expedicoes_itens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expedicao_id    UUID NOT NULL REFERENCES expedicoes(id) ON DELETE CASCADE,
  lote_produto_id UUID NOT NULL REFERENCES lotes_produto(id),
  produto_id      UUID NOT NULL REFERENCES produtos(id),
  quantidade      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES
-- ============================================================

CREATE INDEX idx_produtos_empresa ON produtos(empresa_id);
CREATE INDEX idx_lotes_produto_empresa ON lotes_produto(empresa_id, status);
CREATE INDEX idx_lotes_produto_produto ON lotes_produto(produto_id, status);
CREATE INDEX idx_expedicoes_empresa ON expedicoes(empresa_id, status);
CREATE INDEX idx_expedicoes_itens_expedicao ON expedicoes_itens(expedicao_id);

-- ============================================================
-- TRIGGERS
-- ============================================================

CREATE TRIGGER set_updated_at BEFORE UPDATE ON produtos
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lotes_produto
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON expedicoes
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE produtos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_embalagens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lotes_produto         ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedicoes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE expedicoes_itens      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "acesso_por_empresa" ON produtos
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON produtos_embalagens
  USING (
    produto_id IN (
      SELECT id FROM produtos WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

CREATE POLICY "acesso_por_empresa" ON lotes_produto
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON expedicoes
  USING (empresa_id = get_empresa_id_do_usuario());

CREATE POLICY "acesso_por_empresa" ON expedicoes_itens
  USING (
    expedicao_id IN (
      SELECT id FROM expedicoes WHERE empresa_id = get_empresa_id_do_usuario()
    )
  );

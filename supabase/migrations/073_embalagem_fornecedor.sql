-- ============================================================
-- Migration 073 — A embalagem do fornecedor deixa de ser cadastro
--
-- Havia 14 "recipientes" cadastrados à mão que não eram recipientes: 9 baldes
-- de Doce de Leite, 4 garrafas de Baunilha, 1 balde de Glucose. A capacidade de
-- cada um era exatamente o tamanho da embalagem — porque cada um ERA uma
-- embalagem, não um bem durável. Chegava mercadoria, alguém cadastrava; acabava,
-- alguém excluía. O cadastro nunca fechava, porque era um espelho manual do
-- estoque.
--
-- E a embalagem já vem com a etiqueta do lote colada desde o recebimento. O
-- cadastro criava uma SEGUNDA identidade para a mesma coisa física, que depois
-- alguém tinha que casar na hora de bipar.
--
-- Agora o ponto de consumo nasce da transferência e morre quando esvazia:
--   - `locais.origem_lote_id` diz de qual lote aquele ponto veio
--   - `locais.efemero` diz que ele não sobrevive ao conteúdo
--   - o QR é derivado do código do lote, então a etiqueta colada já serve
--
-- O modo de armazenamento sai de três booleanos combinados e vira um campo
-- legível (`modo_ep`), porque quem lê o código precisa saber o que o insumo faz
-- sem reconstituir a regra a partir das flags.
-- ============================================================

-- ── 1. O local pode ser a própria embalagem de um lote ──────

ALTER TABLE locais
  ADD COLUMN IF NOT EXISTS origem_lote_id UUID REFERENCES lotes(id),
  ADD COLUMN IF NOT EXISTS efemero BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN locais.origem_lote_id IS
  'Quando o ponto de consumo É a embalagem de um lote, aponta para ele. '
  'Permite resolver a etiqueta de lote colada no balde como se fosse a '
  'etiqueta do recipiente.';

COMMENT ON COLUMN locais.efemero IS
  'Nasce na transferência e é desativado quando esvazia. Não é um bem durável '
  'da cozinha — é a embalagem do fornecedor, que vai fora no fim.';

CREATE INDEX IF NOT EXISTS idx_locais_origem_lote ON locais(origem_lote_id)
  WHERE origem_lote_id IS NOT NULL;

-- ── 2. O modo de armazenamento vira campo, não dedução ──────

DO $$ BEGIN
  CREATE TYPE modo_ep_enum AS ENUM (
    'recipiente',            -- o caso comum: pote da cozinha, cadastrado uma vez
    'embalagem_fornecedor',  -- o pacote é o ponto de consumo, e é descartado no fim
    'porcionado',            -- o pacote é esvaziado em porções que vão para uma caixa
    'escolher'               -- o operador decide entre os dois acima, a cada pacote
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE insumos_armazenamento_config
  ADD COLUMN IF NOT EXISTS modo_ep modo_ep_enum NOT NULL DEFAULT 'recipiente';

-- Backfill a partir do que já estava gravado. A ordem importa: destino múltiplo
-- ganha de tudo, porque é o caso em que o insumo faz as duas coisas (o Doce de
-- Leite, único assim aqui).
UPDATE insumos_armazenamento_config
   SET modo_ep = CASE
     WHEN destino_multiplo THEN 'escolher'::modo_ep_enum
     WHEN tipo_armazenamento IN ('balde_fornecedor', 'garrafa_fornecedor')
       THEN 'embalagem_fornecedor'::modo_ep_enum
     WHEN passa_reembalagem THEN 'porcionado'::modo_ep_enum
     ELSE 'recipiente'::modo_ep_enum
   END;

-- O cadastro mente em alguns casos, e o uso real é a fonte mais confiável.
-- Açúcar Invertido, Glicerina e Extrato de Alecrim estavam gravados como
-- embalagem do fornecedor, mas têm 6, 6 e 2 recipientes PRÓPRIOS cadastrados e
-- em uso — o operador transfere para eles todo dia. Quem tem recipiente próprio
-- é `recipiente`, senão a transferência desses passaria a pular o bipe do
-- destino e mudaria a rotina de quem trabalha.
UPDATE insumos_armazenamento_config c
   SET modo_ep = 'recipiente'
 WHERE c.modo_ep = 'embalagem_fornecedor'
   AND EXISTS (
     SELECT 1 FROM locais l
      WHERE l.insumo_id = c.insumo_id
        AND l.tipo = 'estoque_produtivo'
        AND l.ativo AND NOT l.efemero
   );

COMMENT ON COLUMN insumos_armazenamento_config.modo_ep IS
  'Como o insumo ocupa o estoque produtivo. Substitui a leitura combinada de '
  'tipo_armazenamento + passa_reembalagem + destino_multiplo, que descrevia o '
  'mesmo fato de forma implícita.';

-- ── 3. Mover o pacote inteiro para a produção ───────────────

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
  -- Valida tudo antes de escrever: devolver erro no meio não desfaz o que já
  -- foi gravado, e aqui grava-se em duas tabelas.
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

  SELECT c.modo_ep, c.tipo_armazenamento::TEXT
    INTO v_modo, v_subtipo
    FROM insumos_armazenamento_config c
   WHERE c.insumo_id = v_lote.insumo_id;

  IF v_modo IS NULL OR v_modo NOT IN ('embalagem_fornecedor', 'escolher') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s não é armazenado na embalagem do fornecedor. '
             || 'Escaneie o recipiente de destino.', v_insumo.nome));
  END IF;

  -- Já movido antes: devolve o mesmo local em vez de criar outro. Bipar duas
  -- vezes é comum, e o segundo bipe não pode duplicar o ponto de consumo.
  SELECT id INTO v_local_id
    FROM locais
   WHERE origem_lote_id = p_lote_id AND ativo
   LIMIT 1;

  IF v_local_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'local_id', v_local_id, 'ja_existia', true);
  END IF;

  -- O subtipo do cadastro pode não existir em locais (ex.: 'unidade'); nesse
  -- caso cai no balde do fornecedor, que é o que a embalagem é na prática.
  IF v_subtipo IS NULL OR v_subtipo NOT IN (
    'prateleira','balde','balde_fornecedor','caixa_plastica',
    'garrafa','garrafa_fornecedor','saco_confeitar','lata'
  ) THEN
    v_subtipo := 'balde_fornecedor';
  END IF;

  -- `nome` e `qr_code_fixo` são únicos; o código do lote garante os dois.
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

  -- Transferência recusada: desfaz o local recém-criado, senão fica um ponto de
  -- consumo vazio e órfão para alguém limpar depois.
  IF NOT (v_resultado->>'ok')::BOOLEAN THEN
    DELETE FROM locais WHERE id = v_local_id;
    RETURN v_resultado;
  END IF;

  RETURN v_resultado
    || jsonb_build_object('local_id', v_local_id, 'local_nome', v_nome,
                          'quantidade', v_lote.quantidade_disponivel);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION mover_embalagem_fornecedor IS
  'Move a embalagem do fornecedor inteira para o EP, criando o ponto de consumo '
  'a partir do próprio lote. Substitui o cadastro manual de um recipiente por '
  'embalagem recebida.';

-- ── 4. Esvaziou, some ───────────────────────────────────────

CREATE OR REPLACE FUNCTION esgotar_recipiente(
  p_local_id       UUID,
  p_responsavel_id UUID,
  p_empresa_id     UUID,
  p_observacoes    TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_mov_codigo TEXT;
  v_mov_id     UUID;
  v_linha      RECORD;
  v_total      DECIMAL := 0;
  v_lotes      INTEGER := 0;
  v_efemero    BOOLEAN := false;
BEGIN
  SELECT efemero INTO v_efemero
    FROM locais WHERE id = p_local_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  SELECT COALESCE(SUM(quantidade), 0), COUNT(*) INTO v_total, v_lotes
    FROM locais_lotes WHERE local_id = p_local_id AND quantidade > 0;

  IF v_lotes = 0 THEN
    -- Mesmo vazio, embalagem do fornecedor sai de cena: ela não volta a ser
    -- usada, e deixá-la ativa suja a lista de recipientes da cozinha.
    IF v_efemero THEN
      UPDATE locais SET ativo = false, updated_at = now() WHERE id = p_local_id;
    END IF;
    RETURN jsonb_build_object('ok', true, 'ja_estava_vazio', true, 'sobra_baixada', 0,
                              'recipiente_encerrado', v_efemero);
  END IF;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'ajuste_inventario',
          p_responsavel_id,
          COALESCE(p_observacoes, 'Recipiente marcado como esgotado'))
  RETURNING id INTO v_mov_id;

  FOR v_linha IN
    SELECT ll.lote_id, ll.quantidade, ll.unidade
      FROM locais_lotes ll
     WHERE ll.local_id = p_local_id AND ll.quantidade > 0
  LOOP
    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
    VALUES (v_mov_id, v_linha.lote_id, p_local_id, v_linha.quantidade, v_linha.unidade);
  END LOOP;

  DELETE FROM locais_lotes WHERE local_id = p_local_id;

  -- Desativa, não exclui: movimentacoes_itens aponta para esta linha, e o
  -- histórico da produção precisa continuar legível.
  IF v_efemero THEN
    UPDATE locais SET ativo = false, updated_at = now() WHERE id = p_local_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sobra_baixada', v_total,
    'lotes_encerrados', v_lotes,
    'recipiente_encerrado', v_efemero,
    'movimentacao', v_mov_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 5. Os 14 cadastrados à mão saem de cena ─────────────────
-- Estão todos vazios (o banco tem uma única linha em locais_lotes, do Pote G de
-- farinha). Desativar e não excluir: histórico aponta para eles.

UPDATE locais l
   SET ativo = false, updated_at = now(),
       observacoes = COALESCE(l.observacoes || ' · ', '')
                     || 'Desativado na migration 073: a embalagem do fornecedor '
                     || 'passou a nascer da transferência.'
 WHERE l.tipo = 'estoque_produtivo'
   AND l.subtipo IN ('balde_fornecedor', 'garrafa_fornecedor')
   AND l.ativo
   AND NOT EXISTS (
     SELECT 1 FROM locais_lotes ll WHERE ll.local_id = l.id AND ll.quantidade > 0
   );

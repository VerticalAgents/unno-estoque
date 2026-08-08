-- ============================================================
-- Migration 074 — O saco de confeitar deixa de ser recipiente
--
-- Havia 15 "recipientes" cadastrados para a Nutella: um por saco de confeitar,
-- cada um com QR e etiqueta próprios. Saco de confeitar é descartável — enche,
-- usa, joga fora. Cadastrar um bem durável para cada descartável é o mesmo
-- defeito da migration 073, em outra roupa.
--
-- O que é durável é a CAIXA onde os sacos cheios ficam. Ela é uma por insumo,
-- física, e é ela que leva a etiqueta. Quantos sacos há dentro é conta
-- (conteúdo ÷ porção), não cadastro.
--
-- Três consertos vêm junto:
--
-- 1. As porções estavam erradas. A Nutella dizia 625 g, mas os 15 sacos
--    cadastrados eram de 750 g — e 750 é que fecha com o balde de 3 kg (4 sacos
--    exatos; com 625 dariam 4,8). O Doce de Leite dizia 600 g e são 200 g.
--    Confirmado com o usuário em 08/08/2026.
--
-- 2. `realizar_reembalagem` gravava em `lotes_unidades`, tabela com ZERO linhas
--    e ZERO leitores em toda a interface. O porcionamento sumia: nem a produção
--    nem a contagem enxergavam o que ela criava. Agora ela deposita na caixa,
--    que é o mesmo caminho de todo o resto do estoque produtivo.
--
-- 3. `planejar_recipientes` contava LINHAS de `locais`. Com os 15 sacos virando
--    1 caixa, ele passaria a dizer "faltam 14 recipientes" de Nutella. Para
--    insumo porcionado ele passa a contar PORÇÕES — que é o que o operador
--    conta na bancada.
-- ============================================================

-- ── 1. As porções certas ────────────────────────────────────

UPDATE insumos_armazenamento_config c
   SET reembalagem_tamanho_porcao = 750, reembalagem_unidade = 'g'
  FROM insumos i
 WHERE i.id = c.insumo_id AND i.codigo = 'INS027';

UPDATE insumos_armazenamento_config c
   SET reembalagem_tamanho_porcao = 200, reembalagem_unidade = 'g'
  FROM insumos i
 WHERE i.id = c.insumo_id AND i.codigo = 'INS014';

-- ── 2. Uma caixa por insumo porcionado ──────────────────────
-- A capacidade é o que sai de UM pacote: o balde de Nutella (3 kg) vira 4 sacos
-- de 750 g; o de Doce de Leite (4,8 kg) vira 24 de 200 g. Se a caixa física
-- comportar mais de um balde, é só editar a capacidade na tela.

INSERT INTO locais (
  empresa_id, nome, tipo, subtipo, insumo_id,
  capacidade_max, unidade_capacidade, qr_code_fixo, ativo, observacoes
)
SELECT i.empresa_id,
       'Caixa de sacos · ' || i.nome,
       'estoque_produtivo',
       'saco_confeitar',
       i.id,
       v.capacidade,
       i.unidade_medida,
       'QR-EP-CAIXA-' || i.codigo,
       true,
       'Caixa onde ficam os sacos de confeitar cheios. O saco é descartável e '
       || 'não se cadastra; quantos há dentro é o conteúdo dividido pela porção.'
  FROM insumos i
  JOIN (VALUES ('INS027', 3.000), ('INS014', 4.800)) AS v(codigo, capacidade)
    ON v.codigo = i.codigo
 WHERE NOT EXISTS (
   SELECT 1 FROM locais l
    WHERE l.insumo_id = i.id AND l.qr_code_fixo = 'QR-EP-CAIXA-' || i.codigo
 );

-- Os 15 sacos avulsos saem de cena. Desativar e não excluir: histórico aponta.
UPDATE locais l
   SET ativo = false, updated_at = now(),
       observacoes = COALESCE(l.observacoes || ' · ', '')
                     || 'Desativado na migration 074: o saco de confeitar é '
                     || 'descartável e deixou de ser cadastrado um a um.'
 WHERE l.tipo = 'estoque_produtivo'
   AND l.subtipo = 'saco_confeitar'
   AND l.ativo
   AND l.qr_code_fixo NOT LIKE 'QR-EP-CAIXA-%'
   AND NOT EXISTS (
     SELECT 1 FROM locais_lotes ll WHERE ll.local_id = l.id AND ll.quantidade > 0
   );

-- ── 3. A reembalagem passa a depositar na caixa ─────────────

CREATE OR REPLACE FUNCTION realizar_reembalagem(
  p_lote_id          UUID,
  p_tipo_resultado   TEXT,
  p_tamanho_porcao   DECIMAL,    -- em gramas/ml; NULL = porciona o pacote inteiro
  p_qtd_unidades     INTEGER,
  p_quantidade_total DECIMAL,    -- total consumido do lote, em gramas/ml
  p_responsavel_id   UUID,
  p_empresa_id       UUID,
  p_local_destino_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_lote        lotes%ROWTYPE;
  v_insumo      insumos%ROWTYPE;
  v_remb_codigo TEXT;
  v_remb_id     UUID;
  v_mov_codigo  TEXT;
  v_mov_id      UUID;
  v_sobra       DECIMAL;
  v_peso_total  DECIMAL;
  v_validade_ep DATE;
BEGIN
  -- Valida tudo antes de escrever: são cinco tabelas adiante.
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF p_local_destino_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe a caixa que vai receber as porções.');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM locais
     WHERE id = p_local_destino_id AND empresa_id = p_empresa_id AND ativo
  ) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Caixa de destino não encontrada.');
  END IF;

  IF COALESCE(p_qtd_unidades, 0) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe quantas porções foram feitas.');
  END IF;

  -- O lote é medido em kg/L e a porção em g/ml: converter no limite, uma vez.
  v_peso_total := CASE
    WHEN v_lote.unidade IN ('kg', 'L') THEN p_quantidade_total / 1000
    ELSE p_quantidade_total
  END;

  IF v_lote.quantidade_disponivel < v_peso_total THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Quantidade insuficiente. Disponível: %s %s',
             v_lote.quantidade_disponivel, v_lote.unidade));
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  v_sobra := CASE
    WHEN p_tamanho_porcao IS NOT NULL
    THEN GREATEST(p_quantidade_total - (p_tamanho_porcao * p_qtd_unidades), 0)
    ELSE 0
  END;

  v_validade_ep := CASE
    WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
    THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_lote.validade_original)
    ELSE v_lote.validade_original
  END;

  v_remb_codigo := gerar_proximo_codigo(p_empresa_id, 'reembalagens', 'REMB');
  INSERT INTO reembalagens (
    empresa_id, codigo, lote_id, insumo_id, responsavel_id,
    quantidade_utilizada, unidade_utilizada,
    tipo_resultado, tamanho_porcao, unidade_porcao,
    quantidade_unidades_geradas, peso_total_gerado, sobra, local_destino_id
  ) VALUES (
    p_empresa_id, v_remb_codigo, p_lote_id, v_lote.insumo_id, p_responsavel_id,
    p_quantidade_total, 'g',
    p_tipo_resultado,
    COALESCE(p_tamanho_porcao, p_quantidade_total), 'g',
    p_qtd_unidades,
    COALESCE(p_tamanho_porcao * p_qtd_unidades, p_quantidade_total),
    v_sobra,
    p_local_destino_id
  ) RETURNING id INTO v_remb_id;

  -- Antes isto virava `lotes_unidades`, tabela que nenhuma tela lê — o
  -- porcionamento sumia do sistema. Agora entra na caixa pelo mesmo caminho de
  -- qualquer transferência, e produção e contagem passam a enxergar.
  PERFORM abastecer_recipiente(
    p_local_destino_id, p_lote_id, v_peso_total, v_lote.unidade, v_validade_ep
  );

  UPDATE lotes
     SET quantidade_disponivel = quantidade_disponivel - v_peso_total,
         status = CASE
           WHEN quantidade_disponivel - v_peso_total <= 0 THEN 'esgotado'::status_lote_enum
           ELSE status
         END
   WHERE id = p_lote_id;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'reembalagem', p_responsavel_id,
          format('%s porção(ões) de %s', p_qtd_unidades,
                 COALESCE(p_tamanho_porcao::TEXT || 'g', 'pacote inteiro')))
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens
    (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, p_local_destino_id, v_peso_total, v_lote.unidade);

  RETURN jsonb_build_object(
    'ok', true,
    'reembalagem_id', v_remb_id,
    'codigo', v_remb_codigo,
    'porcoes', p_qtd_unidades,
    'depositado', v_peso_total,
    'unidade', v_lote.unidade,
    'sobra', v_sobra,
    'validade_ep', v_validade_ep,
    'lote_esgotado', (v_lote.quantidade_disponivel - v_peso_total) <= 0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION realizar_reembalagem IS
  'Porciona um pacote em N porções e deposita o total na caixa de destino. '
  'Antes gerava lotes_unidades, que nenhuma tela lê — o porcionamento não '
  'aparecia em produção nem em contagem.';

-- ── 4. O planejador conta porções, não caixas ───────────────

CREATE OR REPLACE FUNCTION planejar_recipientes(
  p_empresa_id UUID,
  p_plano      JSONB
)
RETURNS TABLE (
  insumo_id           UUID,
  codigo              TEXT,
  nome                TEXT,
  unidade             TEXT,
  recipiente_modelo   TEXT,
  capacidade          DECIMAL,
  demanda             DECIMAL,
  demanda_com_folga   DECIMAL,
  recipientes_atuais  INTEGER,
  recipientes_necessarios INTEGER,
  faltam              INTEGER
) AS $$
DECLARE
  v_folga DECIMAL;
BEGIN
  SELECT COALESCE(folga_recipientes_pct, 0) / 100.0 INTO v_folga
    FROM configuracoes_sistema WHERE empresa_id = p_empresa_id;
  v_folga := COALESCE(v_folga, 0);

  RETURN QUERY
  WITH plano AS (
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           COALESCE((e->>'formas')::DECIMAL, 0) AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::DECIMAL, 0) > 0
  ),
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * v.rendimento_fornada * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  -- Quantos recipientes existem, e quanto há dentro deles. O conteúdo só
  -- interessa ao insumo porcionado, onde a unidade que o operador conta é o
  -- SACO — e sacos não se cadastram, se contam pelo que há na caixa.
  recipientes AS (
    SELECT l.insumo_id AS ins_id,
           COUNT(*)::INTEGER AS n,
           COALESCE(SUM(ll.quantidade), 0) AS conteudo
      FROM locais l
      LEFT JOIN locais_lotes ll ON ll.local_id = l.id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.ativo
     GROUP BY l.insumo_id
  ),
  -- A porção convertida para a unidade do insumo: ela é cadastrada em g/ml e o
  -- insumo pode ser medido em kg/L.
  porcao AS (
    SELECT c.insumo_id AS ins_id,
           CASE
             WHEN c.modo_ep <> 'porcionado' THEN NULL
             WHEN c.reembalagem_tamanho_porcao IS NULL THEN NULL
             WHEN i.unidade_medida IN ('kg', 'L') THEN c.reembalagem_tamanho_porcao / 1000
             ELSE c.reembalagem_tamanho_porcao
           END AS tamanho
      FROM insumos_armazenamento_config c
      JOIN insumos i ON i.id = c.insumo_id
  ),
  base AS (
    SELECT i.id, i.codigo, i.nome, i.unidade_medida,
           i.recipiente_subtipo, i.recipiente_capacidade_max,
           d.qtd, COALESCE(r.n, 0) AS n, COALESCE(r.conteudo, 0) AS conteudo,
           po.tamanho AS porcao
      FROM demanda_insumo d
      JOIN insumos i ON i.id = d.ins_id
      LEFT JOIN recipientes r ON r.ins_id = d.ins_id
      LEFT JOIN porcao po ON po.ins_id = d.ins_id
     WHERE i.empresa_id = p_empresa_id
  )
  SELECT
    b.id,
    b.codigo::TEXT,
    b.nome::TEXT,
    b.unidade_medida::TEXT,
    CASE WHEN b.porcao IS NOT NULL THEN 'saco_confeitar'
         ELSE b.recipiente_subtipo::TEXT END,
    COALESCE(b.porcao, b.recipiente_capacidade_max),
    ROUND(b.qtd, 4),
    ROUND(b.qtd * (1 + v_folga), 4),
    CASE WHEN b.porcao IS NOT NULL
         THEN FLOOR(b.conteudo / b.porcao)::INTEGER
         ELSE b.n END,
    CASE WHEN COALESCE(b.porcao, b.recipiente_capacidade_max, 0) > 0
         THEN CEIL(b.qtd * (1 + v_folga) / COALESCE(b.porcao, b.recipiente_capacidade_max))::INTEGER
         ELSE NULL END,
    CASE WHEN COALESCE(b.porcao, b.recipiente_capacidade_max, 0) > 0
         THEN GREATEST(
                CEIL(b.qtd * (1 + v_folga) / COALESCE(b.porcao, b.recipiente_capacidade_max))::INTEGER
                - CASE WHEN b.porcao IS NOT NULL
                       THEN FLOOR(b.conteudo / b.porcao)::INTEGER
                       ELSE b.n END, 0)
         ELSE NULL END
  FROM base b
  ORDER BY b.qtd DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION planejar_recipientes IS
  'Planejador de recipientes por sessão. Para insumo porcionado a unidade é a '
  'PORÇÃO (o saco), contada pelo conteúdo da caixa dividido pela porção — sacos '
  'são descartáveis e não se cadastram. Para o resto, é o recipiente.';

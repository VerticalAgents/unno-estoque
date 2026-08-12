-- ============================================================
-- Migration 090 — A pós-produção pode ser registrada em pedaços
--
-- A 089 exigia que as validades somassem EXATAMENTE as unidades boas. Quem
-- desenforma em dois dias não tem como fechar essa conta no primeiro dia: ou
-- inventa o número do dia seguinte, ou não registra nada. E não registrar nada
-- significa prateleira cheia e estoque digital vazio — justamente o que a 089
-- foi feita para evitar.
--
-- Agora a soma pode ser MENOR. O que foi desenformado entra no estoque na hora,
-- e o resto entra quando sair da forma. A sessão só deixa a fila da pós quando
-- todas as unidades boas viraram lote.
--
-- O registro continua sendo um por sessão, sempre o retrato completo do que se
-- sabe até agora: a tela carrega o que já foi gravado, soma o que saiu hoje e
-- manda tudo de novo. Por isso a função continua trocando descartes e lotes
-- pelo que recebe, em vez de somar às cegas — registrar duas vezes o mesmo dia
-- não pode dobrar o estoque.
--
-- A conta de quanto falta é: (unidades boas das fichas que têm produto) menos
-- (o que já virou lote). Descarte lançado depois diminui o que falta; unidade
-- desenformada diminui também. As duas coisas convergem para zero.
-- ============================================================

CREATE OR REPLACE FUNCTION registrar_pos_producao(
  p_empresa_id     UUID,
  p_sessao_id      UUID,
  p_responsavel_id UUID,
  p_descartes      JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_data           DATE DEFAULT NULL,
  p_partes         JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_data_producao DATE;
  v_data_pos      DATE := COALESCE(p_data, CURRENT_DATE);
  v_pos_id        UUID;
  v_item          JSONB;
  v_qtd           INTEGER;
  v_sku           RECORD;
  v_parte         RECORD;
  v_n             INTEGER := 0;
  v_boas          INTEGER;
  v_soma          INTEGER;
  v_sem_validade  INTEGER;
  v_lote_id       UUID;
  v_lote          JSONB;
  v_novo_disp     INTEGER;
  v_keep_prod     UUID[] := '{}';
  v_keep_val      DATE[] := '{}';
  v_mantidos      UUID[] := '{}';
  v_avisos        TEXT[] := '{}';
  v_lotes_presos  TEXT;
  v_lotes_novos   INTEGER := 0;
  v_falta         INTEGER := 0;
BEGIN
  SELECT data_producao INTO v_data_producao
    FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'fechada';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'A sessão precisa estar fechada para registrar a pós-produção.');
  END IF;

  -- ════════════════════════════════════════════════════════
  -- FASE 1 — conferência. Nada é escrito aqui.
  -- ════════════════════════════════════════════════════════
  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id,
           COALESCE(ft.nome, 'ficha sem nome')            AS ficha_nome,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)             AS rendimento,
           pr.id                                          AS produto_id,
           pr.validade_dias
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
      LEFT JOIN fichas_tecnicas ft         ON ft.id = sk.ficha_tecnica_id
      LEFT JOIN LATERAL (
        SELECT p.id, p.validade_dias
          FROM produtos p
         WHERE p.ficha_tecnica_id = sk.ficha_tecnica_id
           AND p.empresa_id = p_empresa_id AND p.ativo = true
         LIMIT 1
      ) pr ON true
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    -- As boas saem por diferença, como sempre: ninguém conta unidade boa.
    SELECT GREATEST(
             v_sku.formas * v_sku.rendimento
             - COALESCE(SUM(COALESCE((e->>'quantidade')::INTEGER, 0)), 0), 0)
      INTO v_boas
      FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) e
     WHERE (e->>'sessao_sku_id')::UUID = v_sku.id;

    -- Ficha sem produto cadastrado não vira estoque. Avisa em vez de falhar
    -- calada, que foi o que aconteceu no dia 10.
    IF v_sku.produto_id IS NULL THEN
      IF v_boas > 0 THEN
        v_avisos := v_avisos || format(
          '%s não tem produto cadastrado: as %s unidades boas não entraram no estoque.',
          v_sku.ficha_nome, v_boas);
      END IF;
      CONTINUE;
    END IF;

    SELECT COUNT(*) FILTER (
             WHERE NULLIF(e->>'validade','') IS NULL
               AND NULLIF(e->>'data_desenforma','') IS NULL),
           COALESCE(SUM(COALESCE((e->>'quantidade')::INTEGER, 0)), 0)
      INTO v_sem_validade, v_soma
      FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
     WHERE (e->>'sessao_sku_id')::UUID = v_sku.id;

    IF v_sem_validade > 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        'Falta a data de desenforma de uma das partes de %s.', v_sku.ficha_nome));
    END IF;

    -- Menos que as boas é o registro parcial, e é permitido. Mais que as boas
    -- é engano: não se desenforma o que não saiu do forno.
    IF v_soma > v_boas THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s: as validades somam %s unidades e as boas são %s.',
        v_sku.ficha_nome, v_soma, v_boas));
    END IF;

    v_falta := v_falta + (v_boas - v_soma);

    -- Guarda (produto, validade) de tudo que vai existir depois desta chamada.
    FOR v_parte IN
      SELECT COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             ) AS validade
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
         AND COALESCE((e->>'quantidade')::INTEGER, 0) > 0
       GROUP BY 1
    LOOP
      v_keep_prod := v_keep_prod || v_sku.produto_id;
      v_keep_val  := v_keep_val  || v_parte.validade;
    END LOOP;
  END LOOP;

  -- Lote que vai deixar de existir e já teve saída não some em silêncio.
  SELECT string_agg(lp.codigo, ', ' ORDER BY lp.codigo)
    INTO v_lotes_presos
    FROM lotes_produto lp
   WHERE lp.sessao_id = p_sessao_id
     AND NOT EXISTS (
       SELECT 1 FROM unnest(v_keep_prod, v_keep_val) AS k(prod, val)
        WHERE k.prod = lp.produto_id AND k.val = lp.validade)
     AND (lp.quantidade_disponivel <> lp.quantidade_produzida
          OR EXISTS (SELECT 1 FROM expedicoes_itens ei
                      WHERE ei.lote_produto_id = lp.id));

  IF v_lotes_presos IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'O lote %s já teve saída e as validades informadas não o incluem. '
      'Mantenha a validade dele ou acerte a expedição primeiro.', v_lotes_presos));
  END IF;

  -- ════════════════════════════════════════════════════════
  -- FASE 2 — escrita.
  -- ════════════════════════════════════════════════════════
  INSERT INTO pos_producao (empresa_id, sessao_id, data, responsavel_id, observacoes)
  VALUES (p_empresa_id, p_sessao_id, v_data_pos, p_responsavel_id, p_observacoes)
  ON CONFLICT (sessao_id) DO UPDATE
     SET data = EXCLUDED.data,
         responsavel_id = EXCLUDED.responsavel_id,
         observacoes = EXCLUDED.observacoes,
         updated_at = NOW()
  RETURNING id INTO v_pos_id;

  DELETE FROM pos_producao_descartes WHERE pos_id = v_pos_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) LOOP
    v_qtd := COALESCE((v_item->>'quantidade')::INTEGER, 0);
    IF v_qtd > 0 THEN
      INSERT INTO pos_producao_descartes (pos_id, sessao_sku_id, motivo_id, quantidade)
      VALUES (v_pos_id, (v_item->>'sessao_sku_id')::UUID,
              (v_item->>'motivo_id')::UUID, v_qtd)
      ON CONFLICT (pos_id, sessao_sku_id, motivo_id)
      DO UPDATE SET quantidade = EXCLUDED.quantidade;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)             AS rendimento,
           pr.id                                          AS produto_id,
           pr.validade_dias
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
      LEFT JOIN LATERAL (
        SELECT p.id, p.validade_dias
          FROM produtos p
         WHERE p.ficha_tecnica_id = sk.ficha_tecnica_id
           AND p.empresa_id = p_empresa_id AND p.ativo = true
         LIMIT 1
      ) pr ON true
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    SELECT COALESCE(SUM(d.quantidade), 0) INTO v_qtd
      FROM pos_producao_descartes d
     WHERE d.pos_id = v_pos_id AND d.sessao_sku_id = v_sku.id;

    v_boas := GREATEST(v_sku.formas * v_sku.rendimento - v_qtd, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_perdida   = v_qtd,
           quantidade_produzida = v_boas
     WHERE id = v_sku.id;

    CONTINUE WHEN v_sku.produto_id IS NULL;

    -- Partes agrupadas pela validade: duas partes do mesmo dia são um lote só.
    FOR v_parte IN
      SELECT COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             )                                                   AS validade,
             MIN(NULLIF(e->>'data_desenforma','')::DATE)         AS desenforma,
             SUM(COALESCE((e->>'quantidade')::INTEGER, 0))::INTEGER AS quantidade
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
         AND COALESCE((e->>'quantidade')::INTEGER, 0) > 0
       GROUP BY 1
    LOOP
      SELECT id INTO v_lote_id
        FROM lotes_produto
       WHERE sessao_id = p_sessao_id
         AND produto_id = v_sku.produto_id
         AND validade = v_parte.validade;

      IF FOUND THEN
        -- Por diferença, para não apagar o que uma expedição já tirou daqui.
        SELECT GREATEST(quantidade_disponivel + (v_parte.quantidade - quantidade_produzida), 0)
          INTO v_novo_disp
          FROM lotes_produto WHERE id = v_lote_id;

        UPDATE lotes_produto
           SET quantidade_produzida  = v_parte.quantidade,
               quantidade_disponivel = v_novo_disp,
               data_desenforma       = COALESCE(v_parte.desenforma, data_desenforma),
               status = CASE
                 WHEN v_novo_disp <= 0        THEN 'esgotado'::status_lote_produto_enum
                 WHEN status = 'esgotado'     THEN 'ativo'::status_lote_produto_enum
                 ELSE status
               END
         WHERE id = v_lote_id;
      ELSE
        v_lote := registrar_lote_produto(
          p_empresa_id, v_sku.produto_id, p_sessao_id,
          v_data_producao, v_parte.quantidade, p_responsavel_id,
          v_parte.validade, COALESCE(v_parte.desenforma, v_data_pos)
        );
        v_lote_id := (v_lote->>'lote_id')::UUID;
        v_lotes_novos := v_lotes_novos + 1;
      END IF;

      v_mantidos := v_mantidos || v_lote_id;
    END LOOP;
  END LOOP;

  -- O que sobrou está intocado — a fase 1 garantiu isso.
  DELETE FROM lotes_produto
   WHERE sessao_id = p_sessao_id
     AND NOT (id = ANY(v_mantidos));

  RETURN jsonb_build_object(
    'ok', true,
    'pos_id', v_pos_id,
    'descartes', v_n,
    'lotes', COALESCE(array_length(v_mantidos, 1), 0),
    'lotes_novos', v_lotes_novos,
    'falta', v_falta,
    'avisos', to_jsonb(v_avisos)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE, JSONB) IS
  'Registra a desenforma: os descartes por motivo, as unidades boas por '
  'diferença e os lotes de produto — um por validade. Aceita registro parcial: '
  'o que já saiu da forma entra no estoque agora, o resto entra depois.';

-- ── A fila da pós conta o que ainda falta desenformar ───────
-- Antes: sai da fila quando existe registro. Agora: sai quando todas as
-- unidades boas viraram lote. Duas colunas novas no fim — CREATE OR REPLACE
-- aceita acrescentar, e assim o security_invoker fica de pé.
CREATE OR REPLACE VIEW v_pos_producao_pendente AS
WITH linhas AS (
  SELECT s.id AS sessao_id, s.empresa_id, s.codigo, s.data_producao, s.data_fechamento,
         COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
         COALESCE(sk.formas_assadas, sk.multiplicador, 0)
           * COALESCE(v.rendimento_fornada, 0)            AS teoricas,
         COALESCE(ft.tipo, 'produto')                     AS tipo,
         (pr.id IS NOT NULL)                              AS tem_produto,
         COALESCE((SELECT SUM(d.quantidade)
                     FROM pos_producao_descartes d
                    WHERE d.sessao_sku_id = sk.id), 0)    AS descartadas
    FROM sessoes_producao s
    JOIN sessoes_producao_skus sk ON sk.sessao_id = s.id
    LEFT JOIN fichas_tecnicas_versoes v ON v.id = sk.ficha_versao_id
    LEFT JOIN fichas_tecnicas ft        ON ft.id = sk.ficha_tecnica_id
    LEFT JOIN LATERAL (
      SELECT p.id FROM produtos p
       WHERE p.ficha_tecnica_id = sk.ficha_tecnica_id
         AND p.empresa_id = s.empresa_id AND p.ativo = true
       LIMIT 1
    ) pr ON true
   WHERE s.status = 'fechada'::status_sessao_enum
),
sessoes AS (
  SELECT sessao_id, empresa_id, codigo, data_producao, data_fechamento,
         SUM(formas)::integer   AS formas,
         SUM(teoricas)::integer AS unidades_teoricas,
         -- Só o que pode virar estoque entra na conta do que falta.
         SUM(CASE WHEN tem_produto THEN GREATEST(teoricas - descartadas, 0) ELSE 0 END)::integer
                                AS a_desenformar,
         bool_or(tipo = 'insumo') AS tem_insumo
    FROM linhas
   GROUP BY sessao_id, empresa_id, codigo, data_producao, data_fechamento
)
SELECT se.sessao_id,
       se.empresa_id,
       se.codigo,
       se.data_producao,
       se.data_fechamento,
       (CURRENT_DATE - se.data_producao)                         AS dias_parado,
       se.formas,
       se.unidades_teoricas,
       reg.registradas::integer                                  AS unidades_registradas,
       GREATEST(se.a_desenformar - reg.registradas, 0)::integer  AS falta
  FROM sessoes se
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(lp.quantidade_produzida), 0) AS registradas
      FROM lotes_produto lp WHERE lp.sessao_id = se.sessao_id
  ) reg
 WHERE NOT se.tem_insumo
   AND (se.a_desenformar - reg.registradas > 0
        -- Sessão sem nada a desenformar (ficha sem produto cadastrado) ainda
        -- precisa aparecer para alguém registrar os descartes dela.
        OR NOT EXISTS (SELECT 1 FROM pos_producao pp WHERE pp.sessao_id = se.sessao_id));

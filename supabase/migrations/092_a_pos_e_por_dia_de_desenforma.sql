-- ============================================================
-- Migration 092 — A pós-produção é POR DIA DE DESENFORMA
--
-- A 090 deixou registrar em pedaços, mas dividiu a coisa errada: as validades
-- eram fatiadas por dia e os descartes continuavam num monte só, da sessão
-- inteira. Nas palavras do usuário: *"o descarte é global, somente a validade é
-- fracionável (...) se eu desenformar metade hoje, metade amanhã, tem as perdas
-- de hoje e as perdas de amanhã — não tem como aferir as perdas antes de
-- finalizar a pós"*.
--
-- Ele está certo, e é mais do que contabilidade: sem separar, o rendimento real
-- de cada dia não existe. Quebrar 40 num dia e 2 no outro fica igual a quebrar
-- 21 em cada, e some justamente o sinal que a pós-produção serve para dar.
--
-- Agora cada DESENFORMA é um registro: um dia, uma quantidade de formas, uma
-- validade e os descartes daquele dia. A sessão pode ter quantos forem
-- necessários, e continua havendo um `pos_producao` por sessão — ele passa a
-- ser o cabeçalho, e as partes é que carregam os números.
--
-- QUANTAS FORMAS, NÃO QUANTAS UNIDADES. O sistema inteiro fala em formas: o
-- planejador, o fechamento, o rendimento por fornada. Na bancada também se
-- desenforma forma a forma. Então cada parte diz quantas FORMAS foram abertas
-- naquele dia, e as unidades boas continuam saindo por diferença
-- (`formas × rendimento − descartes do dia`) — ninguém conta brownie bom, que
-- é o princípio da tela desde a 054.
--
-- O que falta desenformar deixa de ser uma conta de unidades e passa a ser o
-- que ele vê na prateleira: formas ainda fechadas.
-- ============================================================

-- ── A parte: um dia de desenforma ───────────────────────────
CREATE TABLE IF NOT EXISTS pos_producao_partes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pos_id          UUID NOT NULL REFERENCES pos_producao(id) ON DELETE CASCADE,
  sessao_sku_id   UUID NOT NULL REFERENCES sessoes_producao_skus(id) ON DELETE CASCADE,
  data_desenforma DATE NOT NULL,
  validade        DATE NOT NULL,
  formas          INTEGER NOT NULL CHECK (formas > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pos_id, sessao_sku_id, data_desenforma)
);

COMMENT ON TABLE pos_producao_partes IS
  'Cada dia em que se desenformou: quantas formas foram abertas, com que '
  'validade, e — pelos descartes que apontam para cá — o que quebrou naquele '
  'dia. As unidades boas saem por diferença.';

ALTER TABLE pos_producao_partes ENABLE ROW LEVEL SECURITY;

-- Mesma política dos descartes, que penduram no mesmo pai.
DROP POLICY IF EXISTS acesso_por_empresa ON pos_producao_partes;
CREATE POLICY acesso_por_empresa ON pos_producao_partes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM pos_producao p
             WHERE p.id = pos_producao_partes.pos_id
               AND p.empresa_id = get_empresa_id_do_usuario())
  );

-- ── O descarte passa a pertencer a um dia ───────────────────
-- `pos_id` fica: as ferramentas de Dev e o relatório de perdas leem por ele, e
-- ele é sempre o mesmo pai da parte. É redundância consciente, não descuido.
ALTER TABLE pos_producao_descartes
  ADD COLUMN IF NOT EXISTS parte_id UUID REFERENCES pos_producao_partes(id) ON DELETE CASCADE;

-- Os descartes que já existem viram o único dia de desenforma da pós deles,
-- com as formas e a validade que o lote gravado já diz.
INSERT INTO pos_producao_partes (pos_id, sessao_sku_id, data_desenforma, validade, formas)
SELECT DISTINCT ON (d.pos_id, d.sessao_sku_id)
       d.pos_id, d.sessao_sku_id,
       COALESCE(lp.data_desenforma, pp.data),
       COALESCE(lp.validade, pp.data + 365),
       COALESCE(sk.formas_assadas, sk.multiplicador, 1)
  FROM pos_producao_descartes d
  JOIN pos_producao pp        ON pp.id = d.pos_id
  JOIN sessoes_producao_skus sk ON sk.id = d.sessao_sku_id
  LEFT JOIN lotes_produto lp  ON lp.sessao_id = pp.sessao_id
 WHERE d.parte_id IS NULL
 ORDER BY d.pos_id, d.sessao_sku_id, lp.validade   -- DISTINCT ON precisa de ordem
ON CONFLICT (pos_id, sessao_sku_id, data_desenforma) DO NOTHING;

UPDATE pos_producao_descartes d
   SET parte_id = pt.id
  FROM pos_producao_partes pt
 WHERE d.parte_id IS NULL
   AND pt.pos_id = d.pos_id
   AND pt.sessao_sku_id = d.sessao_sku_id;

ALTER TABLE pos_producao_descartes ALTER COLUMN parte_id SET NOT NULL;

-- A chave era (pos, sku, motivo) — um descarte por motivo na sessão inteira.
-- Agora é um descarte por motivo EM CADA DIA.
ALTER TABLE pos_producao_descartes
  DROP CONSTRAINT IF EXISTS pos_producao_descartes_pos_id_sessao_sku_id_motivo_id_key;
ALTER TABLE pos_producao_descartes
  ADD CONSTRAINT pos_producao_descartes_parte_motivo_key UNIQUE (parte_id, motivo_id);

-- ── A RPC ───────────────────────────────────────────────────
-- Assinatura nova: os descartes agora vêm DENTRO de cada parte, e não mais
-- soltos. Cada item de p_partes:
--   { sessao_sku_id, data_desenforma, validade, formas,
--     descartes: [{ motivo_id, quantidade }] }
DROP FUNCTION IF EXISTS registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE, JSONB);

CREATE OR REPLACE FUNCTION registrar_pos_producao(
  p_empresa_id     UUID,
  p_sessao_id      UUID,
  p_responsavel_id UUID,
  p_partes         JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_data           DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_data_producao DATE;
  v_data_pos      DATE := COALESCE(p_data, CURRENT_DATE);
  v_pos_id        UUID;
  v_parte_id      UUID;
  v_sku           RECORD;
  v_parte         RECORD;
  v_lote_id       UUID;
  v_lote          JSONB;
  v_novo_disp     INTEGER;
  v_formas        INTEGER;
  v_descartadas   INTEGER;
  v_boas          INTEGER;
  v_lotes_novos   INTEGER := 0;
  v_keep_prod     UUID[] := '{}';
  v_keep_val      DATE[] := '{}';
  v_mantidos      UUID[] := '{}';
  v_avisos        TEXT[] := '{}';
  v_lotes_presos  TEXT;
  v_falta_formas  INTEGER := 0;
  v_total_boas    INTEGER := 0;
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
           COALESCE(ft.nome, 'ficha sem nome')              AS ficha_nome,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)               AS rendimento,
           pr.id                                            AS produto_id,
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
    -- Cada dia é conferido sozinho: as quebras de um dia não podem ser pagas
    -- com as formas do outro.
    FOR v_parte IN
      SELECT NULLIF(e->>'data_desenforma','')::DATE          AS desenforma,
             NULLIF(e->>'validade','')::DATE                 AS validade,
             COALESCE((e->>'formas')::INTEGER, 0)            AS formas,
             (SELECT COALESCE(SUM(COALESCE((d->>'quantidade')::INTEGER, 0)), 0)
                FROM jsonb_array_elements(COALESCE(e->'descartes', '[]'::JSONB)) d)
                                                             AS descartadas
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
    LOOP
      IF v_parte.desenforma IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'erro', format(
          'Falta a data de uma das desenformas de %s.', v_sku.ficha_nome));
      END IF;

      IF v_parte.formas <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'erro', format(
          'A desenforma de %s em %s está sem formas.',
          v_sku.ficha_nome, to_char(v_parte.desenforma, 'DD/MM')));
      END IF;

      IF v_parte.descartadas > v_parte.formas * v_sku.rendimento THEN
        RETURN jsonb_build_object('ok', false, 'erro', format(
          '%s em %s: %s descartes para %s unidades desenformadas.',
          v_sku.ficha_nome, to_char(v_parte.desenforma, 'DD/MM'),
          v_parte.descartadas, v_parte.formas * v_sku.rendimento));
      END IF;
    END LOOP;

    SELECT COALESCE(SUM(COALESCE((e->>'formas')::INTEGER, 0)), 0)
      INTO v_formas
      FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
     WHERE (e->>'sessao_sku_id')::UUID = v_sku.id;

    -- Menos formas do que foram ao forno é o registro parcial, e é permitido.
    IF v_formas > v_sku.formas THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s: %s formas desenformadas contra %s que foram ao forno.',
        v_sku.ficha_nome, v_formas, v_sku.formas));
    END IF;

    v_falta_formas := v_falta_formas + (v_sku.formas - v_formas);

    IF v_sku.produto_id IS NULL THEN
      IF v_formas > 0 THEN
        v_avisos := v_avisos || format(
          '%s não tem produto cadastrado: o que foi desenformado não entrou no estoque.',
          v_sku.ficha_nome);
      END IF;
      CONTINUE;
    END IF;

    -- Guarda (produto, validade) do que vai existir depois desta chamada.
    FOR v_parte IN
      SELECT COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             ) AS validade,
             SUM(COALESCE((e->>'formas')::INTEGER, 0)) * v_sku.rendimento
             - SUM((SELECT COALESCE(SUM(COALESCE((d->>'quantidade')::INTEGER, 0)), 0)
                      FROM jsonb_array_elements(COALESCE(e->'descartes', '[]'::JSONB)) d))
                AS boas
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
       GROUP BY 1
    LOOP
      IF v_parte.boas > 0 THEN
        v_keep_prod := v_keep_prod || v_sku.produto_id;
        v_keep_val  := v_keep_val  || v_parte.validade;
      END IF;
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

  -- O retrato chega inteiro a cada chamada: apaga e regrava. Os descartes vão
  -- junto, por cascata.
  DELETE FROM pos_producao_partes WHERE pos_id = v_pos_id;

  FOR v_sku IN
    SELECT sk.id,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(fv.rendimento_fornada, 0)               AS rendimento,
           pr.id                                            AS produto_id,
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
    FOR v_parte IN
      SELECT NULLIF(e->>'data_desenforma','')::DATE AS desenforma,
             COALESCE(
               NULLIF(e->>'validade','')::DATE,
               NULLIF(e->>'data_desenforma','')::DATE
                 + COALESCE(v_sku.validade_dias, 365)
             )                                      AS validade,
             COALESCE((e->>'formas')::INTEGER, 0)   AS formas,
             COALESCE(e->'descartes', '[]'::JSONB)  AS descartes
        FROM jsonb_array_elements(COALESCE(p_partes, '[]'::JSONB)) e
       WHERE (e->>'sessao_sku_id')::UUID = v_sku.id
         AND COALESCE((e->>'formas')::INTEGER, 0) > 0
       ORDER BY 1
    LOOP
      INSERT INTO pos_producao_partes
        (pos_id, sessao_sku_id, data_desenforma, validade, formas)
      VALUES
        (v_pos_id, v_sku.id, v_parte.desenforma, v_parte.validade, v_parte.formas)
      ON CONFLICT (pos_id, sessao_sku_id, data_desenforma)
      DO UPDATE SET validade = EXCLUDED.validade,
                    formas   = pos_producao_partes.formas + EXCLUDED.formas
      RETURNING id INTO v_parte_id;

      INSERT INTO pos_producao_descartes (pos_id, parte_id, sessao_sku_id, motivo_id, quantidade)
      SELECT v_pos_id, v_parte_id, v_sku.id,
             (d->>'motivo_id')::UUID,
             COALESCE((d->>'quantidade')::INTEGER, 0)
        FROM jsonb_array_elements(v_parte.descartes) d
       WHERE COALESCE((d->>'quantidade')::INTEGER, 0) > 0
      ON CONFLICT (parte_id, motivo_id)
      DO UPDATE SET quantidade = pos_producao_descartes.quantidade + EXCLUDED.quantidade;
    END LOOP;

    -- O que a sessão registra é o total, somando os dias.
    SELECT COALESCE(SUM(pt.formas), 0),
           COALESCE(SUM((SELECT COALESCE(SUM(dd.quantidade), 0)
                           FROM pos_producao_descartes dd
                          WHERE dd.parte_id = pt.id)), 0)
      INTO v_formas, v_descartadas
      FROM pos_producao_partes pt
     WHERE pt.pos_id = v_pos_id AND pt.sessao_sku_id = v_sku.id;

    v_boas := GREATEST(v_formas * v_sku.rendimento - v_descartadas, 0);
    v_total_boas := v_total_boas + v_boas;

    UPDATE sessoes_producao_skus
       SET quantidade_perdida   = v_descartadas,
           quantidade_produzida = v_boas
     WHERE id = v_sku.id;

    CONTINUE WHEN v_sku.produto_id IS NULL;

    -- Um lote por validade: dois dias que vencem juntos são um lote só.
    FOR v_parte IN
      SELECT pt.validade,
             MIN(pt.data_desenforma) AS desenforma,
             SUM(pt.formas) * v_sku.rendimento
             - COALESCE(SUM((SELECT COALESCE(SUM(dd.quantidade), 0)
                               FROM pos_producao_descartes dd
                              WHERE dd.parte_id = pt.id)), 0) AS boas
        FROM pos_producao_partes pt
       WHERE pt.pos_id = v_pos_id AND pt.sessao_sku_id = v_sku.id
       GROUP BY pt.validade
      HAVING SUM(pt.formas) * v_sku.rendimento
             - COALESCE(SUM((SELECT COALESCE(SUM(dd.quantidade), 0)
                               FROM pos_producao_descartes dd
                              WHERE dd.parte_id = pt.id)), 0) > 0
    LOOP
      SELECT id INTO v_lote_id
        FROM lotes_produto
       WHERE sessao_id = p_sessao_id
         AND produto_id = v_sku.produto_id
         AND validade = v_parte.validade;

      IF FOUND THEN
        -- Por diferença, para não apagar o que uma expedição já tirou daqui.
        SELECT GREATEST(quantidade_disponivel + (v_parte.boas - quantidade_produzida), 0)
          INTO v_novo_disp
          FROM lotes_produto WHERE id = v_lote_id;

        UPDATE lotes_produto
           SET quantidade_produzida  = v_parte.boas,
               quantidade_disponivel = v_novo_disp,
               data_desenforma       = v_parte.desenforma,
               status = CASE
                 WHEN v_novo_disp <= 0    THEN 'esgotado'::status_lote_produto_enum
                 WHEN status = 'esgotado' THEN 'ativo'::status_lote_produto_enum
                 ELSE status
               END
         WHERE id = v_lote_id;
      ELSE
        v_lote := registrar_lote_produto(
          p_empresa_id, v_sku.produto_id, p_sessao_id,
          v_data_producao, v_parte.boas::INTEGER, p_responsavel_id,
          v_parte.validade, v_parte.desenforma
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
    'boas', v_total_boas,
    'lotes', COALESCE(array_length(v_mantidos, 1), 0),
    'lotes_novos', v_lotes_novos,
    'falta_formas', v_falta_formas,
    'avisos', to_jsonb(v_avisos)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE) IS
  'Registra a desenforma dia a dia: formas abertas, validade e descartes de '
  'cada dia. As unidades boas saem por diferença e viram lote — um por '
  'validade. Aceita registro parcial: o resto entra quando sair da forma.';

-- ── A fila da pós conta FORMAS, não unidades ────────────────
CREATE OR REPLACE VIEW v_pos_producao_pendente AS
WITH linhas AS (
  SELECT s.id AS sessao_id, s.empresa_id, s.codigo, s.data_producao, s.data_fechamento,
         COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
         COALESCE(sk.formas_assadas, sk.multiplicador, 0)
           * COALESCE(v.rendimento_fornada, 0)            AS teoricas,
         COALESCE(ft.tipo, 'produto')                     AS tipo,
         COALESCE((SELECT SUM(pt.formas)
                     FROM pos_producao_partes pt
                    WHERE pt.sessao_sku_id = sk.id), 0)   AS desenformadas,
         COALESCE(v.rendimento_fornada, 0)                AS rendimento
    FROM sessoes_producao s
    JOIN sessoes_producao_skus sk ON sk.sessao_id = s.id
    LEFT JOIN fichas_tecnicas_versoes v ON v.id = sk.ficha_versao_id
    LEFT JOIN fichas_tecnicas ft        ON ft.id = sk.ficha_tecnica_id
   WHERE s.status = 'fechada'::status_sessao_enum
),
sessoes AS (
  SELECT sessao_id, empresa_id, codigo, data_producao, data_fechamento,
         SUM(formas)::integer        AS formas,
         SUM(teoricas)::integer      AS unidades_teoricas,
         SUM(desenformadas)::integer AS formas_desenformadas,
         SUM(GREATEST(formas - desenformadas, 0) * rendimento)::integer AS falta,
         bool_or(tipo = 'insumo')    AS tem_insumo
    FROM linhas
   GROUP BY sessao_id, empresa_id, codigo, data_producao, data_fechamento
)
SELECT se.sessao_id,
       se.empresa_id,
       se.codigo,
       se.data_producao,
       se.data_fechamento,
       (CURRENT_DATE - se.data_producao) AS dias_parado,
       se.formas,
       se.unidades_teoricas,
       reg.registradas::integer          AS unidades_registradas,
       se.falta,
       se.formas_desenformadas
  FROM sessoes se
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(lp.quantidade_produzida), 0) AS registradas
      FROM lotes_produto lp WHERE lp.sessao_id = se.sessao_id
  ) reg
 WHERE NOT se.tem_insumo
   AND (se.formas_desenformadas < se.formas
        OR NOT EXISTS (SELECT 1 FROM pos_producao pp WHERE pp.sessao_id = se.sessao_id));

-- MEDIDO, não deduzido: `CREATE OR REPLACE VIEW` APAGA o security_invoker, e
-- não só o DROP+CREATE como diz a lenda deste repositório. Conferido num
-- begin/rollback com um replace idêntico sobre a v_recipientes_composicao: a
-- opção sumiu. O comentário em contrário na 090 estava errado — depois de
-- qualquer replace, religue.
ALTER VIEW v_pos_producao_pendente SET (security_invoker = true);

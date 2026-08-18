-- ============================================================
-- Migration 096 — Produção anterior ao sistema
--
-- A fábrica produziu durante meses antes de existir MischaOS. Esses dias não
-- têm insumo rastreado, não têm balde pesado e não têm lote de produto — mas
-- têm o número que importa para qualquer comparação futura: quantas unidades
-- de cada produto saíram em cada dia.
--
-- O DESENHO. Uma sessão por dia, já fechada, com os SKUs produzidos e nada
-- mais. Sem `sessoes_producao_locais`, sem movimentação, sem lote: importar o
-- passado não pode mexer no estoque de hoje. É registro, não operação.
--
-- Por que uma coluna e não um comentário no texto livre: a sessão importada
-- precisa ser reconhecível por consulta — para sair da fila da pós-produção,
-- para poder ser desfeita, e para qualquer relatório futuro poder separar o
-- que o sistema mediu do que o usuário digitou de memória.
-- ============================================================

ALTER TABLE sessoes_producao
  ADD COLUMN IF NOT EXISTS importada BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN sessoes_producao.importada IS
  'true = produção anterior ao sistema, digitada na tela de importação. '
  'Não consumiu insumo, não gerou lote e não passa pela pós-produção. '
  'O número de unidades é o que o usuário informou, não o que o sistema mediu.';

-- ── A fila da pós ignora o que foi importado ────────────────
-- Sessão fechada sem pós registrada entra na fila pedindo desenforma. As
-- importadas nunca serão desenformadas — os brownies foram vendidos meses
-- atrás. Sem este filtro, a fila nasceria com dezenas de pendências eternas.
--
-- Definição copiada da 092, a última que tocou nesta view (conferido: nenhuma
-- migration entre a 092 e esta a recria). Única mudança: o `importada = false`.
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
     AND s.importada = false
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

-- Replace apaga a opção; religar é obrigatório (medido na 092).
ALTER VIEW v_pos_producao_pendente SET (security_invoker = true);

-- ============================================================
-- importar_producao_historica
--
-- p_itens: [{ "data": "2026-07-11", "ficha_id": "...", "unidades": 3600 }]
--
-- Unidades, não formas: é o número que o usuário tem anotado. As formas saem
-- por divisão pelo rendimento da ficha e ficam em `multiplicador`, para a
-- sessão importada conversar com as views que contam fornada.
--
-- VALIDA TUDO ANTES DE ESCREVER. Uma importação que falha no meio deixaria
-- metade dos dias lançados e o usuário sem saber quais — e o passo seguinte
-- dele seria mandar tudo de novo.
-- ============================================================
CREATE OR REPLACE FUNCTION importar_producao_historica(
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_itens          JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item        RECORD;
  v_data        DATE;
  v_sessao_id   UUID;
  v_codigo      TEXT;
  v_versao_id   UUID;
  v_rendimento  INTEGER;
  v_nome        TEXT;
  v_erros       TEXT[] := '{}';
  v_sessoes     INTEGER := 0;
  v_unidades    BIGINT  := 0;
  v_criadas     JSONB   := '[]'::JSONB;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Nenhuma linha para importar.');
  END IF;

  -- ── 1. Cada linha, isoladamente ───────────────────────────
  FOR v_item IN
    SELECT (e->>'data')::DATE            AS data,
           (e->>'ficha_id')::UUID        AS ficha_id,
           COALESCE((e->>'unidades')::INTEGER, 0) AS unidades
      FROM jsonb_array_elements(p_itens) e
  LOOP
    IF v_item.data IS NULL THEN
      v_erros := v_erros || 'Há linha sem data.';
      CONTINUE;
    END IF;

    IF v_item.data > CURRENT_DATE THEN
      v_erros := v_erros || format('%s: data no futuro.', to_char(v_item.data, 'DD/MM/YYYY'));
    END IF;

    IF v_item.unidades <= 0 THEN
      v_erros := v_erros || format('%s: quantidade tem de ser maior que zero.',
                                   to_char(v_item.data, 'DD/MM/YYYY'));
    END IF;

    SELECT ft.nome INTO v_nome
      FROM fichas_tecnicas ft
     WHERE ft.id = v_item.ficha_id AND ft.empresa_id = p_empresa_id;

    IF v_nome IS NULL THEN
      v_erros := v_erros || format('%s: produto não encontrado.',
                                   to_char(v_item.data, 'DD/MM/YYYY'));
      CONTINUE;
    END IF;

    SELECT v.id, v.rendimento_fornada INTO v_versao_id, v_rendimento
      FROM fichas_tecnicas_versoes v
     WHERE v.ficha_id = v_item.ficha_id AND v.ativa = true;

    IF v_versao_id IS NULL THEN
      v_erros := v_erros || format('%s — %s: a ficha não tem versão ativa.',
                                   to_char(v_item.data, 'DD/MM/YYYY'), v_nome);
    ELSIF COALESCE(v_rendimento, 0) <= 0 THEN
      v_erros := v_erros || format('%s — %s: a ficha não diz quantas unidades saem por forma.',
                                   to_char(v_item.data, 'DD/MM/YYYY'), v_nome);
    END IF;
  END LOOP;

  -- ── 2. O mesmo produto duas vezes no mesmo dia ─────────────
  -- Seriam duas linhas de SKU na mesma sessão, e o UNIQUE recusaria no meio
  -- da escrita. Melhor dizer qual dia está repetido.
  FOR v_item IN
    SELECT (e->>'data')::DATE AS data, (e->>'ficha_id')::UUID AS ficha_id, COUNT(*) AS n
      FROM jsonb_array_elements(p_itens) e
     GROUP BY 1, 2 HAVING COUNT(*) > 1
  LOOP
    SELECT nome INTO v_nome FROM fichas_tecnicas WHERE id = v_item.ficha_id;
    v_erros := v_erros || format('%s — %s aparece %s vezes; some as quantidades numa linha só.',
                                 to_char(v_item.data, 'DD/MM/YYYY'), COALESCE(v_nome, '?'), v_item.n);
  END LOOP;

  -- ── 3. Dia que já tem produção registrada ─────────────────
  -- Vale tanto para sessão de verdade quanto para importação repetida: nos
  -- dois casos o número apareceria dobrado em todo relatório.
  FOR v_data IN
    SELECT DISTINCT (e->>'data')::DATE FROM jsonb_array_elements(p_itens) e
  LOOP
    IF EXISTS (SELECT 1 FROM sessoes_producao s
                WHERE s.empresa_id = p_empresa_id AND s.data_producao = v_data) THEN
      v_erros := v_erros || format('%s: já existe produção registrada neste dia.',
                                   to_char(v_data, 'DD/MM/YYYY'));
    END IF;
  END LOOP;

  IF array_length(v_erros, 1) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', array_to_string(v_erros, E'\n'));
  END IF;

  -- ── 4. Escrita ────────────────────────────────────────────
  FOR v_data IN
    SELECT DISTINCT (e->>'data')::DATE FROM jsonb_array_elements(p_itens) e ORDER BY 1
  LOOP
    v_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

    INSERT INTO sessoes_producao (
      empresa_id, codigo, data_producao, status,
      aberta_por, fechada_por, data_abertura, data_fechamento,
      observacoes_abertura, observacoes_fechamento, importada
    )
    VALUES (
      p_empresa_id, v_codigo, v_data, 'fechada',
      p_responsavel_id, p_responsavel_id,
      v_data + TIME '08:00', v_data + TIME '17:00',
      'Produção anterior ao sistema, lançada na importação.',
      'Registro histórico: sem consumo de insumo e sem lote de produto.',
      true
    )
    RETURNING id INTO v_sessao_id;

    v_sessoes := v_sessoes + 1;

    FOR v_item IN
      SELECT (e->>'ficha_id')::UUID AS ficha_id,
             (e->>'unidades')::INTEGER AS unidades
        FROM jsonb_array_elements(p_itens) e
       WHERE (e->>'data')::DATE = v_data
    LOOP
      SELECT v.id, v.rendimento_fornada INTO v_versao_id, v_rendimento
        FROM fichas_tecnicas_versoes v
       WHERE v.ficha_id = v_item.ficha_id AND v.ativa = true;

      -- quantidade_perdida fica NULL de propósito: NULL é "não sei", zero
      -- afirmaria que não quebrou nenhum. Ver o mesmo cuidado na 065.
      INSERT INTO sessoes_producao_skus (
        sessao_id, ficha_tecnica_id, ficha_versao_id,
        quantidade_planejada, quantidade_produzida, quantidade_perdida, multiplicador
      )
      VALUES (
        v_sessao_id, v_item.ficha_id, v_versao_id,
        v_item.unidades, v_item.unidades, NULL,
        GREATEST(ROUND(v_item.unidades::NUMERIC / v_rendimento)::INTEGER, 1)
      );

      v_unidades := v_unidades + v_item.unidades;
    END LOOP;

    v_criadas := v_criadas || jsonb_build_object('codigo', v_codigo, 'data', v_data);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'sessoes', v_sessoes,
    'unidades', v_unidades,
    'criadas', v_criadas
  );
END;
$$;

COMMENT ON FUNCTION importar_producao_historica IS
  'Lança produção anterior ao sistema: uma sessão fechada por dia, com os SKUs '
  'produzidos e nada mais. Não toca em estoque, recipiente, movimentação ou '
  'lote. Recusa dia que já tenha produção registrada.';

-- ============================================================
-- remover_producao_importada — desfazer o que foi digitado errado
--
-- Só apaga sessão marcada como importada. Uma sessão de verdade tem consumo,
-- lote e expedição pendurados nela; apagar por engano seria irreversível.
-- ============================================================
CREATE OR REPLACE FUNCTION remover_producao_importada(
  p_empresa_id UUID,
  p_sessao_id  UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_codigo TEXT;
BEGIN
  SELECT codigo INTO v_codigo
    FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND importada = true;

  IF v_codigo IS NULL THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Esta produção não foi importada — só dá para apagar o que veio da importação.');
  END IF;

  DELETE FROM sessoes_producao WHERE id = p_sessao_id;  -- SKUs saem em cascata

  RETURN jsonb_build_object('ok', true, 'codigo', v_codigo);
END;
$$;

COMMENT ON FUNCTION remover_producao_importada IS
  'Apaga uma sessão de produção importada e seus SKUs. Recusa sessão real.';

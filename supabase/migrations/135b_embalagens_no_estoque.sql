-- ============================================================
-- Migration 135b — embalagens da Odara no estoque
--
-- A Odara manda os displays, as caixas de embarque e as bobinas de BOPP dos
-- brownies dela. Até aqui nada disso tinha estoque: não dava para fechar o
-- inventário do mês nem saber quando pedir (Lucca, 29–30/09/2026).
--
-- As cinco embalagens viram insumos comuns — recebimento, etiqueta, contagem
-- e histórico já funcionam para elas — mas ficam FORA das fichas técnicas. O
-- que diz quanto cada brownie gasta é a tabela nova `embalagem_consumo`:
--
--   BOPP ........ 1,2 g por brownie (já com a perda média), um por sabor.
--                 Desconta sozinho na pós-produção, sobre os brownies bons
--                 MAIS o descarte "Mordido na flowpack" — esses chegaram a
--                 ser embalados.
--   Display ..... 1 a cada 12 brownies, um por sabor.
--   Caixa ....... 1 a cada 72 brownies (6 displays), a mesma nos dois sabores.
--                 Display e caixa descontam À MÃO, na entrega (Expedição),
--                 até as etiquetas de expedição existirem (Parte 3).
--
-- Embalagem não vence: o lote exige data, e grava 31/12/2099 por baixo. A
-- tela mostra "sem validade".
--
-- O desconto automático só vale a partir de `configuracoes_sistema.
-- embalagens_desde` — a data do saldo inicial. Antes dela o estoque de
-- embalagem não existia, e descontar de nada só geraria aviso falso.
-- ============================================================

ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS embalagens_desde DATE;

COMMENT ON COLUMN configuracoes_sistema.embalagens_desde IS
  'Sessões produzidas a partir desta data descontam BOPP na pós-produção. NULL = ainda não começou (migration 135b).';

-- ── Categoria e os cinco insumos ─────────────────────────────
INSERT INTO categorias_insumo (empresa_id, nome, descricao)
SELECT '59e40a9f-b136-4c47-8dc0-2edd73dbe341', 'EMBALAGENS',
       'Display, caixa de embarque e BOPP da Odara — fora das fichas técnicas'
 WHERE NOT EXISTS (SELECT 1 FROM categorias_insumo
                    WHERE empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
                      AND nome = 'EMBALAGENS');

CREATE TEMP TABLE _emb_novos (
  codigo TEXT, nome TEXT, unidade unidade_medida_enum, tam NUMERIC,
  tipo tipo_embalagem_fornecedor_enum
) ON COMMIT DROP;

INSERT INTO _emb_novos VALUES
  ('INS035', 'Display Tradicional Odara',   'unid', 250, 'caixa'),
  ('INS036', 'Display Doce de Leite Odara', 'unid', 250, 'caixa'),
  ('INS037', 'Caixa de embarque Odara',     'unid',  25, 'fardo'),
  ('INS038', 'BOPP Tradicional Odara',      'kg',   9.5, 'bobina'),
  ('INS039', 'BOPP Doce de Leite Odara',    'kg',   9.5, 'bobina');

INSERT INTO insumos (empresa_id, codigo, nome, categoria_id, unidade_medida,
                     tamanho_embalagem, ativo, observacoes)
SELECT '59e40a9f-b136-4c47-8dc0-2edd73dbe341', n.codigo, n.nome, c.id, n.unidade,
       n.tam, true, 'Embalagem da Odara, fora das fichas técnicas (migration 135b).'
  FROM _emb_novos n
  JOIN categorias_insumo c
    ON c.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341' AND c.nome = 'EMBALAGENS'
 WHERE NOT EXISTS (SELECT 1 FROM insumos i
                    WHERE i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
                      AND i.nome = n.nome);

INSERT INTO insumos_embalagem_config
  (insumo_id, tipo_embalagem, quantidade_total, unidade_total, tem_subunidades)
SELECT i.id, n.tipo, n.tam, n.unidade, false
  FROM _emb_novos n
  JOIN insumos i ON i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341' AND i.nome = n.nome
 WHERE NOT EXISTS (SELECT 1 FROM insumos_embalagem_config e WHERE e.insumo_id = i.id);

-- Não vão para pote: a embalagem do fornecedor é o próprio recipiente.
INSERT INTO insumos_armazenamento_config (insumo_id, modo_ep)
SELECT i.id, 'embalagem_fornecedor'
  FROM _emb_novos n
  JOIN insumos i ON i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341' AND i.nome = n.nome
 WHERE NOT EXISTS (SELECT 1 FROM insumos_armazenamento_config a WHERE a.insumo_id = i.id);

-- ── Quanto cada brownie gasta ────────────────────────────────
CREATE TABLE IF NOT EXISTS embalagem_consumo (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id),
  insumo_id       UUID NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  ficha_id        UUID NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  qtd_por_brownie NUMERIC NOT NULL CHECK (qtd_por_brownie > 0),
  gatilho         TEXT NOT NULL CHECK (gatilho IN ('pos_producao', 'entrega')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (insumo_id, ficha_id)
);

COMMENT ON TABLE embalagem_consumo IS
  'A "ficha" das embalagens: quanto cada brownie de uma ficha gasta, na unidade do insumo. '
  'gatilho = quando o estoque desce (pos_producao: sozinho; entrega: à mão). Migration 135b.';

ALTER TABLE embalagem_consumo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acesso_por_empresa ON embalagem_consumo;
CREATE POLICY acesso_por_empresa ON embalagem_consumo FOR ALL TO authenticated
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());
-- A trava do papel 'odara' (134b) vale também aqui.
DROP POLICY IF EXISTS odara_nao_insere ON embalagem_consumo;
DROP POLICY IF EXISTS odara_nao_altera ON embalagem_consumo;
DROP POLICY IF EXISTS odara_nao_apaga ON embalagem_consumo;
CREATE POLICY odara_nao_insere ON embalagem_consumo AS RESTRICTIVE FOR INSERT
  TO authenticated WITH CHECK (papel_do_usuario() IS DISTINCT FROM 'odara');
CREATE POLICY odara_nao_altera ON embalagem_consumo AS RESTRICTIVE FOR UPDATE
  TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara');
CREATE POLICY odara_nao_apaga ON embalagem_consumo AS RESTRICTIVE FOR DELETE
  TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara');

INSERT INTO embalagem_consumo (empresa_id, insumo_id, ficha_id, qtd_por_brownie, gatilho)
SELECT '59e40a9f-b136-4c47-8dc0-2edd73dbe341', i.id, f.id, r.qtd, r.gatilho
  FROM (VALUES
    ('BOPP Tradicional Odara',      'FT-001', 0.0012::NUMERIC,  'pos_producao'),
    ('BOPP Doce de Leite Odara',    'FT-002', 0.0012::NUMERIC,  'pos_producao'),
    ('Display Tradicional Odara',   'FT-001', 1 / 12::NUMERIC,  'entrega'),
    ('Display Doce de Leite Odara', 'FT-002', 1 / 12::NUMERIC,  'entrega'),
    ('Caixa de embarque Odara',     'FT-001', 1 / 72::NUMERIC,  'entrega'),
    ('Caixa de embarque Odara',     'FT-002', 1 / 72::NUMERIC,  'entrega')
  ) AS r(nome, ficha, qtd, gatilho)
  JOIN insumos i ON i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341' AND i.nome = r.nome
  JOIN fichas_tecnicas f ON f.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341' AND f.codigo = r.ficha
ON CONFLICT (insumo_id, ficha_id) DO NOTHING;

-- ── Tirar dos lotes do estoque central ───────────────────────
-- A embalagem já aberta primeiro, depois a que vence antes (FEFO). Devolve o
-- que NÃO conseguiu tirar. Interna: só as duas funções abaixo chamam.
CREATE OR REPLACE FUNCTION public._baixar_lotes_embalagem(
  p_mov_id UUID, p_empresa_id UUID, p_insumo_id UUID, p_qtd NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_resta NUMERIC := ROUND(p_qtd, 4);
  v_l     RECORD;
  v_leva  NUMERIC;
BEGIN
  FOR v_l IN
    SELECT id, quantidade_disponivel, unidade
      FROM lotes
     WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
       AND status = 'ativo' AND quantidade_disponivel > 0
     ORDER BY embalagem_aberta DESC, validade_pos_abertura, codigo
     FOR UPDATE
  LOOP
    EXIT WHEN v_resta <= 0.0001;
    v_leva := LEAST(v_resta, v_l.quantidade_disponivel);

    UPDATE lotes
       SET quantidade_disponivel = GREATEST(ROUND(quantidade_disponivel - v_leva, 4), 0),
           status = CASE WHEN quantidade_disponivel - v_leva <= 0.0001
                         THEN 'esgotado'::status_lote_enum ELSE status END,
           embalagem_aberta = true,
           saldo_estimado = true,
           updated_at = NOW()
     WHERE id = v_l.id;

    INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade)
    VALUES (p_mov_id, v_l.id, v_leva, v_l.unidade);

    v_resta := ROUND(v_resta - v_leva, 4);
  END LOOP;

  RETURN GREATEST(v_resta, 0);
END;
$$;
REVOKE ALL ON FUNCTION _baixar_lotes_embalagem(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _baixar_lotes_embalagem(UUID, UUID, UUID, NUMERIC) TO service_role;

-- ── BOPP na pós-produção ─────────────────────────────────────
-- O registrar_pos_producao é chamado de novo, com o retrato inteiro, a cada
-- salvamento parcial. Por isso aqui se calcula o ALVO da sessão e se desconta
-- só a diferença para o que já foi descontado. Correção para menos devolve
-- aos lotes de onde saiu, o mais recente primeiro.
CREATE OR REPLACE FUNCTION public.baixar_embalagem_pos_producao(
  p_empresa_id UUID, p_sessao_id UUID, p_responsavel_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_desde   DATE;
  v_data    DATE;
  v_sessao  TEXT;
  v_r       RECORD;
  v_i       RECORD;
  v_feito   NUMERIC;
  v_delta   NUMERIC;
  v_volta   NUMERIC;
  v_falta   NUMERIC;
  v_mov_id  UUID;
  v_avisos  TEXT[] := '{}';
BEGIN
  SELECT embalagens_desde INTO v_desde
    FROM configuracoes_sistema WHERE empresa_id = p_empresa_id;
  SELECT data_producao, codigo INTO v_data, v_sessao
    FROM sessoes_producao WHERE id = p_sessao_id AND empresa_id = p_empresa_id;

  IF v_desde IS NULL OR v_data IS NULL OR v_data < v_desde THEN
    RETURN jsonb_build_object('ok', true, 'avisos', '[]'::JSONB);
  END IF;

  FOR v_r IN
    SELECT ec.insumo_id, i.nome, i.unidade_medida::TEXT AS unidade,
           ROUND(SUM(ec.qtd_por_brownie * (
             COALESCE(sk.quantidade_produzida, 0)
             + COALESCE((SELECT SUM(d.quantidade)
                           FROM pos_producao_descartes d
                           JOIN motivos_descarte m ON m.id = d.motivo_id
                          WHERE d.sessao_sku_id = sk.id
                            AND m.codigo = 'mordido_flowpack'), 0)
           )), 4) AS alvo
      FROM sessoes_producao_skus sk
      JOIN embalagem_consumo ec
        ON ec.ficha_id = sk.ficha_tecnica_id
       AND ec.empresa_id = p_empresa_id
       AND ec.gatilho = 'pos_producao'
      JOIN insumos i ON i.id = ec.insumo_id
     WHERE sk.sessao_id = p_sessao_id
     GROUP BY ec.insumo_id, i.nome, i.unidade_medida
  LOOP
    SELECT COALESCE(SUM(mi.quantidade), 0) INTO v_feito
      FROM movimentacoes m
      JOIN movimentacoes_itens mi ON mi.movimentacao_id = m.id
      JOIN lotes l ON l.id = mi.lote_id
     WHERE m.sessao_producao_id = p_sessao_id
       AND m.tipo = 'consumo_producao'
       AND l.insumo_id = v_r.insumo_id;

    v_delta := ROUND(v_r.alvo - v_feito, 4);
    CONTINUE WHEN abs(v_delta) < 0.0005;

    IF v_mov_id IS NULL THEN
      INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                 sessao_producao_id, observacoes)
      VALUES (gen_random_uuid(), p_empresa_id,
              gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV'),
              'consumo_producao', p_responsavel_id, p_sessao_id,
              format('Embalagem da pós-produção %s (migration 135b)', v_sessao))
      RETURNING id INTO v_mov_id;
    END IF;

    IF v_delta > 0 THEN
      v_falta := _baixar_lotes_embalagem(v_mov_id, p_empresa_id, v_r.insumo_id, v_delta);
      IF v_falta > 0.0005 THEN
        v_avisos := v_avisos || format(
          'Faltou %s %s de %s no estoque: a pós-produção foi salva, mas registre a entrada que está faltando.',
          replace(to_char(v_falta, 'FM999990.000'), '.', ','), v_r.unidade, v_r.nome);
      END IF;
    ELSE
      -- Menos brownie do que antes: devolve, desfazendo as saídas desta sessão.
      v_volta := -v_delta;
      FOR v_i IN
        SELECT l.id AS lote_id, l.unidade, SUM(mi.quantidade) AS liquido
          FROM movimentacoes m
          JOIN movimentacoes_itens mi ON mi.movimentacao_id = m.id
          JOIN lotes l ON l.id = mi.lote_id
         WHERE m.sessao_producao_id = p_sessao_id
           AND m.tipo = 'consumo_producao'
           AND l.insumo_id = v_r.insumo_id
         GROUP BY l.id, l.unidade, l.validade_pos_abertura, l.codigo
        HAVING SUM(mi.quantidade) > 0
         ORDER BY l.validade_pos_abertura DESC, l.codigo DESC
      LOOP
        EXIT WHEN v_volta <= 0.0001;
        UPDATE lotes
           SET quantidade_disponivel = ROUND(quantidade_disponivel + LEAST(v_volta, v_i.liquido), 4),
               status = CASE WHEN status = 'esgotado' THEN 'ativo'::status_lote_enum ELSE status END,
               updated_at = NOW()
         WHERE id = v_i.lote_id;
        INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, quantidade, unidade, observacoes)
        VALUES (v_mov_id, v_i.lote_id, -LEAST(v_volta, v_i.liquido), v_i.unidade,
                'Devolução: a pós-produção foi corrigida para menos');
        v_volta := ROUND(v_volta - LEAST(v_volta, v_i.liquido), 4);
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'avisos', to_jsonb(v_avisos));
END;
$$;
REVOKE ALL ON FUNCTION baixar_embalagem_pos_producao(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION baixar_embalagem_pos_producao(UUID, UUID, UUID) TO authenticated, service_role;

-- ── Display e caixa na entrega (à mão, até a Parte 3) ────────
CREATE OR REPLACE FUNCTION public.registrar_entrega_embalagens(
  p_empresa_id UUID, p_responsavel_id UUID, p_data DATE, p_itens JSONB,
  p_observacoes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_it      RECORD;
  v_mov_id  UUID;
  v_codigo  TEXT;
  v_data    DATE := COALESCE(p_data, CURRENT_DATE);
  v_falta   NUMERIC;
  v_total   NUMERIC := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND (
       p_empresa_id IS DISTINCT FROM get_empresa_id_do_usuario()
       OR papel_do_usuario() = 'odara') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sem permissão para registrar entrega.');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _entrega (insumo_id UUID, nome TEXT, qtd NUMERIC, saldo NUMERIC)
    ON COMMIT DROP;
  DELETE FROM _entrega;

  INSERT INTO _entrega
  SELECT i.id, i.nome, SUM((e->>'quantidade')::NUMERIC),
         (SELECT COALESCE(SUM(l.quantidade_disponivel), 0) FROM lotes l
           WHERE l.insumo_id = i.id AND l.status = 'ativo')
    FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) e
    JOIN insumos i ON i.id = (e->>'insumo_id')::UUID AND i.empresa_id = p_empresa_id
   WHERE COALESCE((e->>'quantidade')::NUMERIC, 0) > 0
     AND EXISTS (SELECT 1 FROM embalagem_consumo ec
                  WHERE ec.insumo_id = i.id AND ec.gatilho = 'entrega')
   GROUP BY i.id, i.nome;

  IF NOT EXISTS (SELECT 1 FROM _entrega) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe pelo menos uma quantidade.');
  END IF;

  SELECT * INTO v_it FROM _entrega WHERE qtd > saldo ORDER BY nome LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'O estoque tem %s de %s e a entrega pede %s. Registre a entrada que está faltando antes.',
      v_it.saldo::INTEGER, v_it.nome, v_it.qtd::INTEGER));
  END IF;

  v_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, data_hora, responsavel_id, observacoes)
  VALUES (gen_random_uuid(), p_empresa_id, v_codigo, 'consumo_producao',
          CASE WHEN v_data = CURRENT_DATE THEN NOW() ELSE v_data + TIME '12:00' END,
          p_responsavel_id,
          'Entrega Odara ' || to_char(v_data, 'DD/MM')
            || COALESCE(' — ' || NULLIF(trim(p_observacoes), ''), ''))
  RETURNING id INTO v_mov_id;

  FOR v_it IN SELECT * FROM _entrega LOOP
    v_falta := _baixar_lotes_embalagem(v_mov_id, p_empresa_id, v_it.insumo_id, v_it.qtd);
    IF v_falta > 0 THEN
      RAISE EXCEPTION 'Saldo de % mudou durante a entrega.', v_it.nome;
    END IF;
    v_total := v_total + v_it.qtd;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'movimentacao', v_codigo, 'unidades', v_total);
END;
$$;
REVOKE ALL ON FUNCTION registrar_entrega_embalagens(UUID, UUID, DATE, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_entrega_embalagens(UUID, UUID, DATE, JSONB, TEXT) TO authenticated, service_role;

-- ── A pós-produção passa a chamar o desconto do BOPP ─────────
-- Parte do pg_get_functiondef vivo (092): só ganha v_emb e a chamada no fim.
CREATE OR REPLACE FUNCTION public.registrar_pos_producao(p_empresa_id uuid, p_sessao_id uuid, p_responsavel_id uuid, p_partes jsonb, p_observacoes text DEFAULT NULL::text, p_data date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  v_emb           JSONB;
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

  -- BOPP: desconta a diferença para o que esta sessão já gastou (135b).
  v_emb := baixar_embalagem_pos_producao(p_empresa_id, p_sessao_id, p_responsavel_id);
  v_avisos := v_avisos || ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(v_emb->'avisos', '[]'::JSONB)));

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
$function$;

NOTIFY pgrst, 'reload schema';

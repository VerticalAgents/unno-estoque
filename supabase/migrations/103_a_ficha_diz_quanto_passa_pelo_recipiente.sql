-- ============================================================
-- Migration 103 — a linha da ficha diz quanto passa pelo recipiente
--
-- O doce de leite entra na receita do brownie de doce de leite por DOIS
-- caminhos ao mesmo tempo: 200 g por forma saem de um saco de confeitar, para
-- o topping, e os outros 558,9 g vao do balde do fornecedor direto para a
-- massa. E o unico insumo assim, e nenhuma das duas metades e opcional.
--
-- A ficha dizia QUANTO entra, nunca POR ONDE. O planejador entao tratava os
-- 758,9 g inteiros como se passassem pela caixa de sacos: para 44 formas pedia
-- quatro caixas onde uma basta, e avisava que faltava recipiente para uma
-- producao que sempre coube. A abertura de sessao fazia o mesmo com o consumo
-- teorico, jogando 33 kg contra uma caixa de 9,6 kg.
--
-- ── A escolha do lugar ───────────────────────────────────────
--
-- O campo entra na LINHA DA FICHA, e nao no insumo. E a receita que decide
-- quanto vira topping: o mesmo doce de leite, no brownie tradicional, vai
-- inteiro para a massa e nao passa por saco nenhum. Guardar isso no insumo
-- daria uma resposta so para duas perguntas diferentes.
--
-- ── E nada disso menciona doce de leite ──────────────────────
--
-- O comportamento sai do cadastro: o insumo diz que passa por reembalagem e
-- qual o tamanho da porcao; a linha da ficha diz quanto vem por ali. Outro
-- cliente, com outro insumo porcionado, configura o dele e funciona igual.
-- Os numeros desta fabrica ficam na migration seguinte.
--
-- Ambas as funcoes partiram de `pg_get_functiondef` -- ver CLAUDE.md.
-- ============================================================

ALTER TABLE fichas_tecnicas_itens
  ADD COLUMN IF NOT EXISTS quantidade_porcionada NUMERIC(12,6);

COMMENT ON COLUMN fichas_tecnicas_itens.quantidade_porcionada IS
  'Quanto, da quantidade desta linha, passa pela embalagem porcionada (saco de '
  'confeitar) em vez do recipiente comum. NULL = a linha inteira passa pelo '
  'recipiente, que e o caso de quase todo insumo. Na mesma unidade da linha e '
  'por fornada, como `quantidade`.';

-- Mais do que o total seria receita impossivel; negativo nao existe.
ALTER TABLE fichas_tecnicas_itens
  DROP CONSTRAINT IF EXISTS chk_porcionada_cabe;
ALTER TABLE fichas_tecnicas_itens
  ADD CONSTRAINT chk_porcionada_cabe
  CHECK (quantidade_porcionada IS NULL
         OR (quantidade_porcionada >= 0 AND quantidade_porcionada <= quantidade));

CREATE OR REPLACE FUNCTION public.planejar_recipientes(p_empresa_id uuid, p_plano jsonb)
 RETURNS TABLE(insumo_id uuid, codigo text, nome text, unidade text, recipiente_modelo text, capacidade numeric, demanda numeric, demanda_com_folga numeric, recipientes_atuais integer, recipientes_necessarios integer, faltam integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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
  -- `quantidade` e o consumo POR FORMA (migration 029). Multiplicar tambem
  -- pelo rendimento conta cada forma 60 vezes.
  -- SO A PARTE QUE PASSA PELO RECIPIENTE entra na conta.
  --
  -- O doce de leite entra na mesma receita por dois caminhos: 200 g por forma
  -- saem do saco de confeitar, para o topping, e o resto vai do balde do
  -- fornecedor direto para a massa. Somando os dois, o planejador pedia quatro
  -- caixas de sacos onde uma basta -- e dizia que nao havia recipiente
  -- suficiente para uma producao que sempre coube.
  --
  -- `quantidade_porcionada` diz quanto daquela linha passa pelo recipiente.
  -- Linha sem o campo continua valendo inteira, que e o caso de todo o resto.
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(COALESCE(it.quantidade_porcionada, it.quantidade) * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
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
  -- Ordem do codigo (migration 031): e a ordem em que os recipientes sao
  -- conferidos na pratica, e mantem tela e folha impressa iguais.
  ORDER BY b.codigo;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.abrir_sessao_producao_v2(p_empresa_id uuid, p_responsavel_id uuid, p_data_producao date, p_plano jsonb, p_observacoes text DEFAULT NULL::text, p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_inseridos         INTEGER;
  v_faltantes         JSONB;
  v_trava             JSONB;
  v_aplicacao         JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM sessoes_producao
              WHERE empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Já existe uma sessão aberta. Feche-a antes de abrir uma nova.');
  END IF;

  IF p_plano IS NULL OR jsonb_array_length(p_plano) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe ao menos uma ficha com quantidade de formas.');
  END IF;

  -- ── Insumo suficiente nos recipientes? ────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'codigo', x.codigo, 'nome', x.nome,
           'precisa', ROUND(x.demanda, 3), 'tem', ROUND(x.conteudo, 3),
           'falta', ROUND(x.demanda - x.conteudo, 3), 'unidade', x.unidade))
    INTO v_faltantes
    FROM (
      SELECT i.codigo, i.nome, i.unidade_medida AS unidade,
             SUM(fti.quantidade * (e->>'formas')::INTEGER) AS demanda,
             COALESCE((SELECT SUM(c.quantidade_total)
                         FROM v_recipientes_composicao c
                        WHERE c.empresa_id = p_empresa_id AND c.insumo_id = i.id), 0) AS conteudo
        FROM jsonb_array_elements(p_plano) e
        JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
        JOIN insumos i ON i.id = fti.insumo_id
       WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       GROUP BY i.id, i.codigo, i.nome, i.unidade_medida
    ) x
   WHERE x.demanda > x.conteudo;

  IF v_faltantes IS NOT NULL THEN
    v_trava := avaliar_trava(p_empresa_id, 'sessao_sem_insumo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object(
        'ok', false,
        'trava', 'sessao_sem_insumo',
        'mensagem', format('%s insumo(s) sem quantidade suficiente nos recipientes. '
                           'A produção pararia no meio para abastecer.',
                           jsonb_array_length(v_faltantes)),
        'faltantes', v_faltantes
      );
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'sessao_sem_insumo',
                              jsonb_build_object('faltantes', v_faltantes), p_justificativa);
  END IF;

  -- ── Cria a sessão ─────────────────────────────────────────
  v_sessao_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, observacoes_abertura
  )
  VALUES (
    p_empresa_id, v_sessao_codigo, p_data_producao, 'aberta',
    p_responsavel_id, NOW(), p_observacoes
  )
  RETURNING id INTO v_sessao_id;

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas);

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  FOR v_item IN
    -- Mesma divisao do planejador: so o que passa pelo recipiente vira consumo
    -- teorico de pote. O que sai direto da embalagem do fornecedor nao tem pote
    -- para descontar -- e o caso do xarope, da baunilha e da parte do doce de
    -- leite que vai para a massa.
    SELECT fti.insumo_id,
           SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
               * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT v_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.consumo_teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    GET DIAGNOSTICS v_inseridos = ROW_COUNT;
    v_locais_vinculados := v_locais_vinculados + v_inseridos;
  END LOOP;

  -- O teorico deixa de ser rateado entre todos os potes: e enfileirado.
  PERFORM redistribuir_teorico_sequencial(v_sessao_id);

  -- E sai do pote AGORA, não no fechamento: os baldes são repostos durante a
  -- produção, e a reposição precisa encontrar no sistema o pote como ele está
  -- na bancada.
  v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

  RETURN jsonb_build_object(
    'ok', true, 'sessao_id', v_sessao_id, 'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades, 'locais_vinculados', v_locais_vinculados,
    'consumo_baixado', COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0),
    'recipientes_baixados', COALESCE((v_aplicacao->>'recipientes')::INTEGER, 0)
  );
END;
$function$
;

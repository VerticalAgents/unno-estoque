-- ============================================================
-- Migration 107 — o aviso de "sem insumo" tambem olha so o que vai ao pote
--
-- A 103 dividiu o consumo teorico por caminho, mas deixou de fora a
-- conferencia que dispara a trava `sessao_sem_insumo` -- ela continuava
-- somando a linha inteira da ficha.
--
-- O efeito: abrir qualquer sessao de brownie de doce de leite acusaria falta,
-- porque os 558,9 g por forma que vao para a massa saem do balde do fornecedor
-- e nunca estiveram num recipiente. A conta comparava 33 kg de demanda com o
-- que ha na caixa de sacos.
--
-- Aviso que aparece sempre deixa de ser lido. O dia em que faltar de verdade,
-- ninguem vai olhar.
--
-- Partiu de `pg_get_functiondef` -- ver CLAUDE.md.
-- ============================================================

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
      -- So o que passa pelo RECIPIENTE entra nesta conferencia. O aviso
      -- compara a demanda com o conteudo dos potes, e o que sai direto da
      -- embalagem do fornecedor nunca esteve em pote nenhum: incluir isso
      -- faria a tela dizer "falta doce de leite" em TODA sessao do brownie de
      -- doce de leite, porque os 558,9 g por forma da massa nao moram em pote.
      --
      -- Aviso que sempre aparece deixa de ser lido, e o dia em que faltar de
      -- verdade ele nao vai ser levado a serio.
      SELECT i.codigo, i.nome, i.unidade_medida AS unidade,
             SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
                 * (e->>'formas')::INTEGER) AS demanda,
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

-- ============================================================
-- Migration 093 — O dossiê de rastreabilidade
--
-- A pergunta que esta migration existe para responder é literal, e vem de fora:
-- o cliente liga e pergunta *"que insumo vocês usaram no produto com validade
-- X?"*. A resposta tem de sair em papel, entregável a um auditor.
--
-- A corrente já estava inteira no banco, só nunca tinha sido percorrida de uma
-- ponta à outra:
--
--   lotes_produto (validade)
--     → sessoes_producao
--       → sessoes_producao_locais (o que saiu de cada pote)
--         → lotes  (que é o próprio recebimento: NF, fornecedor, marca,
--                   validade de origem, temperatura de chegada)
--
-- E, por fora, a ficha técnica NA VERSÃO USADA — `ficha_versao_id` da sessão,
-- não a versão ativa de hoje. Numa auditoria de agosto, a receita que vale é a
-- de agosto.
--
-- POR QUE UMA RPC E NÃO CINCO SELECTS. São cinco níveis de junção com dois
-- agrupamentos diferentes (sublotes de um mesmo recebimento; recipientes de uma
-- mesma sessão). Montar isso no cliente daria consulta em cascata e nenhuma
-- forma de provar o resultado. Como função, dá para conferir com
-- `begin; select dossie_rastreabilidade(...); rollback;` sobre os dados reais —
-- foi assim que o produto cartesiano da 087 apareceu.
--
-- O DOSSIÊ É POR DATA **E PRODUTO**. Vários lotes da mesma validade entram
-- todos, com todas as suas sessões, porque não há como saber qual sessão
-- originou a caixa que o auditor tem na mão. Mas produtos diferentes nunca se
-- misturam: num dia em que vencerem um produto de um cliente e o de outro,
-- juntá-los entregaria a um auditor o documento do concorrente.
--
-- SEM PERDAS. Decisão do usuário: o dossiê mostra o que foi usado e de onde
-- veio. Perda é assunto do painel de Perdas, com fontes e periodicidades
-- próprias.
-- ============================================================

-- ── O calendário ────────────────────────────────────────────
-- Uma linha por (empresa, validade, produto). É o que pinta o mês e o que
-- decide se um dia abre direto ou pergunta qual produto.
CREATE OR REPLACE VIEW v_calendario_validades AS
SELECT lp.empresa_id,
       lp.validade,
       pr.id                                    AS produto_id,
       pr.nome                                  AS produto_nome,
       pr.codigo                                AS produto_codigo,
       COUNT(*)::integer                        AS lotes,
       SUM(lp.quantidade_produzida)::integer    AS unidades_produzidas,
       SUM(lp.quantidade_disponivel)::integer   AS unidades_disponiveis,
       COUNT(DISTINCT lp.sessao_id)::integer    AS sessoes
  FROM lotes_produto lp
  JOIN produtos pr ON pr.id = lp.produto_id
 GROUP BY lp.empresa_id, lp.validade, pr.id, pr.nome, pr.codigo;

COMMENT ON VIEW v_calendario_validades IS
  'Datas de validade com produto vencendo, para o calendário da '
  'rastreabilidade. Uma linha por dia e produto.';

-- ── O dossiê ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dossie_rastreabilidade(
  p_empresa_id UUID,
  p_validade   DATE,
  p_produto_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_produto   JSONB;
  v_lotes     JSONB;
  v_sessoes   JSONB;
  v_insumos   JSONB;
  v_desenf    JSONB;
  v_avisos    JSONB;
  v_ids       UUID[];
BEGIN
  SELECT jsonb_build_object(
           'id', pr.id, 'codigo', pr.codigo, 'nome', pr.nome,
           'peso_unitario_g', pr.peso_unitario_g,
           'validade_dias', pr.validade_dias,
           'ficha_tecnica_id', pr.ficha_tecnica_id)
    INTO v_produto
    FROM produtos pr
   WHERE pr.id = p_produto_id AND pr.empresa_id = p_empresa_id;

  IF v_produto IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Produto não encontrado.');
  END IF;

  -- As sessões que originaram este produto nesta validade. Tudo o que vem
  -- depois pendura aqui.
  SELECT array_agg(DISTINCT lp.sessao_id)
    INTO v_ids
    FROM lotes_produto lp
   WHERE lp.empresa_id = p_empresa_id
     AND lp.produto_id = p_produto_id
     AND lp.validade = p_validade;

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Nenhum lote deste produto vence nesta data.');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'codigo', lp.codigo, 'qr_code', lp.qr_code,
           'quantidade_produzida', lp.quantidade_produzida,
           'quantidade_disponivel', lp.quantidade_disponivel,
           'status', lp.status,
           'data_producao', lp.data_producao,
           'data_desenforma', lp.data_desenforma,
           'sessao_id', lp.sessao_id
         ) ORDER BY lp.codigo)
    INTO v_lotes
    FROM lotes_produto lp
   WHERE lp.empresa_id = p_empresa_id
     AND lp.produto_id = p_produto_id
     AND lp.validade = p_validade;

  -- ── Sessões, com a ficha na versão da época ───────────────
  -- Os itens da versão saem numa subconsulta, e não num JOIN: juntar itens de
  -- ficha com recipientes na mesma consulta é exatamente o produto cartesiano
  -- que a 087 teve de desfazer.
  SELECT jsonb_agg(s.linha ORDER BY s.data_producao, s.codigo)
    INTO v_sessoes
    FROM (
      SELECT sp.data_producao, sp.codigo,
             jsonb_build_object(
               'id', sp.id,
               'codigo', sp.codigo,
               'data_producao', sp.data_producao,
               'data_abertura', sp.data_abertura,
               'data_fechamento', sp.data_fechamento,
               'aberta_por', ua.nome,
               'fechada_por', uf.nome,
               'observacoes_abertura', sp.observacoes_abertura,
               'observacoes_fechamento', sp.observacoes_fechamento,
               'skus', (
                 SELECT jsonb_agg(jsonb_build_object(
                          'ficha_id', ft.id,
                          'ficha_codigo', ft.codigo,
                          'ficha_nome', ft.nome,
                          'versao_id', fv.id,
                          'versao', fv.versao,
                          'notas_alteracao', fv.notas_alteracao,
                          'rendimento_fornada', fv.rendimento_fornada,
                          'peso_medio_g', fv.peso_medio_g,
                          'formas_assadas', COALESCE(sk.formas_assadas, sk.multiplicador),
                          'quantidade_produzida', sk.quantidade_produzida,
                          'itens', (
                            SELECT jsonb_agg(jsonb_build_object(
                                     'insumo_codigo', i.codigo,
                                     'insumo_nome', i.nome,
                                     'quantidade', fi.quantidade,
                                     'unidade', fi.unidade,
                                     'observacoes', fi.observacoes
                                   ) ORDER BY fi.quantidade DESC)
                              FROM fichas_tecnicas_itens fi
                              JOIN insumos i ON i.id = fi.insumo_id
                             WHERE fi.versao_id = fv.id)
                        ) ORDER BY ft.nome)
                   FROM sessoes_producao_skus sk
                   JOIN fichas_tecnicas ft          ON ft.id = sk.ficha_tecnica_id
                   JOIN fichas_tecnicas_versoes fv  ON fv.id = sk.ficha_versao_id
                  WHERE sk.sessao_id = sp.id)
             ) AS linha
        FROM sessoes_producao sp
        LEFT JOIN usuarios ua ON ua.id = sp.aberta_por
        LEFT JOIN usuarios uf ON uf.id = sp.fechada_por
       WHERE sp.id = ANY(v_ids) AND sp.empresa_id = p_empresa_id
    ) s;

  -- ── Insumos: um por sessão e por RECEBIMENTO ──────────────
  -- Agrupado por `lote_grupo_id` como na 087: o operador bipou o sublote 3 do
  -- saco, mas quem audita quer o saco — o código-pai e a nota que o trouxe.
  SELECT jsonb_agg(x.linha ORDER BY x.sessao_codigo, x.insumo_nome, x.lote_codigo)
    INTO v_insumos
    FROM (
      SELECT sp.codigo AS sessao_codigo, i.nome AS insumo_nome,
             MIN(split_part(l.codigo::TEXT, '.', 1)) AS lote_codigo,
             jsonb_build_object(
               'sessao_id', sp.id,
               'sessao_codigo', sp.codigo,
               'insumo_codigo', i.codigo,
               'insumo_nome', i.nome,
               'unidade', i.unidade_medida,
               'consumo_real', SUM(spl.consumo_real),
               'lote_codigo', MIN(split_part(l.codigo::TEXT, '.', 1)),
               'sublotes', COUNT(DISTINCT l.id),
               'marca', MAX(ma.nome),
               'fornecedor', MAX(fo.nome),
               'fornecedor_cnpj', MAX(fo.cnpj),
               'numero_nf', MAX(l.numero_nf),
               'data_recebimento', MAX(l.data_recebimento),
               'data_fabricacao', MAX(l.data_fabricacao),
               'validade_original', MAX(l.validade_original),
               'temperatura_recebimento', MAX(l.temperatura_recebimento),
               'embalagem_aberta', bool_or(l.embalagem_aberta),
               'origem', MAX(l.origem),
               'recebido_por', MAX(ur.nome),
               'recipientes', string_agg(DISTINCT loc.nome::TEXT, ', ' ORDER BY loc.nome::TEXT)
             ) AS linha
        FROM sessoes_producao_locais spl
        JOIN sessoes_producao sp ON sp.id = spl.sessao_id
        JOIN insumos i           ON i.id = spl.insumo_id
        JOIN lotes l             ON l.id = spl.lote_id
        JOIN locais loc          ON loc.id = spl.local_id
        LEFT JOIN marcas ma      ON ma.id = l.marca_id
        LEFT JOIN fornecedores fo ON fo.id = l.fornecedor_id
        LEFT JOIN usuarios ur    ON ur.id = l.recebido_por
       WHERE spl.sessao_id = ANY(v_ids)
         AND sp.empresa_id = p_empresa_id
       -- COALESCE, não `lote_grupo_id` puro: lote sem grupo tem a coluna nula, e
       -- agrupar por nulo juntaria recebimentos diferentes numa linha só.
       GROUP BY sp.id, sp.codigo, i.id, i.nome, i.codigo, i.unidade_medida,
                COALESCE(l.lote_grupo_id, l.id)
      HAVING COALESCE(SUM(spl.consumo_real), 0) > 0
    ) x;

  -- ── Desenforma: os dias, sem os descartes ─────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'sessao_codigo', sp.codigo,
           'data_desenforma', pt.data_desenforma,
           'validade', pt.validade,
           'formas', pt.formas
         ) ORDER BY pt.data_desenforma, sp.codigo)
    INTO v_desenf
    FROM pos_producao_partes pt
    JOIN pos_producao pp ON pp.id = pt.pos_id
    JOIN sessoes_producao sp ON sp.id = pp.sessao_id
   WHERE pp.sessao_id = ANY(v_ids)
     AND pp.empresa_id = p_empresa_id
     AND pt.validade = p_validade;

  -- ── O que este dossiê NÃO consegue provar ─────────────────
  -- Sessão sem insumo rastreado é o caso das produções registradas em atraso,
  -- quando os sacos foram pegos sem passar pelo sistema. Dizer isso em texto é
  -- melhor do que entregar uma tabela vazia que parece defeito de tela.
  SELECT jsonb_agg(format(
           'A sessão %s não tem rastreabilidade de insumo: os lotes usados não '
           'foram registrados no sistema no dia da produção.', sp.codigo)
         ORDER BY sp.codigo)
    INTO v_avisos
    FROM sessoes_producao sp
   WHERE sp.id = ANY(v_ids)
     AND sp.empresa_id = p_empresa_id
     AND NOT EXISTS (
       SELECT 1 FROM sessoes_producao_locais spl
        WHERE spl.sessao_id = sp.id AND COALESCE(spl.consumo_real, 0) > 0);

  RETURN jsonb_build_object(
    'ok', true,
    'validade', p_validade,
    'produto', v_produto,
    'lotes', COALESCE(v_lotes, '[]'::JSONB),
    'sessoes', COALESCE(v_sessoes, '[]'::JSONB),
    'insumos', COALESCE(v_insumos, '[]'::JSONB),
    'desenforma', COALESCE(v_desenf, '[]'::JSONB),
    'avisos', COALESCE(v_avisos, '[]'::JSONB),
    'emitido_em', NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION dossie_rastreabilidade(UUID, DATE, UUID) IS
  'O caminho inteiro de volta: da validade de um produto até a nota fiscal do '
  'insumo, com a ficha técnica na versão usada. Um dossiê por data e produto.';

-- MEDIDO na 092: qualquer CREATE OR REPLACE VIEW apaga o security_invoker, não
-- só o DROP+CREATE. Sem isto, a view ignora o RLS.
ALTER VIEW v_calendario_validades SET (security_invoker = true);

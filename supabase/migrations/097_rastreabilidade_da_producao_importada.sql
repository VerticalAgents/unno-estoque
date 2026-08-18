-- ============================================================
-- Migration 097 — O passado aparece no calendário de validades
--
-- A 096 deixou a produção anterior ao sistema entrar como registro, sem tocar
-- no estoque. Ficou um buraco: o calendário da rastreabilidade é montado a
-- partir dos lotes de produto, e sessão importada não gera lote. Resultado —
-- os dias importados simplesmente não existiam naquela tela.
--
-- E não existir é pior do que existir vazio. Quem abre a rastreabilidade num
-- dia de julho e não vê nada não sabe se a fábrica não produziu ou se o
-- sistema não sabe. O dossiê já tinha o texto certo para o segundo caso — só
-- nunca chegava a ser chamado.
--
-- O LOTE HISTÓRICO. Um lote por produto por dia importado, com a validade
-- calculada pelo prazo do produto, quantidade produzida igual à informada e
-- ZERO DISPONÍVEL, status `esgotado`. O zero é o ponto: este brownie foi
-- vendido meses atrás. As duas telas que mexem com estoque de produto filtram
-- por `status = 'ativo'` e por disponível maior que zero (conferido em
-- ProdutosEstoquePage e NovaExpedicaoPage), então o lote histórico aparece na
-- rastreabilidade e em lugar nenhum que conte estoque.
--
-- POR QUE UM GATILHO E NÃO UM PEDAÇO NOVO DA `importar_producao_historica`.
-- O lote tem de nascer tanto na importação de amanhã quanto nos 17 dias que já
-- foram lançados. Um gatilho no SKU cobre os dois com uma regra só, em vez de
-- duas cópias da mesma lógica que vão divergir na primeira manutenção.
-- ============================================================

-- ── O lote histórico ────────────────────────────────────────
CREATE OR REPLACE FUNCTION lote_historico_da_sessao_importada()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sessao  RECORD;
  v_produto RECORD;
BEGIN
  SELECT s.id, s.empresa_id, s.data_producao, s.importada
    INTO v_sessao
    FROM sessoes_producao s
   WHERE s.id = NEW.sessao_id;

  IF NOT COALESCE(v_sessao.importada, false) THEN
    RETURN NEW;                       -- produção de verdade faz o seu lote na pós
  END IF;

  SELECT p.id, p.validade_dias
    INTO v_produto
    FROM produtos p
   WHERE p.ficha_tecnica_id = NEW.ficha_tecnica_id
     AND p.empresa_id = v_sessao.empresa_id
   LIMIT 1;

  -- Sem produto cadastrado ou sem prazo de validade não há data para pendurar
  -- no calendário. Segue sem lote: melhor o dia faltar do que inventar validade.
  IF v_produto.id IS NULL OR COALESCE(v_produto.validade_dias, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO lotes_produto (
    empresa_id, codigo, produto_id, sessao_id, data_producao, validade,
    quantidade_produzida, quantidade_disponivel, status
  ) VALUES (
    v_sessao.empresa_id,
    gerar_proximo_codigo(v_sessao.empresa_id, 'lotes_produto', 'LPROD'),
    v_produto.id,
    v_sessao.id,
    v_sessao.data_producao,
    v_sessao.data_producao + v_produto.validade_dias,
    COALESCE(NEW.quantidade_produzida, 0),
    0,                                -- vendido há meses: nada disponível
    'esgotado'
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION lote_historico_da_sessao_importada IS
  'Cria o lote de produto de uma sessão importada: validade pelo prazo do '
  'produto, zero disponível, status esgotado. Serve para o dia aparecer no '
  'calendário da rastreabilidade sem entrar em nenhuma conta de estoque.';

DROP TRIGGER IF EXISTS trg_lote_historico ON sessoes_producao_skus;
CREATE TRIGGER trg_lote_historico
  AFTER INSERT ON sessoes_producao_skus
  FOR EACH ROW
  EXECUTE FUNCTION lote_historico_da_sessao_importada();

-- ── Os dias que já entraram ─────────────────────────────────
-- Em laço, não em INSERT..SELECT: `gerar_proximo_codigo` conta de um em um e
-- precisa ser chamada uma vez por lote.
DO $$
DECLARE
  v_sku     RECORD;
  v_produto RECORD;
BEGIN
  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id, sk.quantidade_produzida,
           s.id AS sessao_id, s.empresa_id, s.data_producao
      FROM sessoes_producao_skus sk
      JOIN sessoes_producao s ON s.id = sk.sessao_id
     WHERE s.importada
       AND NOT EXISTS (
         SELECT 1
           FROM lotes_produto lp
           JOIN produtos p ON p.id = lp.produto_id
          WHERE lp.sessao_id = s.id
            AND p.ficha_tecnica_id = sk.ficha_tecnica_id)
     ORDER BY s.data_producao, sk.id
  LOOP
    SELECT p.id, p.validade_dias INTO v_produto
      FROM produtos p
     WHERE p.ficha_tecnica_id = v_sku.ficha_tecnica_id
       AND p.empresa_id = v_sku.empresa_id
     LIMIT 1;

    CONTINUE WHEN v_produto.id IS NULL OR COALESCE(v_produto.validade_dias, 0) <= 0;

    INSERT INTO lotes_produto (
      empresa_id, codigo, produto_id, sessao_id, data_producao, validade,
      quantidade_produzida, quantidade_disponivel, status
    ) VALUES (
      v_sku.empresa_id,
      gerar_proximo_codigo(v_sku.empresa_id, 'lotes_produto', 'LPROD'),
      v_produto.id,
      v_sku.sessao_id,
      v_sku.data_producao,
      v_sku.data_producao + v_produto.validade_dias,
      COALESCE(v_sku.quantidade_produzida, 0),
      0,
      'esgotado'
    );
  END LOOP;
END $$;

-- ── Apagar uma importação continua possível ─────────────────
-- `lotes_produto.sessao_id` é NO ACTION: com lote pendurado, o DELETE da 096
-- passaria a falhar com erro de chave estrangeira. O lote histórico sai junto.
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

  -- Lote histórico nasce com zero disponível e nunca deveria ser expedido. Se
  -- foi, apagar deixaria a expedição apontando para o nada.
  IF EXISTS (SELECT 1
               FROM expedicoes_itens ei
               JOIN lotes_produto lp ON lp.id = ei.lote_produto_id
              WHERE lp.sessao_id = p_sessao_id) THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Esta produção tem lote já usado numa expedição. Cancele a expedição antes.');
  END IF;

  DELETE FROM lotes_produto    WHERE sessao_id = p_sessao_id;
  DELETE FROM sessoes_producao WHERE id = p_sessao_id;   -- SKUs saem em cascata

  RETURN jsonb_build_object('ok', true, 'codigo', v_codigo);
END;
$$;

COMMENT ON FUNCTION remover_producao_importada IS
  'Apaga uma sessão de produção importada, seus SKUs e o lote histórico. '
  'Recusa sessão real e recusa lote já expedido.';

-- ── O dossiê diz de qual ausência se trata ──────────────────
-- Definição extraída do banco (`pg_get_functiondef`), que já traz a 094 em
-- cima da 093. Única mudança: o bloco de avisos.

CREATE OR REPLACE FUNCTION public.dossie_rastreabilidade(p_empresa_id uuid, p_validade date, p_produto_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_produto   JSONB;
  v_lotes     JSONB;
  v_sessoes   JSONB;
  v_insumos   JSONB;
  v_desenf    JSONB;
  v_resumo    JSONB;
  v_descartes JSONB;
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

  -- ── Desenforma: cada dia, com o que quebrou nele ──────────
  SELECT jsonb_agg(jsonb_build_object(
           'sessao_codigo', sp.codigo,
           'data_desenforma', pt.data_desenforma,
           'validade', pt.validade,
           'formas', pt.formas,
           'no_forno', pt.formas * COALESCE(fv.rendimento_fornada, 0),
           'descartadas', dq.q,
           'aproveitadas', GREATEST(pt.formas * COALESCE(fv.rendimento_fornada, 0) - dq.q, 0)
         ) ORDER BY pt.data_desenforma, sp.codigo)
    INTO v_desenf
    FROM pos_producao_partes pt
    JOIN pos_producao pp ON pp.id = pt.pos_id
    JOIN sessoes_producao sp ON sp.id = pp.sessao_id
    JOIN sessoes_producao_skus sk ON sk.id = pt.sessao_sku_id
    LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(d.quantidade), 0)::INTEGER AS q
        FROM pos_producao_descartes d WHERE d.parte_id = pt.id
    ) dq
   WHERE pp.sessao_id = ANY(v_ids)
     AND pp.empresa_id = p_empresa_id
     AND pt.validade = p_validade;

  -- ── O resumo que abre o dossiê ────────────────────────────
  -- Recorte pela validade: `aproveitadas` fecha com a soma dos lotes listados,
  -- e a conta pode ser refeita na frente de quem audita.
  SELECT jsonb_build_object(
           'formas', COALESCE(SUM(pt.formas), 0),
           'no_forno', COALESCE(SUM(pt.formas * COALESCE(fv.rendimento_fornada, 0)), 0),
           'descartadas', COALESCE(SUM(dq.q), 0),
           'aproveitadas', GREATEST(
             COALESCE(SUM(pt.formas * COALESCE(fv.rendimento_fornada, 0)), 0)
             - COALESCE(SUM(dq.q), 0), 0),
           'perda_pct', CASE
             WHEN COALESCE(SUM(pt.formas * COALESCE(fv.rendimento_fornada, 0)), 0) > 0
               THEN ROUND(COALESCE(SUM(dq.q), 0)::NUMERIC * 100
                          / SUM(pt.formas * COALESCE(fv.rendimento_fornada, 0)), 2)
             ELSE 0
           END)
    INTO v_resumo
    FROM pos_producao_partes pt
    JOIN pos_producao pp ON pp.id = pt.pos_id
    JOIN sessoes_producao_skus sk ON sk.id = pt.sessao_sku_id
    LEFT JOIN fichas_tecnicas_versoes fv ON fv.id = sk.ficha_versao_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(d.quantidade), 0)::INTEGER AS q
        FROM pos_producao_descartes d WHERE d.parte_id = pt.id
    ) dq
   WHERE pp.sessao_id = ANY(v_ids)
     AND pp.empresa_id = p_empresa_id
     AND pt.validade = p_validade;

  -- O porquê de cada unidade perdida, que é o que a pergunta seguinte do
  -- auditor sempre é.
  SELECT jsonb_agg(jsonb_build_object('motivo', m.nome, 'quantidade', s.q)
                   ORDER BY s.q DESC, m.nome)
    INTO v_descartes
    FROM (
      SELECT d.motivo_id, SUM(d.quantidade)::INTEGER AS q
        FROM pos_producao_descartes d
        JOIN pos_producao_partes pt ON pt.id = d.parte_id
        JOIN pos_producao pp        ON pp.id = pt.pos_id
       WHERE pp.sessao_id = ANY(v_ids)
         AND pp.empresa_id = p_empresa_id
         AND pt.validade = p_validade
       GROUP BY d.motivo_id
    ) s
    JOIN motivos_descarte m ON m.id = s.motivo_id;

  -- ── O que este dossiê NÃO consegue provar ─────────────────
  -- Sessão sem insumo rastreado é o caso das produções registradas em atraso,
  -- quando os sacos foram pegos sem passar pelo sistema. Dizer isso em texto é
  -- melhor do que entregar uma tabela vazia que parece defeito de tela.
  -- Duas ausências diferentes, dois textos. "Não registraram o insumo naquele
  -- dia" é um furo de operação; "esta produção é anterior ao sistema" é uma
  -- época inteira que nunca teve o que registrar. Quem lê o dossiê precisa
  -- saber de qual dos dois se trata.
  SELECT jsonb_agg(a.msg ORDER BY a.codigo)
    INTO v_avisos
    FROM (
      SELECT sp.codigo,
             CASE WHEN sp.importada THEN
               format('A sessão %s é produção anterior ao sistema: foi lançada '
                      'como registro histórico, e o número de unidades é o que '
                      'a fábrica tinha anotado. Não existe lote de insumo, '
                      'pesagem de balde nem desenforma para mostrar — este dia '
                      'foi produzido antes de o sistema existir.', sp.codigo)
             ELSE
               format('A sessão %s não tem rastreabilidade de insumo: os lotes '
                      'usados não foram registrados no sistema no dia da '
                      'produção.', sp.codigo)
             END AS msg
        FROM sessoes_producao sp
       WHERE sp.id = ANY(v_ids)
         AND sp.empresa_id = p_empresa_id
         AND NOT EXISTS (
           SELECT 1 FROM sessoes_producao_locais spl
            WHERE spl.sessao_id = sp.id AND COALESCE(spl.consumo_real, 0) > 0)
    ) a;

  RETURN jsonb_build_object(
    'ok', true,
    'validade', p_validade,
    'produto', v_produto,
    'resumo', COALESCE(v_resumo, '{}'::JSONB),
    'descartes', COALESCE(v_descartes, '[]'::JSONB),
    'lotes', COALESCE(v_lotes, '[]'::JSONB),
    'sessoes', COALESCE(v_sessoes, '[]'::JSONB),
    'insumos', COALESCE(v_insumos, '[]'::JSONB),
    'desenforma', COALESCE(v_desenf, '[]'::JSONB),
    'avisos', COALESCE(v_avisos, '[]'::JSONB),
    'emitido_em', NOW()
  );
END;
$function$
;

-- ============================================================
-- Migration 105 — a porcao conta para todo insumo que passa por reembalagem
--
-- `planejar_recipientes` so media em porcoes o insumo marcado `porcionado`.
-- O doce de leite e `escolher`, porque tem dois destinos na mesma receita, e
-- por isso caia no modelo padrao do insumo: o planejador dizia "2 baldes de
-- 4,8 kg" para um topping que mora em 44 saquinhos de 200 g dentro de uma
-- caixa.
--
-- Passa a valer o criterio que descreve o fato: o insumo PASSA POR REEMBALAGEM
-- e tem tamanho de porcao configurado. Como isso ja e o que define `porcionado`
-- tambem, nenhum insumo muda de comportamento por engano -- so entram os que
-- tinham porcao e estavam de fora por causa do modo.
--
-- E o principio da 074: para insumo porcionado conta-se PORCAO, que e a unidade
-- que existe na mao de quem esta na bancada.
--
-- Partiu de `pg_get_functiondef`, ja com a 103 dentro -- ver CLAUDE.md.
-- ============================================================

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
             -- Vale para todo insumo que PASSA POR REEMBALAGEM, e nao so para
             -- os marcados 'porcionado'. O doce de leite e 'escolher', porque
             -- tem dois destinos: parte vai para o saco de confeitar, parte vai
             -- do balde direto para a massa. Exigir 'porcionado' fazia o
             -- planejador medir o topping em baldes de 4,8 kg -- quando o que a
             -- pessoa conta na bancada e saquinho de 200 g.
             --
             -- E o principio da migration 074: para insumo porcionado, conta-se
             -- PORCAO, que e a unidade que existe na mao de quem trabalha.
             WHEN NOT COALESCE(c.passa_reembalagem, false) THEN NULL
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

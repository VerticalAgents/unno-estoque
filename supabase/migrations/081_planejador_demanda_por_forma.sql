-- ============================================================
-- Migration 081 — Planejador: desfaz a regressão de 60× na demanda
--
-- Com 44 formas de brownie o planejador pedia 1.445 recipientes e 1.175 kg de
-- farinha. O certo é 19,6 kg e 4 recipientes.
--
-- CAUSA: a migration 074 reescreveu `planejar_recipientes` partindo do texto da
-- 028, e não da versão que estava no ar (a 031). Duas coisas voltaram atrás:
--
--   1. `SUM(it.quantidade * v.rendimento_fornada * p.formas)`. A 029 já tinha
--      removido esse fator, e o comentário dela descreve o mesmo sintoma de
--      agora: "o planejador pedir 1.810 potes de açúcar para 44 formas".
--      `fichas_tecnicas_itens.quantidade` é consumo POR FORMA, não por unidade
--      produzida — multiplicar pelo rendimento conta cada forma 60 vezes.
--
--   2. `ORDER BY i.codigo` virou `ORDER BY qtd DESC`. A 031 tinha ordenado por
--      código porque é essa a ordem em que os recipientes são conferidos na
--      prática, e é o que mantém tela e folha impressa iguais.
--
-- O que a 074 acrescentou de propósito fica: a CTE `porcao`, o conteúdo dos
-- recipientes e o cálculo de `recipientes_atuais` por porção para o insumo
-- porcionado (caixa de sacos).
--
-- A tela e o PDF já se contradiziam e apontavam o culpado: na linha do Óleo, a
-- coluna DEMANDA dizia 1.118,7 kg e a nota logo abaixo, "18,645 para a
-- produção". São RPCs diferentes — a nota vem de
-- `sugerir_lotes_transferencia`, que nunca deixou de usar `quantidade * formas`.
--
-- Nada de dado foi corrompido: esta função é STABLE, só lê.
--
-- LIÇÃO (vale para toda função já existente): antes de `CREATE OR REPLACE`,
-- parta de `pg_get_functiondef` da versão que está NO BANCO, nunca do texto de
-- uma migration antiga. Migrations são camadas — reescrever a partir da 028
-- desfaz a 029 e a 031 em silêncio.
-- ============================================================

CREATE OR REPLACE FUNCTION planejar_recipientes(p_empresa_id uuid, p_plano jsonb)
 RETURNS TABLE(insumo_id uuid, codigo text, nome text, unidade text, recipiente_modelo text, capacidade numeric, demanda numeric, demanda_com_folga numeric, recipientes_atuais integer, recipientes_necessarios integer, faltam integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER
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
  -- `quantidade` é o consumo POR FORMA (migration 029). Multiplicar também
  -- pelo rendimento conta cada forma 60 vezes.
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           SUM(it.quantidade * p.formas) AS qtd
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
  -- Ordem do código (migration 031): é a ordem em que os recipientes são
  -- conferidos na prática, e mantém tela e folha impressa iguais.
  ORDER BY b.codigo;
END;
$function$;

COMMENT ON FUNCTION planejar_recipientes(uuid, jsonb) IS
  'Quantos recipientes cada insumo precisa para um plano de formas. Demanda = '
  'quantidade da ficha (POR FORMA) x formas; nunca multiplicar pelo rendimento.';

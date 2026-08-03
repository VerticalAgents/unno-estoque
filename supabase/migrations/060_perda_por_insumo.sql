-- ============================================================
-- Migration 060 — Perda por insumo, não só a da sessão inteira
--
-- POR QUE
-- `sessoes_producao.fator_perda_insumos` mistura tudo numa porcentagem só.
-- Mas 3% de perda em chocolate em pó e 3% em farinha de trigo custam coisas
-- muito diferentes: a média esconde justamente o que importa para o custo do
-- produto. Sem abrir por insumo não dá para saber onde o dinheiro escapa.
--
-- COMO
-- Uma VIEW, não uma coluna nova. O consumo real e o teórico já ficam gravados
-- linha a linha em `sessoes_producao_locais` no fechamento (036) — guardar a
-- porcentagem outra vez seria criar um número que pode divergir da conta que
-- o originou. Aqui ela é sempre derivada do que foi medido.
--
-- Sem custo por enquanto: `insumos` não tem preço cadastrado. Quando tiver,
-- basta multiplicar `desvio` pelo preço — a view já entrega a quantidade
-- perdida em unidade de medida, que é a parte difícil.
-- ============================================================

CREATE OR REPLACE VIEW v_perda_por_insumo AS
SELECT
  s.empresa_id,
  s.id                     AS sessao_id,
  s.codigo                 AS sessao_codigo,
  s.data_producao,
  i.id                     AS insumo_id,
  i.codigo                 AS insumo_codigo,
  i.nome                   AS insumo_nome,
  i.unidade_medida,
  cat.nome                 AS categoria,
  cat.cor_hex              AS categoria_cor,
  ROUND(SUM(spl.consumo_teorico), 3)                       AS teorico,
  ROUND(SUM(spl.consumo_real), 3)                          AS consumido,
  -- Positivo = gastou mais do que a ficha previa. É a perda.
  ROUND(SUM(spl.consumo_real) - SUM(spl.consumo_teorico), 3) AS desvio,
  ROUND(
    ((SUM(spl.consumo_real) - SUM(spl.consumo_teorico))
      / NULLIF(SUM(spl.consumo_teorico), 0)) * 100, 2)     AS perda_pct
FROM sessoes_producao s
JOIN sessoes_producao_locais spl ON spl.sessao_id = s.id
JOIN insumos i                   ON i.id = spl.insumo_id
LEFT JOIN categorias_insumo cat  ON cat.id = i.categoria_id
WHERE s.status = 'fechada'
  AND spl.consumo_real IS NOT NULL
GROUP BY s.empresa_id, s.id, s.codigo, s.data_producao,
         i.id, i.codigo, i.nome, i.unidade_medida, cat.nome, cat.cor_hex
HAVING SUM(spl.consumo_teorico) > 0;

-- Sem isto a view nasce legível sem login: ela roda com as permissões de quem
-- a criou e ignora o RLS das tabelas. Ver migration 050.
ALTER VIEW v_perda_por_insumo SET (security_invoker = true);

COMMENT ON VIEW v_perda_por_insumo IS
  'Perda de cada insumo em cada sessão fechada: teórico, consumido, desvio na '
  'unidade de medida e percentual. Derivada de sessoes_producao_locais.';

-- ============================================================
-- Migration 064 — A perda de insumo agora sai da auditoria
--
-- A 060 criou `v_perda_por_insumo` ancorada em SESSÃO: comparava o consumo
-- pesado com o teórico. Com a 063 o fechamento passou a dar baixa PELO
-- teórico, então real e teórico viraram o mesmo número e aquela view mostraria
-- 0% para sempre. Sai de cena.
--
-- No lugar, a contagem física — que já registra `qtd_teorica` e `qtd_fisica`
-- por insumo desde a 019. A diferença entre as duas É a perda do período
-- entre duas auditorias. Não é conta nova: é ler o que já se mede.
--
-- View, não coluna: guardar a porcentagem outra vez criaria um número capaz de
-- divergir da conta que o originou.
--
-- EP e EC medem coisas diferentes e não devem ser somados. A auditoria do
-- estoque PRODUTIVO mede a perda de produção; a do CENTRAL, a do armazém.
-- Por isso `tipo` vem na view, para a tela separar.
-- ============================================================

DROP VIEW IF EXISTS v_perda_por_insumo;

CREATE OR REPLACE VIEW v_perda_auditoria AS
SELECT
  c.empresa_id,
  c.id                                              AS contagem_id,
  c.tipo,
  COALESCE(c.aplicada_at, c.finalizada_at, c.created_at)::DATE AS data,
  i.id                                              AS insumo_id,
  i.codigo                                          AS insumo_codigo,
  i.nome                                            AS insumo_nome,
  i.unidade_medida,
  cat.nome                                          AS categoria,
  cat.cor_hex                                       AS categoria_cor,
  ROUND(ci.qtd_teorica, 3)                          AS teorico,
  ROUND(ci.qtd_fisica, 3)                           AS fisico,
  -- Positivo = faltou no estoque, ou seja, perdeu-se pelo caminho.
  ROUND(ci.qtd_teorica - ci.qtd_fisica, 3)          AS perda,
  ROUND(
    ((ci.qtd_teorica - ci.qtd_fisica) / NULLIF(ci.qtd_teorica, 0)) * 100, 2
  )                                                 AS perda_pct
FROM contagens c
JOIN contagem_insumos ci        ON ci.contagem_id = c.id
JOIN insumos i                  ON i.id = ci.insumo_id
LEFT JOIN categorias_insumo cat ON cat.id = i.categoria_id
WHERE c.status = 'aplicada'
  AND ci.qtd_fisica IS NOT NULL;

-- Sem isto a view nasce legível sem login: roda com as permissões de quem a
-- criou e ignora o RLS das tabelas. Ver migration 050.
ALTER VIEW v_perda_auditoria SET (security_invoker = true);

COMMENT ON VIEW v_perda_auditoria IS
  'Perda por insumo apurada em cada auditoria aplicada: teórico, físico, '
  'diferença na unidade de medida e percentual. EP mede a perda de produção; '
  'EC, a do armazém — não somar os dois.';

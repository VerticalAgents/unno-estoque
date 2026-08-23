-- ============================================================
-- Migration 104 — os números do topping de doce de leite (dados da Mischa)
--
-- Estrutura fica em migration; dado de cliente, em arquivo próprio. É a mesma
-- separação que a 076 fez com o porcionamento, e pelo mesmo motivo: os códigos
-- de insumo e de ficha são gerados POR EMPRESA, então um `WHERE codigo = ...`
-- sem filtro de empresa reescreveria a receita de outro cliente que tivesse um
-- FT-002 qualquer.
--
-- Dois números, os dois confirmados pelo Lucca em 23/08/2026:
--
--   FT-002 (Brownie Doce de Leite) — 200 g por forma saem do saco de confeitar,
--   para o topping. Os outros 558,9 g vão do balde direto para a massa.
--
--   FT-001 (Brownie Tradicional) — NÃO tem topping. Os 278,3 g vão inteiros
--   para a massa, do pote. Fica sem o campo, que é o comportamento padrão.
--
-- E a descrição do porcionamento dizia "sacos de confeitar 600g", número que
-- nunca foi verdade — a porção configurada sempre foi 200 g, e é 200 g que sai
-- por forma. O texto errado já tinha sido corrigido uma vez nos números
-- (migration 074) e sobreviveu na descrição.
-- ============================================================

DO $$
DECLARE
  v_empresa   UUID;
  v_insumo    UUID;
  v_linhas    INTEGER;
BEGIN
  FOR v_empresa IN SELECT id FROM empresas
  LOOP
    SELECT id INTO v_insumo
      FROM insumos
     WHERE empresa_id = v_empresa AND codigo = 'INS014' AND nome ILIKE '%doce de leite%';

    CONTINUE WHEN v_insumo IS NULL;

    -- O topping do brownie de doce de leite: um saco de 200 g por forma.
    UPDATE fichas_tecnicas_itens it
       SET quantidade_porcionada = 0.200
      FROM fichas_tecnicas_versoes v
      JOIN fichas_tecnicas f ON f.id = v.ficha_id
     WHERE it.versao_id = v.id
       AND f.empresa_id = v_empresa
       AND f.codigo = 'FT-002'
       AND it.insumo_id = v_insumo;

    GET DIAGNOSTICS v_linhas = ROW_COUNT;
    RAISE NOTICE 'empresa %: % linha(s) de FT-002 com topping de 200 g', v_empresa, v_linhas;

    -- A descrição que falava em 600 g. A porção real é a que já está no campo.
    UPDATE insumos_armazenamento_config
       SET destino_multiplo_descricao =
             'Parte do balde vai direto para a massa. Outra parte é porcionada '
             || 'em sacos de confeitar de 200 g, um por forma, para o topping.'
     WHERE insumo_id = v_insumo;
  END LOOP;
END $$;

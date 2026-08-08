-- ============================================================
-- Migration 076 — Dados de porcionamento da Mischa's Bakery
--
-- Este arquivo saiu de dentro da migration 074, e o motivo importa.
--
-- A 074 trazia `WHERE i.codigo = 'INS027'` e capacidades de 3,0 e 4,8 kg — os
-- dados de UM cliente — e **sem filtro de empresa**. O banco é multi-tenant e
-- os códigos de insumo são gerados por empresa: outro cliente com um INS027,
-- que para ele pode ser fermento, teria a porção reescrita ao rodar a
-- migration. Hoje não doeu porque só existe uma empresa; num SaaS, doeria.
--
-- Estrutura fica em migration; dado de cliente fica aqui, escopado por
-- `empresa_id`, no molde do 026_dados_odara.sql.
--
-- O que este arquivo faz, tudo idempotente:
--   1. Corrige as porções que estavam erradas no cadastro (confirmado com o
--      usuário em 08/08/2026): Nutella 625 → 750 g, Doce de Leite 600 → 200 g
--   2. Cria a caixa onde os sacos cheios ficam, uma por insumo porcionado
--   3. Desativa os 15 sacos de confeitar cadastrados um a um
-- ============================================================

DO $$
DECLARE
  v_empresa_id UUID;
BEGIN
  SELECT id INTO v_empresa_id FROM empresas WHERE nome = 'Mischa''s Bakery' LIMIT 1;

  IF v_empresa_id IS NULL THEN
    RAISE NOTICE 'Empresa não encontrada — nada a fazer.';
    RETURN;
  END IF;

  -- 1. As porções certas ------------------------------------------------
  UPDATE insumos_armazenamento_config c
     SET reembalagem_tamanho_porcao = v.porcao, reembalagem_unidade = 'g'
    FROM insumos i,
         (VALUES ('INS027', 750.000), ('INS014', 200.000)) AS v(codigo, porcao)
   WHERE i.id = c.insumo_id
     AND i.empresa_id = v_empresa_id
     AND i.codigo = v.codigo;

  -- 2. A caixa de cada insumo porcionado ---------------------------------
  -- Capacidade = o que sai de UM pacote: o balde de Nutella (3 kg) vira 4 sacos
  -- de 750 g; o de Doce de Leite (4,8 kg) vira 24 de 200 g.
  INSERT INTO locais (
    empresa_id, nome, tipo, subtipo, insumo_id,
    capacidade_max, unidade_capacidade, qr_code_fixo, ativo, observacoes
  )
  SELECT i.empresa_id,
         'Caixa de sacos · ' || i.nome,
         'estoque_produtivo',
         'saco_confeitar',
         i.id,
         v.capacidade,
         i.unidade_medida,
         'QR-EP-CAIXA-' || i.codigo,
         true,
         'Caixa onde ficam os sacos de confeitar cheios. O saco é descartável e '
         || 'não se cadastra; quantos há dentro é o conteúdo dividido pela porção.'
    FROM insumos i
    JOIN (VALUES ('INS027', 3.000), ('INS014', 4.800)) AS v(codigo, capacidade)
      ON v.codigo = i.codigo
   WHERE i.empresa_id = v_empresa_id
     AND NOT EXISTS (
       SELECT 1 FROM locais l
        WHERE l.empresa_id = v_empresa_id
          AND l.qr_code_fixo = 'QR-EP-CAIXA-' || i.codigo
     );

  -- 3. Os 15 sacos avulsos saem de cena ----------------------------------
  -- Desativar e não excluir: `movimentacoes_itens` aponta para eles.
  UPDATE locais l
     SET ativo = false, updated_at = now(),
         observacoes = COALESCE(l.observacoes || ' · ', '')
                       || 'Desativado: o saco de confeitar é descartável e deixou '
                       || 'de ser cadastrado um a um.'
   WHERE l.empresa_id = v_empresa_id
     AND l.tipo = 'estoque_produtivo'
     AND l.subtipo = 'saco_confeitar'
     AND l.ativo
     AND l.qr_code_fixo NOT LIKE 'QR-EP-CAIXA-%'
     AND NOT EXISTS (
       SELECT 1 FROM locais_lotes ll WHERE ll.local_id = l.id AND ll.quantidade > 0
     );
END $$;

-- ============================================================
-- Migration 088 — A pós-produção acerta o lote do produto
--
-- O DEFEITO, encontrado no primeiro uso real. O lote de produto nasce no
-- FECHAMENTO da sessão, com a quantidade planejada menos as perdas de
-- processo. Os descartes da desenforma só aparecem depois, na pós-produção —
-- e é ali que se descobre o que quebrou, o que saiu fora do padrão, o que caiu.
--
-- `registrar_pos_producao` atualizava `sessoes_producao_skus` com o número
-- certo e não encostava em `lotes_produto`. A sessão passava a dizer 1.438
-- unidades boas enquanto o lote seguia oferecendo 1.440 para a expedição.
--
-- Duas unidades no primeiro dia. Mas quebrar brownie na desenforma não é
-- exceção, é rotina: sem este acerto o estoque de produto acabado só se
-- distancia da prateleira, e a diferença sai pela expedição — que é o pior
-- lugar para descobrir que a unidade não existe.
--
-- COMO. O ajuste é por DIFERENÇA, não por atribuição: `quantidade_disponivel`
-- pode já ter sido reduzida por uma expedição, e sobrescrevê-la apagaria a
-- saída. Aplicando o delta, a função continua idempotente — registrar a
-- pós-produção de novo com outros números acerta em vez de acumular.
--
-- O `status` segue a convenção da expedição (018): vira 'esgotado' quando o
-- disponível chega a zero.
-- ============================================================

CREATE OR REPLACE FUNCTION registrar_pos_producao(
  p_empresa_id     UUID,
  p_sessao_id      UUID,
  p_responsavel_id UUID,
  p_descartes      JSONB,
  p_observacoes    TEXT DEFAULT NULL,
  p_data           DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_pos_id UUID;
  v_item   JSONB;
  v_qtd    INTEGER;
  v_sku    RECORD;
  v_n      INTEGER := 0;
  v_nova   INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessoes_producao
                  WHERE id = p_sessao_id AND empresa_id = p_empresa_id
                    AND status = 'fechada') THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'A sessão precisa estar fechada para registrar a pós-produção.');
  END IF;

  INSERT INTO pos_producao (empresa_id, sessao_id, data, responsavel_id, observacoes)
  VALUES (p_empresa_id, p_sessao_id, COALESCE(p_data, CURRENT_DATE),
          p_responsavel_id, p_observacoes)
  ON CONFLICT (sessao_id) DO UPDATE
     SET data = EXCLUDED.data,
         responsavel_id = EXCLUDED.responsavel_id,
         observacoes = EXCLUDED.observacoes,
         updated_at = NOW()
  RETURNING id INTO v_pos_id;

  DELETE FROM pos_producao_descartes WHERE pos_id = v_pos_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_descartes, '[]'::JSONB)) LOOP
    v_qtd := COALESCE((v_item->>'quantidade')::INTEGER, 0);
    IF v_qtd > 0 THEN
      INSERT INTO pos_producao_descartes (pos_id, sessao_sku_id, motivo_id, quantidade)
      VALUES (v_pos_id, (v_item->>'sessao_sku_id')::UUID,
              (v_item->>'motivo_id')::UUID, v_qtd)
      ON CONFLICT (pos_id, sessao_sku_id, motivo_id)
      DO UPDATE SET quantidade = EXCLUDED.quantidade;
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- As unidades boas saem por diferença — ninguém as digita.
  FOR v_sku IN
    SELECT sk.id, sk.ficha_tecnica_id,
           COALESCE(sk.formas_assadas, sk.multiplicador, 0) AS formas,
           COALESCE(v.rendimento_fornada, 0)                AS rendimento,
           COALESCE((SELECT SUM(d.quantidade)
                       FROM pos_producao_descartes d
                      WHERE d.pos_id = v_pos_id AND d.sessao_sku_id = sk.id), 0) AS descartadas
      FROM sessoes_producao_skus sk
      LEFT JOIN fichas_tecnicas_versoes v ON v.id = sk.ficha_versao_id
     WHERE sk.sessao_id = p_sessao_id
  LOOP
    v_nova := GREATEST(v_sku.formas * v_sku.rendimento - v_sku.descartadas, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_perdida   = v_sku.descartadas,
           quantidade_produzida = v_nova
     WHERE id = v_sku.id;

    -- E o lote do produto acompanha. Por diferença, para não apagar o que uma
    -- expedição já tirou daqui.
    UPDATE lotes_produto lp
       SET quantidade_produzida  = v_nova,
           quantidade_disponivel = GREATEST(
             lp.quantidade_disponivel + (v_nova - lp.quantidade_produzida), 0),
           status = CASE
             WHEN GREATEST(lp.quantidade_disponivel + (v_nova - lp.quantidade_produzida), 0) <= 0
               THEN 'esgotado'::status_lote_produto_enum
             ELSE lp.status
           END
      FROM produtos pr
     WHERE pr.id = lp.produto_id
       AND lp.sessao_id = p_sessao_id
       AND pr.ficha_tecnica_id = v_sku.ficha_tecnica_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'pos_id', v_pos_id, 'descartes', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_pos_producao(UUID, UUID, UUID, JSONB, TEXT, DATE) IS
  'Registra a desenforma: os descartes por motivo, as unidades boas por '
  'diferença, e o acerto do lote de produto — que nasce no fechamento com o '
  'planejado e só aqui descobre o que quebrou.';

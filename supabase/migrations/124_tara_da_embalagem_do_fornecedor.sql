-- ============================================================
-- Migration 124 — a tara da embalagem do fornecedor
--
-- O LUCCA VIU, em 28/09/2026: o fechamento da SESS-0044 gravou a garrafa de
-- baunilha com 151 ml, e 45 g eram da garrafa. A glucose ficou 360 g acima, o
-- balde de doce de leite 160 g. (Corrigido à mão no MOV-1048.)
--
-- O pote da cozinha tem tara no cadastro (`locais.peso_tara`) e o
-- reabastecimento e a contagem a descontam. A embalagem do fornecedor nascia
-- com tara 0 — e a tela do reabastecimento ainda dizia "não precisa descontar
-- o peso da embalagem".
--
-- A tara passa a ser do INSUMO (toda embalagem de glucose é o mesmo balde), em
-- `insumos_embalagem_config.tara_embalagem_g`, em gramas. Insumo em ml usa
-- 1 g = 1 ml (regra do Lucca para a baunilha). NULL = não sabemos — nunca zero.
--
-- `mover_embalagem_fornecedor` copia a tara para o recipiente efêmero que cria;
-- as efêmeras vivas recebem a tara agora. As telas passam a descontá-la.

ALTER TABLE insumos_embalagem_config
  ADD COLUMN IF NOT EXISTS tara_embalagem_g NUMERIC
  CHECK (tara_embalagem_g IS NULL OR tara_embalagem_g > 0);

COMMENT ON COLUMN insumos_embalagem_config.tara_embalagem_g IS
  'Peso da embalagem do fornecedor vazia, em gramas (ml = g). NULL = desconhecida.';

-- Pesos informados pelo Lucca em 27 e 28/09/2026.
UPDATE insumos_embalagem_config ec
   SET tara_embalagem_g = v.tara
  FROM (VALUES ('INS008', 360), ('INS010', 45), ('INS009', 2050), ('INS014', 160)) AS v(codigo, tara)
  JOIN insumos i ON i.codigo = v.codigo
 WHERE ec.insumo_id = i.id;

-- Parte do corpo em produção (pg_get_functiondef em 28/09/2026).

CREATE OR REPLACE FUNCTION public.mover_embalagem_fornecedor(p_lote_id uuid, p_responsavel_id uuid, p_empresa_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lote      lotes%ROWTYPE;
  v_insumo    insumos%ROWTYPE;
  v_modo      modo_ep_enum;
  v_subtipo   TEXT;
  v_local_id  UUID;
  v_nome      TEXT;
  v_resultado JSONB;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF v_lote.status <> 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não está ativo (status: %s).', v_lote.codigo, v_lote.status));
  END IF;

  IF COALESCE(v_lote.quantidade_disponivel, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('Lote %s não tem saldo para mover.', v_lote.codigo));
  END IF;

  SELECT * INTO v_insumo FROM insumos WHERE id = v_lote.insumo_id;

  SELECT c.modo_ep INTO v_modo
    FROM insumos_armazenamento_config c
   WHERE c.insumo_id = v_lote.insumo_id;

  IF v_modo IS NULL OR v_modo NOT IN ('embalagem_fornecedor', 'escolher') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s não é armazenado na embalagem do fornecedor. Escaneie o recipiente de destino.', v_insumo.nome));
  END IF;

  SELECT id INTO v_local_id
    FROM locais
   WHERE origem_lote_id = p_lote_id AND ativo
   LIMIT 1;

  IF v_local_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'local_id', v_local_id, 'ja_existia', true);
  END IF;

  v_subtipo := v_insumo.recipiente_subtipo;
  IF v_subtipo IS NULL OR v_subtipo NOT IN (
    'prateleira','balde','balde_fornecedor','caixa_plastica',
    'garrafa','garrafa_fornecedor','saco_confeitar','lata'
  ) THEN
    v_subtipo := 'balde_fornecedor';
  END IF;

  v_nome := v_insumo.nome || ' · ' || v_lote.codigo;

  INSERT INTO locais (
    empresa_id, nome, tipo, subtipo, insumo_id, marca_id,
    capacidade_max, unidade_capacidade, qr_code_fixo,
    origem_lote_id, efemero, ativo, observacoes,
    peso_tara
  ) VALUES (
    p_empresa_id, v_nome, 'estoque_produtivo', v_subtipo::subtipo_local_enum,
    v_lote.insumo_id, v_lote.marca_id,
    v_lote.quantidade_disponivel, v_lote.unidade,
    'QR-LOTE-' || v_lote.codigo,
    p_lote_id, true, true,
    'Embalagem do fornecedor — criada pela transferência do lote ' || v_lote.codigo,
    -- A embalagem vazia do fornecedor (migration 124): sem ela, o peso
    -- digitado no fechamento entrava com o balde junto.
    (SELECT ec.tara_embalagem_g FROM insumos_embalagem_config ec
      WHERE ec.insumo_id = v_lote.insumo_id)
  ) RETURNING id INTO v_local_id;

  v_resultado := realizar_transferencia(
    p_lote_id, v_local_id, v_lote.quantidade_disponivel,
    p_responsavel_id, p_empresa_id
  );

  IF NOT (v_resultado->>'ok')::BOOLEAN THEN
    DELETE FROM locais WHERE id = v_local_id;
    RETURN v_resultado;
  END IF;

  -- É esta chamada que resolve a embalagem do fornecedor que chega no meio
  -- do dia: sem ela o balde novo entra cheio e nunca é debitado.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, v_lote.insumo_id);

  RETURN v_resultado
    || jsonb_build_object('local_id', v_local_id, 'local_nome', v_nome,
                          'quantidade', v_lote.quantidade_disponivel);
END;
$function$;

REVOKE ALL ON FUNCTION mover_embalagem_fornecedor(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mover_embalagem_fornecedor(UUID, UUID, UUID) TO authenticated, service_role;

-- As embalagens do fornecedor que já estão na produção.
UPDATE locais l
   SET peso_tara = ec.tara_embalagem_g, updated_at = NOW()
  FROM insumos_embalagem_config ec
 WHERE ec.insumo_id = l.insumo_id
   AND l.efemero AND l.ativo
   AND COALESCE(l.peso_tara, 0) = 0
   AND ec.tara_embalagem_g IS NOT NULL;

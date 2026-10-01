-- ============================================================
-- Migration 137 — o consumo previsto não se perde mais
--
-- Na abertura, o previsto de cada insumo vira linhas em
-- sessoes_producao_locais, uma por pote da produção que tem o insumo. Quando o
-- insumo NÃO ESTÁ na produção, nenhuma linha nasce e o consumo sumia: a tela
-- avisava "transfira ovo e baunilha", e mesmo transferindo depois nada era
-- descontado (SESS-0047, 30/09/2026: ovo 7,63 kg e baunilha 534 ml).
--
-- E quando a linha existe mas o pote não tinha o bastante, a diferença só era
-- cobrada enquanto a sessão estava aberta. Fechou, sumia (SESS-0045: 1.141 ml
-- de baunilha; SESS-0046: 3,87 kg de ovo). O estoque central ficava maior que
-- o real, e a diferença aparecia depois como "perda" na pesagem.
--
-- Regra nova (Lucca, 30/09/2026):
--   · sessão aberta: o que faltou fica PENDENTE e é descontado quando o insumo
--     chegar na produção — pelos três caminhos, que já chamam
--     reaplicar_teorico_do_insumo;
--   · fechamento: o que ainda estiver pendente veio de algum lugar sem
--     registro — na prática, do estoque central — e sai de lá (embalagem
--     aberta primeiro, depois a que vence antes).
-- ============================================================

CREATE TABLE IF NOT EXISTS consumo_pendente (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id   UUID NOT NULL REFERENCES empresas(id),
  sessao_id    UUID NOT NULL REFERENCES sessoes_producao(id) ON DELETE CASCADE,
  insumo_id    UUID NOT NULL REFERENCES insumos(id),
  quantidade   NUMERIC NOT NULL CHECK (quantidade > 0),
  unidade      unidade_medida_enum NOT NULL,
  status       TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'quitado', 'baixado_ec')),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolvido_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS consumo_pendente_um_aberto
  ON consumo_pendente (sessao_id, insumo_id) WHERE status = 'aberto';

COMMENT ON TABLE consumo_pendente IS
  'Consumo previsto de uma sessão que não achou o insumo na produção. Quitado quando o insumo '
  'chega (reaplicar_teorico_do_insumo) ou baixado do estoque central no fechamento. Migration 137.';

ALTER TABLE consumo_pendente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acesso_por_empresa ON consumo_pendente;
CREATE POLICY acesso_por_empresa ON consumo_pendente FOR ALL TO authenticated
  USING (empresa_id = get_empresa_id_do_usuario())
  WITH CHECK (empresa_id = get_empresa_id_do_usuario());
DROP POLICY IF EXISTS odara_nao_insere ON consumo_pendente;
DROP POLICY IF EXISTS odara_nao_altera ON consumo_pendente;
DROP POLICY IF EXISTS odara_nao_apaga ON consumo_pendente;
CREATE POLICY odara_nao_insere ON consumo_pendente AS RESTRICTIVE FOR INSERT
  TO authenticated WITH CHECK (papel_do_usuario() IS DISTINCT FROM 'odara');
CREATE POLICY odara_nao_altera ON consumo_pendente AS RESTRICTIVE FOR UPDATE
  TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara');
CREATE POLICY odara_nao_apaga ON consumo_pendente AS RESTRICTIVE FOR DELETE
  TO authenticated USING (papel_do_usuario() IS DISTINCT FROM 'odara');

-- ── O que o plano pede e não tem linha ───────────────────────
-- Demanda = a mesma conta da abertura (quantidade_porcionada quando existe:
-- o resto sai direto da embalagem do fornecedor). Menos o que já virou linha.
CREATE OR REPLACE FUNCTION public.registrar_consumo_pendente(p_sessao_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_empresa UUID;
  v_n       INTEGER := 0;
  v_r       RECORD;
BEGIN
  SELECT empresa_id INTO v_empresa FROM sessoes_producao
   WHERE id = p_sessao_id AND status = 'aberta';
  IF v_empresa IS NULL THEN RETURN 0; END IF;

  FOR v_r IN
    SELECT d.insumo_id, d.unidade,
           ROUND(d.demanda - COALESCE((SELECT SUM(spl.consumo_teorico)
                                         FROM sessoes_producao_locais spl
                                        WHERE spl.sessao_id = p_sessao_id
                                          AND spl.insumo_id = d.insumo_id), 0), 3) AS falta
      FROM (
        SELECT fti.insumo_id, i.unidade_medida AS unidade,
               SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
                   * COALESCE(sk.multiplicador, 0)) AS demanda
          FROM sessoes_producao_skus sk
          JOIN fichas_tecnicas_itens fti ON fti.versao_id = sk.ficha_versao_id
          JOIN insumos i ON i.id = fti.insumo_id
         WHERE sk.sessao_id = p_sessao_id
         GROUP BY fti.insumo_id, i.unidade_medida
      ) d
  LOOP
    -- Abaixo de 5 g/ml é arredondamento das linhas, não falta.
    IF v_r.falta > 0.005 THEN
      INSERT INTO consumo_pendente (empresa_id, sessao_id, insumo_id, quantidade, unidade)
      VALUES (v_empresa, p_sessao_id, v_r.insumo_id, v_r.falta, v_r.unidade)
      ON CONFLICT (sessao_id, insumo_id) WHERE status = 'aberto'
      DO UPDATE SET quantidade = EXCLUDED.quantidade;
      v_n := v_n + 1;
    ELSE
      DELETE FROM consumo_pendente
       WHERE sessao_id = p_sessao_id AND insumo_id = v_r.insumo_id AND status = 'aberto';
    END IF;
  END LOOP;

  -- Insumo que saiu do plano não deixa dívida.
  DELETE FROM consumo_pendente cp
   WHERE cp.sessao_id = p_sessao_id AND cp.status = 'aberto'
     AND NOT EXISTS (
       SELECT 1 FROM sessoes_producao_skus sk
         JOIN fichas_tecnicas_itens fti ON fti.versao_id = sk.ficha_versao_id
        WHERE sk.sessao_id = p_sessao_id AND fti.insumo_id = cp.insumo_id);

  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION registrar_consumo_pendente(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_consumo_pendente(UUID) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.abrir_sessao_producao_v2(p_empresa_id uuid, p_responsavel_id uuid, p_data_producao date, p_plano jsonb, p_observacoes text DEFAULT NULL::text, p_justificativa text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao_codigo     TEXT;
  v_sessao_id         UUID;
  v_ficha             RECORD;
  v_item              RECORD;
  v_rendimento        INTEGER;
  v_locais_vinculados INTEGER := 0;
  v_total_unidades    INTEGER := 0;
  v_inseridos         INTEGER;
  v_faltantes         JSONB;
  v_trava             JSONB;
  v_aplicacao         JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM sessoes_producao
              WHERE empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Já existe uma sessão aberta. Feche-a antes de abrir uma nova.');
  END IF;

  IF p_plano IS NULL OR jsonb_array_length(p_plano) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Informe ao menos uma ficha com quantidade de formas.');
  END IF;

  -- ── Insumo suficiente nos recipientes? ────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'codigo', x.codigo, 'nome', x.nome,
           'precisa', ROUND(x.demanda, 3), 'tem', ROUND(x.conteudo, 3),
           'falta', ROUND(x.demanda - x.conteudo, 3), 'unidade', x.unidade))
    INTO v_faltantes
    FROM (
      -- So o que passa pelo RECIPIENTE entra nesta conferencia. O aviso
      -- compara a demanda com o conteudo dos potes, e o que sai direto da
      -- embalagem do fornecedor nunca esteve em pote nenhum: incluir isso
      -- faria a tela dizer "falta doce de leite" em TODA sessao do brownie de
      -- doce de leite, porque os 558,9 g por forma da massa nao moram em pote.
      --
      -- Aviso que sempre aparece deixa de ser lido, e o dia em que faltar de
      -- verdade ele nao vai ser levado a serio.
      SELECT i.codigo, i.nome, i.unidade_medida AS unidade,
             SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
                 * (e->>'formas')::INTEGER) AS demanda,
             COALESCE((SELECT SUM(c.quantidade_total)
                         FROM v_recipientes_composicao c
                        WHERE c.empresa_id = p_empresa_id AND c.insumo_id = i.id), 0) AS conteudo
        FROM jsonb_array_elements(p_plano) e
        JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
        JOIN insumos i ON i.id = fti.insumo_id
       WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       GROUP BY i.id, i.codigo, i.nome, i.unidade_medida
    ) x
   WHERE x.demanda > x.conteudo;

  IF v_faltantes IS NOT NULL THEN
    v_trava := avaliar_trava(p_empresa_id, 'sessao_sem_insumo', p_justificativa);
    IF NOT (v_trava->>'permitido')::BOOLEAN THEN
      RETURN v_trava || jsonb_build_object(
        'ok', false,
        'trava', 'sessao_sem_insumo',
        'mensagem', format('%s insumo(s) sem quantidade suficiente nos recipientes. '
                           'A produção pararia no meio para abastecer.',
                           jsonb_array_length(v_faltantes)),
        'faltantes', v_faltantes
      );
    END IF;
    PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'sessao_sem_insumo',
                              jsonb_build_object('faltantes', v_faltantes), p_justificativa);
  END IF;

  -- ── Cria a sessão ─────────────────────────────────────────
  v_sessao_codigo := gerar_proximo_codigo(p_empresa_id, 'sessoes_producao', 'SESS');

  INSERT INTO sessoes_producao (
    empresa_id, codigo, data_producao, status,
    aberta_por, data_abertura, observacoes_abertura
  )
  VALUES (
    p_empresa_id, v_sessao_codigo, p_data_producao, 'aberta',
    p_responsavel_id, NOW(), p_observacoes
  )
  RETURNING id INTO v_sessao_id;

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RAISE EXCEPTION 'Versão de ficha % sem rendimento cadastrado.', v_ficha.versao_id;
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (v_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas);

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  FOR v_item IN
    -- Mesma divisao do planejador: so o que passa pelo recipiente vira consumo
    -- teorico de pote. O que sai direto da embalagem do fornecedor nao tem pote
    -- para descontar -- e o caso do xarope, da baunilha e da parte do doce de
    -- leite que vai para a massa.
    SELECT fti.insumo_id,
           SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
               * (e->>'formas')::INTEGER) AS consumo_teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT v_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.consumo_teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    GET DIAGNOSTICS v_inseridos = ROW_COUNT;
    v_locais_vinculados := v_locais_vinculados + v_inseridos;
  END LOOP;

  -- O teorico deixa de ser rateado entre todos os potes: e enfileirado.
  PERFORM redistribuir_teorico_sequencial(v_sessao_id);

  -- E sai do pote AGORA, não no fechamento: os baldes são repostos durante a
  -- produção, e a reposição precisa encontrar no sistema o pote como ele está
  -- na bancada.
  v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

  -- O que não achou pote na produção fica pendente (137).
  PERFORM registrar_consumo_pendente(v_sessao_id);

  RETURN jsonb_build_object(
    'ok', true, 'sessao_id', v_sessao_id, 'codigo', v_sessao_codigo,
    'quantidade_planejada', v_total_unidades, 'locais_vinculados', v_locais_vinculados,
    'consumo_baixado', COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0),
    'recipientes_baixados', COALESCE((v_aplicacao->>'recipientes')::INTEGER, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.atualizar_plano_sessao(p_sessao_id uuid, p_empresa_id uuid, p_plano jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_ficha          RECORD;
  v_item           RECORD;
  v_rendimento     INTEGER;
  v_total_unidades INTEGER := 0;
  v_aplicacao      JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessoes_producao
                  WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou já fechada.');
  END IF;

  -- Fichas que saíram do plano
  DELETE FROM sessoes_producao_skus
   WHERE sessao_id = p_sessao_id
     AND ficha_tecnica_id NOT IN (
       SELECT (e->>'ficha_id')::UUID FROM jsonb_array_elements(p_plano) e
        WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     );

  FOR v_ficha IN
    SELECT (e->>'ficha_id')::UUID AS ficha_id,
           (e->>'versao_id')::UUID AS versao_id,
           (e->>'formas')::INTEGER AS formas
      FROM jsonb_array_elements(p_plano) e
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
  LOOP
    SELECT rendimento_fornada INTO v_rendimento
      FROM fichas_tecnicas_versoes WHERE id = v_ficha.versao_id AND ativa = true;

    IF v_rendimento IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'Ficha sem rendimento cadastrado.');
    END IF;

    INSERT INTO sessoes_producao_skus (
      sessao_id, ficha_tecnica_id, ficha_versao_id, quantidade_planejada, multiplicador
    )
    VALUES (p_sessao_id, v_ficha.ficha_id, v_ficha.versao_id,
            v_rendimento * v_ficha.formas, v_ficha.formas)
    ON CONFLICT (sessao_id, ficha_tecnica_id) DO UPDATE SET
      ficha_versao_id      = EXCLUDED.ficha_versao_id,
      quantidade_planejada = EXCLUDED.quantidade_planejada,
      multiplicador        = EXCLUDED.multiplicador;

    v_total_unidades := v_total_unidades + (v_rendimento * v_ficha.formas);
  END LOOP;

  -- Consumo teórico recalculado e rateado entre os lotes já vinculados
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
     GROUP BY fti.insumo_id
  LOOP
    UPDATE sessoes_producao_locais spl
       SET consumo_teorico = v_item.teorico * (spl.quantidade_inicial / t.total)
      FROM (SELECT SUM(quantidade_inicial) AS total
              FROM sessoes_producao_locais
             WHERE sessao_id = p_sessao_id AND insumo_id = v_item.insumo_id) t
     WHERE spl.sessao_id = p_sessao_id
       AND spl.insumo_id = v_item.insumo_id
       AND t.total > 0;
  END LOOP;

  -- Insumos que entraram com uma ficha nova ainda não têm recipiente vinculado
  FOR v_item IN
    SELECT fti.insumo_id,
           SUM(fti.quantidade * (e->>'formas')::INTEGER) AS teorico
      FROM jsonb_array_elements(p_plano) e
      JOIN fichas_tecnicas_itens fti ON fti.versao_id = (e->>'versao_id')::UUID
     WHERE COALESCE((e->>'formas')::INTEGER, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM sessoes_producao_locais
                        WHERE sessao_id = p_sessao_id AND insumo_id = fti.insumo_id)
     GROUP BY fti.insumo_id
  LOOP
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id, quantidade_inicial, consumo_teorico
    )
    SELECT p_sessao_id, ll.local_id, v_item.insumo_id, ll.lote_id, ll.quantidade,
           v_item.teorico * (ll.quantidade / SUM(ll.quantidade) OVER ())
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;
  END LOOP;

  -- O teorico deixa de ser rateado entre todos os potes: e enfileirado.
  PERFORM redistribuir_teorico_sequencial(p_sessao_id);

  -- Mudar de 44 para 50 formas tira mais do pote; voltar para 40 devolve. É a
  -- DIFERENÇA que se aplica, não o total — senão descontaria duas vezes.
  v_aplicacao := aplicar_teorico_nos_recipientes(p_sessao_id);

  -- O que não achou pote na produção fica pendente (137).
  PERFORM registrar_consumo_pendente(p_sessao_id);

  RETURN jsonb_build_object(
    'ok', true,
    'quantidade_planejada', v_total_unidades,
    'consumo_baixado',   COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0),
    'consumo_devolvido', COALESCE((v_aplicacao->>'devolvido')::DECIMAL, 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reaplicar_teorico_do_insumo(p_empresa_id uuid, p_insumo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_sessao_id  UUID;
  v_sessoes    INTEGER := 0;
  v_aplicacao  JSONB;
  v_saiu       DECIMAL := 0;
  v_pendente   DECIMAL;
  v_linha      RECORD;
  v_leva       DECIMAL;
  v_ultima     UUID;
  v_divida     DECIMAL;
BEGIN
  FOR v_sessao_id IN
    SELECT s.id
      FROM sessoes_producao s
      JOIN sessoes_producao_locais spl ON spl.sessao_id = s.id
     WHERE s.empresa_id = p_empresa_id
       AND s.status = 'aberta'::status_sessao_enum
       AND spl.insumo_id = p_insumo_id
     GROUP BY s.id
    HAVING SUM(spl.consumo_teorico) > SUM(spl.consumo_aplicado)
    UNION
    -- …e a sessão que abriu sem o insumo na produção (137).
    SELECT cp.sessao_id
      FROM consumo_pendente cp
      JOIN sessoes_producao s ON s.id = cp.sessao_id
     WHERE cp.empresa_id = p_empresa_id AND cp.insumo_id = p_insumo_id
       AND cp.status = 'aberto' AND s.status = 'aberta'::status_sessao_enum
  LOOP
    v_ultima := NULL;
    SELECT COALESCE(SUM(quantidade), 0) INTO v_divida
      FROM consumo_pendente
     WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id AND status = 'aberto';

    -- 1. O que existe hoje no EP daquele insumo e ainda não tem linha na
    --    sessão. É o caso da embalagem do fornecedor que chegou no meio do
    --    dia: ponto de consumo que não existia na abertura.
    INSERT INTO sessoes_producao_locais (
      sessao_id, local_id, insumo_id, lote_id,
      quantidade_inicial, quantidade_reposta, consumo_teorico, consumo_aplicado
    )
    SELECT v_sessao_id, ll.local_id, p_insumo_id, ll.lote_id, 0, ll.quantidade, 0, 0
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
      JOIN lotes  lo ON lo.id = ll.lote_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND lo.insumo_id = p_insumo_id
       AND ll.quantidade > 0
    ON CONFLICT (sessao_id, local_id, lote_id) DO NOTHING;

    -- 2. Quanto entrou depois da abertura, por linha.
    --
    --    reposto = o que há no pote agora + o que a sessão já tirou dele
    --              - o que havia na abertura
    --
    --    Sem histórico de movimentação e auto-corrigível: se uma contagem
    --    baixar o pote, a capacidade da linha cai junto.
    UPDATE sessoes_producao_locais spl
       SET quantidade_reposta = GREATEST(
             ROUND(COALESCE(ll.quantidade, 0) + spl.consumo_aplicado
                   - spl.quantidade_inicial, 3), 0)
      FROM (SELECT local_id, lote_id, quantidade FROM locais_lotes) ll
     WHERE spl.sessao_id = v_sessao_id
       AND spl.insumo_id = p_insumo_id
       AND ll.local_id = spl.local_id
       AND ll.lote_id  = spl.lote_id;

    -- 3. Enfileira SÓ O PENDENTE, sem tocar no que já foi consumido.
    --
    -- Aqui NÃO se chama `redistribuir_teorico_sequencial`: ela refaz a fila
    -- inteira a partir do total, e com isso pode transferir a dívida de um pote
    -- para outro. `aplicar_teorico_nos_recipientes` leria essa mudança como
    -- "o plano diminuiu" e DEVOLVERIA insumo ao pote de onde já tinha saído —
    -- insumo que na vida real já virou brownie. Medido num teste: 6,8 kg
    -- entraram num pote e o saldo dele terminou zerado, com a diferença
    -- "devolvida" a um pote vizinho.
    --
    -- A regra que evita isso: `consumo_teorico` de cada linha nunca desce
    -- abaixo de `consumo_aplicado`. O que já aconteceu é fato; só o pendente
    -- se redistribui.
    SELECT COALESCE(SUM(consumo_teorico) - SUM(consumo_aplicado), 0) + v_divida INTO v_pendente
      FROM sessoes_producao_locais
     WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id;

    IF COALESCE(v_pendente, 0) > 0 THEN
      -- Congela o que já foi consumido…
      UPDATE sessoes_producao_locais
         SET consumo_teorico = consumo_aplicado
       WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id;

      -- …e reparte o pendente pelo que existe HOJE nos potes, na mesma ordem
      -- da fila da abertura: validade primeiro, depois o número do pote.
      FOR v_linha IN
        SELECT spl.id, COALESCE(ll.quantidade, 0) AS tem
          FROM sessoes_producao_locais spl
          JOIN locais l ON l.id = spl.local_id
          LEFT JOIN lotes lo ON lo.id = spl.lote_id
          LEFT JOIN locais_lotes ll
                 ON ll.local_id = spl.local_id AND ll.lote_id = spl.lote_id
         WHERE spl.sessao_id = v_sessao_id AND spl.insumo_id = p_insumo_id
         ORDER BY numero_do_pote(l.nome) NULLS LAST, chave_natural(l.nome), spl.id
      LOOP
        v_ultima := v_linha.id;
        EXIT WHEN v_pendente <= 0;

        v_leva := LEAST(v_pendente, v_linha.tem);
        CONTINUE WHEN v_leva <= 0;

        UPDATE sessoes_producao_locais
           SET consumo_teorico = consumo_teorico + v_leva
         WHERE id = v_linha.id;

        v_pendente := ROUND(v_pendente - v_leva, 3);
      END LOOP;

      -- O que não coube em pote nenhum fica pendurado na última linha, para a
      -- soma dos teóricos continuar igual à necessidade da ficha. É o mesmo
      -- princípio do "último da fila leva o resto" da abertura.
      IF v_pendente > 0 AND v_ultima IS NOT NULL THEN
        UPDATE sessoes_producao_locais
           SET consumo_teorico = consumo_teorico + v_pendente
         WHERE id = v_ultima;
      END IF;
    END IF;

    -- A dívida virou fila de pote: daqui em diante é linha comum da sessão.
    -- Sem pote nenhum (v_ultima nulo), ela continua pendente.
    IF v_divida > 0 AND v_ultima IS NOT NULL THEN
      UPDATE consumo_pendente
         SET status = 'quitado', resolvido_em = NOW()
       WHERE sessao_id = v_sessao_id AND insumo_id = p_insumo_id AND status = 'aberto';
    END IF;

    v_aplicacao := aplicar_teorico_nos_recipientes(v_sessao_id);

    v_saiu    := v_saiu + COALESCE((v_aplicacao->>'saiu')::DECIMAL, 0);
    v_sessoes := v_sessoes + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sessoes', v_sessoes, 'saiu', ROUND(v_saiu, 3));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fechar_sessao_producao(p_sessao_id uuid, p_empresa_id uuid, p_responsavel_id uuid, p_skus jsonb, p_observacoes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao               sessoes_producao%ROWTYPE;
  v_sku                  JSONB;
  v_qtd_planejada        INTEGER := 0;
  v_qtd_perdida_proc     INTEGER := 0;
  v_qtd_descartada_gram  INTEGER := 0;
  v_peso_descartado_g    DECIMAL := 0;
  v_qtd_produzida        INTEGER := 0;
  v_peso_medio_g         DECIMAL;
  v_fator_produto        DECIMAL(8,4) := 0;
  v_ficha_id             UUID;
  v_data_producao        DATE;
  v_lote_result          JSONB;
  v_tipo_ficha           TEXT;
  v_insumo_resultado_id  UUID;
  v_potes                INTEGER := 0;
  -- Acumuladores da perda do dia, somando TODOS os produtos da sessão
  v_num_peso             DECIMAL := 0;
  v_den_peso             DECIMAL := 0;
  v_num_un               DECIMAL := 0;
  v_den_un               DECIMAL := 0;
  v_todos_com_peso       BOOLEAN := TRUE;
  v_lotes                JSONB   := '[]'::JSONB;
  v_primeiro_tipo        TEXT;
  -- Consumo que não passou pela produção (137)
  v_ec                   RECORD;
  v_mov_ec               UUID;
  v_falta_ec             DECIMAL;
  v_avisos_ec            TEXT[] := '{}';
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao
   WHERE id = p_sessao_id AND empresa_id = p_empresa_id AND status = 'aberta';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada ou não está aberta.');
  END IF;

  v_data_producao := v_sessao.data_producao;

  -- ══════════════════════════════════════════════════════════
  -- CADA PRODUTO RESPONDE POR SI
  --
  -- O planejado era lido UMA VEZ, com LIMIT 1, e servia para todos os produtos
  -- do dia. Num dia de um produto só ninguém percebe; num dia misto, o segundo
  -- produto recebia as unidades do primeiro.
  --
  -- Aconteceu na SESS-0028, de 27/08/2026: 28 formas de Tradicional e 12 de
  -- Doce de Leite, e o Doce de Leite saiu gravado com 1.680 unidades — que são
  -- as 28 formas do Tradicional. As 12 formas dão 720.
  --
  -- Era a PRIMEIRA sessão de dois produtos fechada pela tela; as anteriores
  -- entraram pela importação do histórico e não passaram por aqui.
  -- ══════════════════════════════════════════════════════════
  FOR v_sku IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_ficha_id            := (v_sku->>'ficha_id')::UUID;
    v_qtd_perdida_proc    := COALESCE((v_sku->>'quantidade_perdida')::INTEGER, 0);
    v_qtd_descartada_gram := COALESCE((v_sku->>'quantidade_descartada_gramatura')::INTEGER, 0);
    v_peso_descartado_g   := COALESCE((v_sku->>'peso_descartado_gramatura_g')::DECIMAL, 0);

    -- O planejado e o peso médio DESTE produto, não os do primeiro da lista.
    SELECT sps.quantidade_planejada, ftv.peso_medio_g
      INTO v_qtd_planejada, v_peso_medio_g
      FROM sessoes_producao_skus sps
      JOIN fichas_tecnicas_versoes ftv ON ftv.id = sps.ficha_versao_id
     WHERE sps.sessao_id = p_sessao_id AND sps.ficha_tecnica_id = v_ficha_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        'Um dos produtos informados não está nesta sessão.');
    END IF;

    v_qtd_produzida := GREATEST(
      COALESCE(v_qtd_planejada, 0) - v_qtd_perdida_proc - v_qtd_descartada_gram, 0);

    UPDATE sessoes_producao_skus
       SET quantidade_produzida            = v_qtd_produzida,
           quantidade_perdida              = v_qtd_perdida_proc,
           quantidade_descartada_gramatura = v_qtd_descartada_gram,
           peso_descartado_gramatura_g     = NULLIF(v_peso_descartado_g, 0)
     WHERE sessao_id = p_sessao_id
       AND ficha_tecnica_id = v_ficha_id;

    -- A perda do dia soma a de todos os produtos. Antes o percentual saía do
    -- perdido do ÚLTIMO produto sobre o planejado do PRIMEIRO.
    IF v_peso_medio_g IS NOT NULL AND v_peso_medio_g > 0 THEN
      v_num_peso := v_num_peso
        + v_qtd_perdida_proc::DECIMAL * v_peso_medio_g + v_peso_descartado_g;
      v_den_peso := v_den_peso + COALESCE(v_qtd_planejada, 0)::DECIMAL * v_peso_medio_g;
    ELSE
      v_todos_com_peso := FALSE;
    END IF;
    v_num_un := v_num_un + v_qtd_perdida_proc + v_qtd_descartada_gram;
    v_den_un := v_den_un + COALESCE(v_qtd_planejada, 0);

    -- ── Lote resultante, POR PRODUTO ──────────────────────
    -- PRODUTO não vira lote aqui: o brownie ainda está na forma, e é a
    -- pós-produção que sabe quantos saíram inteiros (089). Sub-receita entra
    -- agora — ela não é desenformada. Antes só o primeiro produto da lista
    -- podia gerar lote; um dia com duas sub-receitas perdia a segunda.
    SELECT tipo, insumo_resultado_id INTO v_tipo_ficha, v_insumo_resultado_id
      FROM fichas_tecnicas WHERE id = v_ficha_id;
    v_primeiro_tipo := COALESCE(v_primeiro_tipo, v_tipo_ficha);

    IF v_qtd_produzida > 0 AND v_tipo_ficha = 'insumo'
       AND v_insumo_resultado_id IS NOT NULL THEN
      v_lote_result := registrar_lote_insumo_producao(
        p_empresa_id, v_insumo_resultado_id, p_sessao_id,
        v_data_producao, v_qtd_produzida, p_responsavel_id
      );
      v_lotes := v_lotes || jsonb_build_array(v_lote_result);
    END IF;
  END LOOP;

  -- ── Recipientes: o estoque JÁ SAIU na abertura (085) ──────
  -- A chamada abaixo é rede de segurança, não a regra: numa sessão normal ela
  -- encontra tudo aplicado e não mexe em nada. Existe para as sessões que
  -- estavam abertas antes da 085, e para o caso de o teórico ter mudado sem
  -- passar por atualizar_plano_sessao.
  PERFORM aplicar_teorico_nos_recipientes(p_sessao_id);

  -- ── O que a produção não teve: sai do estoque central (137) ──
  -- Pendência de insumo que nunca chegou à produção, mais o que as linhas não
  -- conseguiram tirar dos potes. Foi gasto — a ficha diz — e veio de algum
  -- lugar sem registro: na prática, da embalagem do estoque central.
  FOR v_ec IN
    SELECT x.insumo_id, i.nome, i.unidade_medida::TEXT AS unidade, ROUND(SUM(x.q), 3) AS q
      FROM (
        SELECT insumo_id, quantidade AS q
          FROM consumo_pendente
         WHERE sessao_id = p_sessao_id AND status = 'aberto'
        UNION ALL
        SELECT insumo_id, SUM(consumo_teorico - consumo_aplicado)
          FROM sessoes_producao_locais
         WHERE sessao_id = p_sessao_id
         GROUP BY insumo_id
      ) x
      JOIN insumos i ON i.id = x.insumo_id
     GROUP BY x.insumo_id, i.nome, i.unidade_medida
    HAVING SUM(x.q) > 0.005
  LOOP
    IF v_mov_ec IS NULL THEN
      INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                 sessao_producao_id, observacoes)
      VALUES (uuid_generate_v4(), p_empresa_id,
              gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV'),
              'consumo_producao', p_responsavel_id, p_sessao_id,
              format('Consumo da %s que não passou pela produção: saiu do estoque central (migration 137).',
                     v_sessao.codigo))
      RETURNING id INTO v_mov_ec;
    END IF;

    v_falta_ec := _baixar_lotes_embalagem(v_mov_ec, p_empresa_id, v_ec.insumo_id, v_ec.q);
    IF v_falta_ec > 0.0005 THEN
      v_avisos_ec := v_avisos_ec || format(
        'Faltou %s %s de %s também no estoque central: confira a contagem desse insumo.',
        replace(to_char(v_falta_ec, 'FM999990.000'), '.', ','), v_ec.unidade, v_ec.nome);
    END IF;
  END LOOP;

  UPDATE consumo_pendente
     SET status = 'baixado_ec', resolvido_em = NOW()
   WHERE sessao_id = p_sessao_id AND status = 'aberto';

  SELECT COUNT(DISTINCT local_id) INTO v_potes
    FROM sessoes_producao_locais
   WHERE sessao_id = p_sessao_id AND consumo_aplicado > 0;

  -- Liquida as linhas com o que de fato saiu. Um único UPDATE cobre os potes
  -- usados e os intocados: nestes consumo_aplicado é zero, e a linha fecha com
  -- o que tinha em vez de ficar com quantidade_final nula.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial - consumo_aplicado,
         consumo_real     = consumo_aplicado,
         desvio           = 0
   WHERE sessao_id = p_sessao_id;

  -- ── Perda de produto: o dia inteiro, não o último produto ─
  -- Por peso quando TODOS os produtos têm peso médio cadastrado; senão por
  -- unidade, que é comparável entre si. Misturar grama com unidade no mesmo
  -- percentual daria um número que não quer dizer nada.
  IF v_todos_com_peso AND v_den_peso > 0 THEN
    v_fator_produto := (v_num_peso / v_den_peso) * 100;
  ELSIF v_den_un > 0 THEN
    v_fator_produto := (v_num_un / v_den_un) * 100;
  END IF;

  UPDATE sessoes_producao
     SET status                 = 'fechada',
         fechada_por            = p_responsavel_id,
         data_fechamento        = NOW(),
         observacoes_fechamento = p_observacoes,
         -- NULL, não zero: a perda de insumo não é mais medida aqui.
         fator_perda_insumos    = NULL,
         fator_perda_produto    = v_fator_produto
   WHERE id = p_sessao_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sessao_id', p_sessao_id,
    'recipientes_baixados', v_potes,
    'fator_perda_produto', v_fator_produto,
    -- `lote_resultado` fica no singular por compatibilidade: é o último criado.
    -- `lotes_resultado` traz todos, que é o que passa a existir num dia com
    -- mais de uma sub-receita.
    'lote_resultado', COALESCE(v_lote_result, '{}'::JSONB),
    'lotes_resultado', v_lotes,
    'tipo_ficha', COALESCE(v_primeiro_tipo, 'produto'),
    'avisos', to_jsonb(v_avisos_ec)
  );
END;
$function$;

-- A sessão que está aberta agora (SESS-0047) passa a dever o que faltou.
SELECT registrar_consumo_pendente(id) FROM sessoes_producao WHERE status = 'aberta';

NOTIFY pgrst, 'reload schema';

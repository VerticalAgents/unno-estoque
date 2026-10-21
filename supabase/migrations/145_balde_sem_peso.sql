-- ============================================================
-- Migration 145 — balde vira rastreabilidade, não balança
--
-- Até aqui o sistema tentava saber quantos kg havia em CADA balde: descontava
-- o consumo teórico da sessão balde por balde, numa fila (balde 1, depois 2…)
-- que a equipe não segue. Apontava balde vazio que estava cheio, gerava
-- "dívida de consumo" e obrigava a pesar o balde antes e depois de encher.
--
-- E o dossiê de rastreabilidade (097) listava os lotes que a FILA escolheu
-- descontar (consumo_real > 0), não os que estavam no balde: lote que estava
-- lá dentro mas não "teve a vez" ficava fora da lista do fiscal.
--
-- Decisões do Lucca (21/10/2026):
--   · o objetivo é rastreabilidade: dizer que lotes estavam nos baldes no dia;
--   · cada balde continua sendo um recipiente — um recipiente único por insumo
--     nunca zeraria e a lista de lotes cresceria para sempre;
--   · sem peso: quem reabastece diz se o balde ESTAVA VAZIO, bipa os fardos e
--     diz QUANTO VOLTOU do fardo que não foi inteiro;
--   · no fim do dia todo balde está cheio: o conteúdo é a capacidade.
--
-- A regra: lotes de um balde = os que entraram nele desde a última vez que ele
-- estava vazio. Lotes de uma sessão = os de todos os baldes dos insumos da
-- ficha, da abertura ao fechamento. Nenhum kg sai do balde na produção.
--
-- Vale só para insumo de modo 'recipiente' e só para sessão aberta depois de
-- configuracoes_sistema.baldes_sem_peso_desde. Sessão anterior segue a regra
-- antiga. Desfazer = pôr a data em NULL.
-- ============================================================


-- ── 1. A data da virada e a pergunta "este insumo é sem peso?" ──
ALTER TABLE configuracoes_sistema
  ADD COLUMN IF NOT EXISTS baldes_sem_peso_desde TIMESTAMPTZ;

COMMENT ON COLUMN configuracoes_sistema.baldes_sem_peso_desde IS
  'Migration 145: a partir daqui, balde de insumo modo recipiente não é pesado nem descontado; '
  'serve só para rastreabilidade (lotes desde o último esvaziamento). NULL = regra antiga.';

CREATE OR REPLACE FUNCTION public.insumo_sem_peso(p_empresa_id uuid, p_insumo_id uuid, p_quando timestamptz)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
           SELECT 1 FROM configuracoes_sistema c
            WHERE c.empresa_id = p_empresa_id
              AND c.baldes_sem_peso_desde IS NOT NULL
              AND p_quando >= c.baldes_sem_peso_desde)
     -- Sem linha de config o insumo é de recipiente, como na tela de baldes.
     AND COALESCE((SELECT a.modo_ep::TEXT FROM insumos_armazenamento_config a
                    WHERE a.insumo_id = p_insumo_id LIMIT 1), 'recipiente') = 'recipiente'
$function$;

REVOKE ALL ON FUNCTION public.insumo_sem_peso(uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insumo_sem_peso(uuid, uuid, timestamptz) TO authenticated, service_role;


-- ── 2. Reabastecer sem balança ──────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_reabastecimento_sem_peso(
  p_empresa_id uuid, p_responsavel_id uuid, p_insumo_id uuid,
  p_baldes jsonb, p_lotes jsonb, p_observacoes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
-- p_baldes: [{local_id, estava_vazio}]   p_lotes: [{lote_id, voltou}]
--
-- Todo fardo bipado entra em todo balde enchido nesta ida: ninguém precisa
-- dizer qual fardo foi para qual balde. Para o fiscal, listar a mais é o lado
-- seguro; e como os baldes zeram a cada 1–2 dias, a lista fica curta.
DECLARE
  v_insumo     insumos%ROWTYPE;
  v_b          RECORD;
  v_l          RECORD;
  v_n_baldes   INTEGER;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
  v_validade   DATE;
  v_parte      DECIMAL;
  v_levou      DECIMAL := 0;
  v_vazios     INTEGER := 0;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  IF NOT insumo_sem_peso(p_empresa_id, p_insumo_id, NOW()) THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      '%s ainda não está na regra do balde sem peso.', v_insumo.nome));
  END IF;

  IF jsonb_array_length(COALESCE(p_baldes, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Marque os baldes que você encheu.');
  END IF;
  IF jsonb_array_length(COALESCE(p_lotes, '[]'::JSONB)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Bipe os fardos que você usou.');
  END IF;

  DROP TABLE IF EXISTS _rsp_baldes;
  CREATE TEMP TABLE _rsp_baldes ON COMMIT DROP AS
  SELECT lc.id, lc.nome, lc.capacidade_max, lc.tipo, lc.ativo, lc.efemero, lc.insumo_id,
         COALESCE((e->>'estava_vazio')::BOOLEAN, false) AS estava_vazio
    FROM jsonb_array_elements(p_baldes) e
    JOIN locais lc ON lc.id = (e->>'local_id')::UUID AND lc.empresa_id = p_empresa_id;

  IF (SELECT COUNT(*) FROM _rsp_baldes) <> jsonb_array_length(p_baldes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Balde não encontrado.');
  END IF;
  IF (SELECT COUNT(DISTINCT id) FROM _rsp_baldes) <> (SELECT COUNT(*) FROM _rsp_baldes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'O mesmo balde foi marcado duas vezes.');
  END IF;
  FOR v_b IN SELECT * FROM _rsp_baldes LOOP
    IF v_b.tipo <> 'estoque_produtivo' OR NOT v_b.ativo OR COALESCE(v_b.efemero, false)
       OR v_b.insumo_id IS DISTINCT FROM p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s não é um balde de %s.', v_b.nome, v_insumo.nome));
    END IF;
  END LOOP;

  DROP TABLE IF EXISTS _rsp_lotes;
  CREATE TEMP TABLE _rsp_lotes ON COMMIT DROP AS
  SELECT l.id, l.codigo, l.unidade, l.status, l.insumo_id, l.validade_original,
         l.validade_pos_abertura, l.quantidade_disponivel AS saldo,
         ROUND(COALESCE((e->>'voltou')::DECIMAL, 0), 3) AS voltou
    FROM jsonb_array_elements(p_lotes) e
    JOIN lotes l ON l.id = (e->>'lote_id')::UUID AND l.empresa_id = p_empresa_id;

  IF (SELECT COUNT(*) FROM _rsp_lotes) <> jsonb_array_length(p_lotes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Fardo não encontrado.');
  END IF;
  IF (SELECT COUNT(DISTINCT id) FROM _rsp_lotes) <> (SELECT COUNT(*) FROM _rsp_lotes) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'O mesmo fardo foi bipado duas vezes.');
  END IF;
  FOR v_l IN SELECT * FROM _rsp_lotes LOOP
    IF v_l.insumo_id <> p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro', format('%s é de outro insumo.', v_l.codigo));
    END IF;
    IF v_l.status <> 'ativo' OR v_l.saldo <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s não tem saldo no estoque (%s).', v_l.codigo, v_l.status));
    END IF;
    IF v_l.voltou < 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O que voltou de %s não pode ser negativo.', v_l.codigo));
    END IF;
    IF v_l.voltou >= v_l.saldo THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        'De %s voltou tudo o que ele tinha (%s): nada foi para os baldes. Tire da lista.',
        v_l.codigo, replace(to_char(v_l.saldo, 'FM999990.000'), '.', ',')));
    END IF;
  END LOOP;

  -- ── Balde que estava vazio fecha o ciclo: os lotes velhos saem dele ──
  FOR v_b IN SELECT * FROM _rsp_baldes WHERE estava_vazio LOOP
    PERFORM esgotar_recipiente(v_b.id, p_responsavel_id, p_empresa_id,
                               'Balde vazio no reabastecimento');
    -- esgotar_recipiente só apaga linhas quando há quantidade; as de zero
    -- também são de um ciclo que acabou.
    DELETE FROM locais_lotes WHERE local_id = v_b.id;
    v_vazios := v_vazios + 1;
  END LOOP;

  -- ── Fardos: o que não voltou foi para os baldes ──
  SELECT COUNT(*) INTO v_n_baldes FROM _rsp_baldes;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia', p_responsavel_id,
          COALESCE(NULLIF(trim(p_observacoes), ''), 'Reabastecimento sem peso'))
  RETURNING id INTO v_mov_id;

  FOR v_l IN SELECT * FROM _rsp_lotes ORDER BY validade_pos_abertura, codigo LOOP
    v_validade := CASE
      WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
      THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_l.validade_original)
      ELSE v_l.validade_original
    END;
    v_parte := ROUND((v_l.saldo - v_l.voltou) / v_n_baldes, 3);

    FOR v_b IN SELECT * FROM _rsp_baldes LOOP
      PERFORM abastecer_recipiente(v_b.id, v_l.id, v_parte, v_l.unidade, v_validade);
      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_l.id, v_b.id, v_parte, v_l.unidade);
    END LOOP;

    UPDATE lotes
       SET quantidade_disponivel = v_l.voltou,
           saldo_estimado        = false,
           status = CASE WHEN v_l.voltou <= 0.001
                         THEN 'esgotado'::status_lote_enum ELSE status END,
           updated_at = NOW()
     WHERE id = v_l.id;

    v_levou := v_levou + (v_l.saldo - v_l.voltou);
  END LOOP;

  -- ── Fim do reabastecimento = balde cheio ──
  -- O número no balde passa a ser a capacidade, dividida entre os lotes dele.
  -- Não é medição de kg: é a regra "no fim do dia está cheio".
  FOR v_b IN SELECT * FROM _rsp_baldes LOOP
    IF v_b.capacidade_max IS NOT NULL AND v_b.capacidade_max > 0 THEN
      PERFORM ajustar_conteudo_recipiente(v_b.id, v_b.capacidade_max);
    ELSE
      UPDATE locais SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW()
       WHERE id = v_b.id;
    END IF;
  END LOOP;

  -- Sessão aberta ganha a linha dos lotes novos (é o registro da
  -- rastreabilidade). 'nao': a dívida antiga não é tocada aqui.
  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id, 'nao');

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao', v_mov_codigo,
    'baldes', v_n_baldes,
    'esvaziados', v_vazios,
    'levou', ROUND(v_levou, 3),
    'unidade', v_insumo.unidade_medida
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.registrar_reabastecimento_sem_peso(uuid, uuid, uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_reabastecimento_sem_peso(uuid, uuid, uuid, jsonb, jsonb, text) TO authenticated, service_role;


-- ── 3. O desconto teórico não toca balde da regra nova ─────
CREATE OR REPLACE FUNCTION public.aplicar_teorico_nos_recipientes(p_sessao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sessao       sessoes_producao%ROWTYPE;
  v_local_id     UUID;
  v_linha        RECORD;
  v_lote         RECORD;
  v_mov_saida    UUID;
  v_mov_volta    UUID;
  v_mov_codigo   TEXT;
  v_delta        DECIMAL;
  v_move         DECIMAL;
  v_tem          DECIMAL;
  v_total_saiu   DECIMAL := 0;
  v_total_voltou DECIMAL := 0;
  v_potes        INTEGER := 0;
  v_mexeu        BOOLEAN;
BEGIN
  SELECT * INTO v_sessao FROM sessoes_producao WHERE id = p_sessao_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Sessão não encontrada.');
  END IF;

  FOR v_local_id IN
    SELECT DISTINCT local_id FROM sessoes_producao_locais WHERE sessao_id = p_sessao_id
  LOOP
    -- Uma movimentação por pote e por sentido, criada só quando há o que
    -- registrar: com o teórico enfileirado a maioria dos potes fica em zero, e
    -- criar movimentação para eles encheria o histórico de registros vazios.
    v_mov_saida := NULL;
    v_mov_volta := NULL;
    v_mexeu     := FALSE;

    FOR v_linha IN
      SELECT spl.id, spl.lote_id,
             LEAST(COALESCE(spl.consumo_teorico, 0),
                   spl.quantidade_inicial + spl.quantidade_reposta) AS alvo,
             spl.consumo_aplicado AS aplicado
        FROM sessoes_producao_locais spl
       WHERE spl.sessao_id = p_sessao_id AND spl.local_id = v_local_id
         -- Balde sem peso (145): o lote está no balde, mas nenhum kg sai dele.
         AND NOT insumo_sem_peso(v_sessao.empresa_id, spl.insumo_id, v_sessao.data_abertura)
    LOOP
      v_delta := ROUND(v_linha.alvo - v_linha.aplicado, 3);
      CONTINUE WHEN v_delta = 0;

      SELECT l.unidade, l.validade_original INTO v_lote FROM lotes l WHERE l.id = v_linha.lote_id;

      IF v_delta > 0 THEN
        -- Sai do pote. Nunca além do que há lá dentro: se o teórico for maior,
        -- o insumo acabou no meio e alguém abasteceu — e agora a recarga chama
        -- `reaplicar_teorico_do_insumo`, que traz o resto para cá.
        SELECT COALESCE(quantidade, 0) INTO v_tem
          FROM locais_lotes WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;
        v_move := LEAST(v_delta, COALESCE(v_tem, 0));
        CONTINUE WHEN v_move <= 0;

        UPDATE locais_lotes
           SET quantidade = quantidade - v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        IF v_mov_saida IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'consumo_producao',
                  v_sessao.aberta_por, p_sessao_id,
                  'Consumo previsto da sessão, baixado na abertura.')
          RETURNING id INTO v_mov_saida;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
        VALUES (v_mov_saida, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado + v_move WHERE id = v_linha.id;

        v_total_saiu := v_total_saiu + v_move;
        v_mexeu := TRUE;

      ELSE
        -- O plano diminuiu: devolve ao pote o que não vai mais ser usado.
        v_move := -v_delta;

        UPDATE locais_lotes
           SET quantidade = quantidade + v_move, updated_at = NOW()
         WHERE local_id = v_local_id AND lote_id = v_linha.lote_id;

        -- A linha pode ter sumido no caminho (uma contagem que zerou o pote,
        -- por exemplo). O helper recria em vez de a devolução evaporar.
        IF NOT FOUND THEN
          PERFORM abastecer_recipiente(v_local_id, v_linha.lote_id, v_move,
                                       v_lote.unidade, v_lote.validade_original);
        END IF;

        IF v_mov_volta IS NULL THEN
          v_mov_codigo := gerar_proximo_codigo(v_sessao.empresa_id, 'movimentacoes', 'MOV');
          INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                                     sessao_producao_id, observacoes)
          VALUES (uuid_generate_v4(), v_sessao.empresa_id, v_mov_codigo, 'ajuste_inventario',
                  v_sessao.aberta_por, p_sessao_id,
                  'Plano da sessão diminuiu: insumo devolvido ao recipiente.')
          RETURNING id INTO v_mov_volta;
        END IF;

        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_mov_volta, v_linha.lote_id, v_local_id, v_move, v_lote.unidade);

        UPDATE sessoes_producao_locais
           SET consumo_aplicado = consumo_aplicado - v_move WHERE id = v_linha.id;

        v_total_voltou := v_total_voltou + v_move;
        v_mexeu := TRUE;
      END IF;
    END LOOP;

    IF v_mexeu THEN
      v_potes := v_potes + 1;

      -- O numero deste pote passou a ser CHUTE.
      --
      -- O sistema sabe quanto a receita consome; de qual pote saiu, nao sabe --
      -- ele distribui pela fila. Em 27/08/2026 a fila zerou o Pote G Farinha de
      -- Trigo #2, que ninguem tinha tocado: ficou dois dias mostrando zero com
      -- 9,930 kg dentro, e so apareceu quando o Lucca subiu o pote na balanca.
      --
      -- Errar a distribuicao e inevitavel. O que nao pode e o chute ter a mesma
      -- cara de uma medicao -- quem olha "0 kg" precisa saber se aquilo foi
      -- pesado ou deduzido.
      UPDATE locais SET conteudo_estimado = TRUE WHERE id = v_local_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'saiu',       ROUND(v_total_saiu, 3),
    'devolvido',  ROUND(v_total_voltou, 3),
    'recipientes', v_potes
  );
END;
$function$;


-- ── 4. Sem dívida de consumo para insumo de balde ──────────
CREATE OR REPLACE FUNCTION public.registrar_consumo_pendente(p_sessao_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_empresa UUID;
  v_n       INTEGER := 0;
  v_r       RECORD;
  v_abertura TIMESTAMPTZ;
BEGIN
  SELECT empresa_id INTO v_empresa FROM sessoes_producao
   WHERE id = p_sessao_id AND status = 'aberta';
  IF v_empresa IS NULL THEN RETURN 0; END IF;
  SELECT data_abertura INTO v_abertura FROM sessoes_producao WHERE id = p_sessao_id;

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
    -- Abaixo de 5 g/ml é arredondamento das linhas, não falta. Insumo de balde
    -- sem peso (145) nunca deve: o balde é assumido cheio.
    IF v_r.falta > 0.005 AND NOT insumo_sem_peso(v_empresa, v_r.insumo_id, v_abertura) THEN
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
$function$;


-- ── 5. Abertura: trava por lote no balde, foto com todos os lotes ──
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
             -- Balde sem peso (145): o balde é assumido cheio, então a pergunta
             -- deixa de ser "tem kg suficiente" e passa a ser "tem LOTE
             -- registrado em algum balde" — é o que a rastreabilidade precisa.
             CASE WHEN insumo_sem_peso(p_empresa_id, i.id, NOW()) THEN
               CASE WHEN EXISTS (SELECT 1 FROM locais_lotes ll JOIN locais lc ON lc.id = ll.local_id
                                  WHERE lc.empresa_id = p_empresa_id AND lc.insumo_id = i.id
                                    AND lc.tipo = 'estoque_produtivo' AND lc.ativo)
                    THEN SUM(COALESCE(fti.quantidade_porcionada, fti.quantidade)
                             * (e->>'formas')::INTEGER)
                    ELSE 0 END
             ELSE
             COALESCE((SELECT SUM(c.quantidade_total)
                         FROM v_recipientes_composicao c
                        WHERE c.empresa_id = p_empresa_id AND c.insumo_id = i.id), 0)
             END AS conteudo
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
           COALESCE(v_item.consumo_teorico
                    * (ll.quantidade / NULLIF(SUM(ll.quantidade) OVER (), 0)), 0)
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       -- Balde sem peso (145): TODO lote que está no balde entra na foto da
       -- sessão, com ou sem quantidade — é a lista que vai para o fiscal.
       AND (ll.quantidade > 0 OR insumo_sem_peso(p_empresa_id, v_item.insumo_id, NOW()))
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


-- ── 6. Mudança de plano: mesma foto ────────────────────────
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
           COALESCE(v_item.teorico * (ll.quantidade / NULLIF(SUM(ll.quantidade) OVER (), 0)), 0)
      FROM locais_lotes ll
      JOIN locais l ON l.id = ll.local_id
     WHERE l.empresa_id = p_empresa_id
       AND l.tipo = 'estoque_produtivo'
       AND l.insumo_id = v_item.insumo_id
       AND (ll.quantidade > 0 OR insumo_sem_peso(p_empresa_id, v_item.insumo_id,
              (SELECT data_abertura FROM sessoes_producao WHERE id = p_sessao_id)))
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


-- ── 7. Fechamento: sem dívida para balde ───────────────────
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
  -- Consumo que não passou pela produção (137): vira dívida (143)
  v_ec                   RECORD;
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

  -- ── O que a produção não teve: vira DÍVIDA dos baldes (143) ──
  -- Até a 143 isto saía do estoque central, com o sistema escolhendo o lote
  -- (aberto primeiro, depois o que vence antes). Na semana de 13/10/2026 a
  -- equipe abasteceu os baldes sem registrar a transferência, e o fechamento
  -- deu como usados sacos que continuavam na prateleira: farinha 0012.1/5,
  -- choco 0003.5/6, ovo 0007.1/2, baunilha 0002.2/15. De qual saco saiu,
  -- ninguém sabe; o sistema chutava.
  --
  -- Regra do Lucca (18/10/2026): o central só muda por transferência, entrada
  -- ou contagem. O que faltou fica pendurado na sessão e sai dos BALDES quando
  -- o insumo entrar neles (quitar_divida_consumo, chamada pelo reaplicar).
  FOR v_ec IN
    SELECT x.insumo_id, i.nome, i.unidade_medida AS unidade, ROUND(SUM(x.q), 3) AS q
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
     -- Balde sem peso (145): não deve nada, o balde é assumido cheio.
     WHERE NOT insumo_sem_peso(p_empresa_id, x.insumo_id, v_sessao.data_abertura)
     GROUP BY x.insumo_id, i.nome, i.unidade_medida
    HAVING SUM(x.q) > 0.005
  LOOP
    INSERT INTO consumo_pendente (empresa_id, sessao_id, insumo_id, quantidade, unidade)
    VALUES (p_empresa_id, p_sessao_id, v_ec.insumo_id, v_ec.q, v_ec.unidade)
    ON CONFLICT (sessao_id, insumo_id) WHERE status = 'aberto'
    DO UPDATE SET quantidade = EXCLUDED.quantidade;

    v_avisos_ec := v_avisos_ec || format(
      'Ficou devendo %s %s de %s: sai dos baldes na próxima transferência.',
      replace(to_char(v_ec.q, 'FM999990.000'), '.', ','), v_ec.unidade::TEXT, v_ec.nome);
  END LOOP;

  SELECT COUNT(DISTINCT local_id) INTO v_potes
    FROM sessoes_producao_locais
   WHERE sessao_id = p_sessao_id AND consumo_aplicado > 0;

  -- Liquida as linhas com o que de fato saiu. Um único UPDATE cobre os potes
  -- usados e os intocados: nestes consumo_aplicado é zero, e a linha fecha com
  -- o que tinha em vez de ficar com quantidade_final nula.
  -- Balde sem peso (145): consumo_real vira o teórico da ficha, só como
  -- informação. O dossiê dessas sessões não depende dele.
  UPDATE sessoes_producao_locais
     SET quantidade_final = quantidade_inicial - consumo_aplicado,
         consumo_real     = CASE WHEN insumo_sem_peso(p_empresa_id, insumo_id, v_sessao.data_abertura)
                                 THEN COALESCE(consumo_teorico, 0) ELSE consumo_aplicado END,
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


-- ── 8. Dossiê: todos os lotes dos baldes ───────────────────
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
      -- Balde sem peso (145): todo lote que estava nos baldes durante a sessão
      -- entra, consumido ou não pela fila — é o que estava lá dentro.
      HAVING COALESCE(SUM(spl.consumo_real), 0) > 0
          OR bool_or(insumo_sem_peso(sp.empresa_id, i.id, sp.data_abertura))
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
            WHERE spl.sessao_id = sp.id
              AND (COALESCE(spl.consumo_real, 0) > 0
                   OR insumo_sem_peso(sp.empresa_id, spl.insumo_id, sp.data_abertura)))
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
$function$;


-- ── 9. A virada ─────────────────────────────────────────────
-- Vale para as sessões abertas daqui em diante. A dívida de consumo que os
-- baldes ainda tinham deixa de existir: o balde é assumido cheio.
UPDATE configuracoes_sistema SET baldes_sem_peso_desde = NOW()
 WHERE baldes_sem_peso_desde IS NULL;

-- Os baldes guardavam a linha de todo lote que já passou por eles, com
-- quantidade zero (em 21/10/2026: 504 linhas zeradas, 47 num balde de açúcar).
-- Na regra nova toda linha conta como "está no balde", então elas iriam para a
-- lista do fiscal. Sai a linha zerada; balde que ficaria sem nenhuma linha
-- guarda as do último dia em que recebeu insumo, para a abertura não travar.
DELETE FROM locais_lotes ll
 USING locais lc
 WHERE lc.id = ll.local_id
   AND lc.tipo = 'estoque_produtivo' AND NOT COALESCE(lc.efemero, false)
   AND COALESCE((SELECT a.modo_ep::TEXT FROM insumos_armazenamento_config a
                  WHERE a.insumo_id = lc.insumo_id LIMIT 1), 'recipiente') = 'recipiente'
   AND ll.quantidade <= 0
   AND (EXISTS (SELECT 1 FROM locais_lotes o WHERE o.local_id = ll.local_id AND o.quantidade > 0)
        OR ll.data_transferencia < (SELECT MAX(o.data_transferencia) FROM locais_lotes o
                                     WHERE o.local_id = ll.local_id));

UPDATE consumo_pendente cp
   SET status = 'quitado', resolvido_em = NOW()
 WHERE cp.status = 'aberto'
   AND COALESCE((SELECT a.modo_ep::TEXT FROM insumos_armazenamento_config a
                  WHERE a.insumo_id = cp.insumo_id LIMIT 1), 'recipiente') = 'recipiente'
   AND NOT EXISTS (SELECT 1 FROM sessoes_producao s
                    WHERE s.id = cp.sessao_id AND s.status = 'aberta');

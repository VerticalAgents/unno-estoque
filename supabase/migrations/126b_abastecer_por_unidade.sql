-- ============================================================
-- Migration 126b — óleo e ovo em pó abastecidos por unidade
--
-- O PEDIDO DO LUCCA, em 28/09/2026: o óleo chega em caixa de 20 garrafas de
-- 810 g e o ovo em pó em saco de 20 pacotes de 1 kg. O QR fica na caixa e no
-- saco; garrafas e pacotes vão SOLTOS para a produção. Ninguém pesa. Tratar
-- os dois como pote de açúcar — caixa plástica com tara, pesagem antes e
-- depois — era conta à toa.
--
-- Agora:
--   * a produção tem UM lugar por insumo ("Produção · Óleo"), sem pote,
--     sem tara e sem capacidade;
--   * o reabastecimento pergunta quantas FECHADAS ainda estavam lá (o "pesar
--     o antes" desta tela) e quantas saíram de cada caixa bipada. A aberta não
--     conta: o sistema fica no máximo uma unidade abaixo do real, e o erro não
--     acumula — na contagem seguinte a aberta já foi consumida;
--   * o planejador fala em garrafas e pacotes.
--
-- O peso da unidade vem de `insumos_embalagem_config.subunidade_peso`, que
-- existia desde o começo e nunca tinha sido usado.
--
-- Não havia sessão de produção aberta quando esta migration foi escrita
-- (SESS-0044 fechada): mover o conteúdo de lugar não deixa teórico pendurado.

-- ── 1. Cadastro ─────────────────────────────────────────────
UPDATE insumos_armazenamento_config c
   SET modo_ep = 'unidade', updated_at = NOW()
  FROM insumos i
 WHERE i.id = c.insumo_id
   AND i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
   AND i.codigo IN ('INS005', 'INS006');

UPDATE insumos_embalagem_config e
   SET tem_subunidades = TRUE, subunidade_tipo = 'pacote',
       subunidade_quantidade = 20, subunidade_peso = 1.000,
       subunidade_unidade = 'kg', updated_at = NOW()
  FROM insumos i
 WHERE i.id = e.insumo_id
   AND i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
   AND i.codigo = 'INS005';

-- ── 2. Um lugar por insumo na produção ──────────────────────
-- Sem capacidade (não há pote) e sem etiqueta a imprimir (ninguém escaneia
-- uma prateleira).
INSERT INTO locais (empresa_id, nome, tipo, subtipo, insumo_id, capacidade_max,
                    unidade_capacidade, peso_tara, ativo, efemero,
                    conteudo_estimado, etiqueta_impressa, observacoes)
SELECT i.empresa_id, 'Produção · ' || i.nome, 'estoque_produtivo', 'prateleira',
       i.id, NULL, i.unidade_medida, 0, TRUE, FALSE, FALSE, TRUE,
       'Insumo abastecido por unidade (migration 126): garrafas ou pacotes soltos, sem pote.'
  FROM insumos i
 WHERE i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
   AND i.codigo IN ('INS005', 'INS006')
   AND NOT EXISTS (SELECT 1 FROM locais l
                    WHERE l.empresa_id = i.empresa_id AND l.nome = 'Produção · ' || i.nome);

-- O conteúdo das caixas plásticas passa para lá, lote a lote, com movimento.
DO $$
DECLARE
  v_ins    RECORD;
  v_novo   UUID;
  v_mov    UUID;
  v_cod    TEXT;
  v_linha  RECORD;
BEGIN
  FOR v_ins IN
    SELECT i.id, i.empresa_id, i.nome FROM insumos i
     WHERE i.empresa_id = '59e40a9f-b136-4c47-8dc0-2edd73dbe341'
       AND i.codigo IN ('INS005', 'INS006')
  LOOP
    SELECT id INTO v_novo FROM locais
     WHERE empresa_id = v_ins.empresa_id AND nome = 'Produção · ' || v_ins.nome;
    v_mov := NULL;

    FOR v_linha IN
      SELECT ll.local_id, ll.lote_id, ll.quantidade, ll.unidade, ll.validade_ep
        FROM locais_lotes ll
        JOIN locais l ON l.id = ll.local_id
       WHERE l.insumo_id = v_ins.id AND l.tipo = 'estoque_produtivo'
         AND l.id <> v_novo AND NOT l.efemero AND ll.quantidade > 0
    LOOP
      IF v_mov IS NULL THEN
        v_cod := gerar_proximo_codigo(v_ins.empresa_id, 'movimentacoes', 'MOV');
        -- Responsável: o Lucca, que pediu a mudança.
        INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
        VALUES (uuid_generate_v4(), v_ins.empresa_id, v_cod, 'transferencia',
                'e145c637-58dd-43b9-bc48-43068f7e6a9d',
                'Caixa plástica aposentada (migration 126): o conteúdo passa para '
                'Produção · ' || v_ins.nome || '.')
        RETURNING id INTO v_mov;
      END IF;

      PERFORM abastecer_recipiente(v_novo, v_linha.lote_id, v_linha.quantidade,
                                   v_linha.unidade, v_linha.validade_ep);
      UPDATE locais_lotes SET quantidade = 0, updated_at = NOW()
       WHERE local_id = v_linha.local_id AND lote_id = v_linha.lote_id;

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov, v_linha.lote_id, v_linha.local_id, v_novo,
              v_linha.quantidade, v_linha.unidade);
    END LOOP;

    -- A data da última pesagem vem junto: é a mesma medição.
    UPDATE locais n
       SET conteudo_conferido_em = (SELECT MAX(conteudo_conferido_em) FROM locais o
                                     WHERE o.insumo_id = v_ins.id AND o.id <> v_novo
                                       AND o.tipo = 'estoque_produtivo' AND NOT o.efemero)
     WHERE n.id = v_novo;

    -- Desativa, não exclui: o histórico aponta para elas.
    UPDATE locais SET ativo = FALSE, updated_at = NOW()
     WHERE insumo_id = v_ins.id AND tipo = 'estoque_produtivo'
       AND id <> v_novo AND NOT efemero AND ativo;
  END LOOP;
END;
$$;

-- ── 3. O reabastecimento por unidade ────────────────────────
-- p_tinha: quantas FECHADAS ainda estavam na produção.
-- p_itens: [{lote_id, unidades}] — de cada caixa/saco bipado, quantas saíram.
CREATE OR REPLACE FUNCTION public.registrar_abastecimento_unidades(
  p_empresa_id UUID, p_responsavel_id UUID, p_insumo_id UUID,
  p_tinha INTEGER, p_itens JSONB, p_justificativa TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_insumo     insumos%ROWTYPE;
  v_peso       DECIMAL;
  v_tipo       TEXT;
  v_local      UUID;
  v_it         RECORD;
  v_linha      RECORD;
  v_sistema    DECIMAL;
  v_medido     DECIMAL;
  v_fator      DECIMAL;
  v_novo       DECIMAL;
  v_dif        DECIMAL;
  v_acerto_mov UUID;
  v_mov_id     UUID;
  v_mov_codigo TEXT;
  v_validade   DATE;
  v_levou      INTEGER := 0;
  v_primeiro   RECORD;
  v_orfao      DECIMAL := 0;
BEGIN
  SELECT * INTO v_insumo FROM insumos WHERE id = p_insumo_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Insumo não encontrado.');
  END IF;

  SELECT e.subunidade_peso, COALESCE(e.subunidade_tipo, 'unidade')
    INTO v_peso, v_tipo
    FROM insumos_embalagem_config e
   WHERE e.insumo_id = p_insumo_id AND e.tem_subunidades AND e.subunidade_peso > 0;
  IF v_peso IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      '%s não tem cadastrado quanto pesa cada unidade.', v_insumo.nome));
  END IF;

  SELECT id INTO v_local FROM locais
   WHERE empresa_id = p_empresa_id AND insumo_id = p_insumo_id
     AND tipo = 'estoque_produtivo' AND ativo AND NOT efemero
   ORDER BY created_at DESC LIMIT 1;
  IF v_local IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      '%s não tem lugar na produção cadastrado.', v_insumo.nome));
  END IF;

  IF p_tinha IS NULL OR p_tinha < 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'Diga quantas %ss fechadas ainda estavam na produção.', v_tipo));
  END IF;

  DROP TABLE IF EXISTS _abu_itens;
  CREATE TEMP TABLE _abu_itens ON COMMIT DROP AS
  SELECT l.id, l.codigo, l.unidade, l.status, l.insumo_id, l.validade_original,
         l.validade_pos_abertura, l.quantidade_disponivel AS saldo,
         (e->>'unidades')::INTEGER AS unidades,
         ROUND((e->>'unidades')::INTEGER * v_peso, 3) AS qtd
    FROM jsonb_array_elements(COALESCE(p_itens, '[]'::JSONB)) e
    JOIN lotes l ON l.id = (e->>'lote_id')::UUID AND l.empresa_id = p_empresa_id;

  -- ── Conferência: nada é escrito antes de tudo passar ──────
  IF (SELECT COUNT(*) FROM _abu_itens) <> jsonb_array_length(COALESCE(p_itens, '[]'::JSONB)) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Embalagem não encontrada.');
  END IF;
  IF (SELECT COUNT(DISTINCT id) FROM _abu_itens) <> (SELECT COUNT(*) FROM _abu_itens) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'A mesma embalagem foi bipada duas vezes.');
  END IF;

  FOR v_it IN SELECT * FROM _abu_itens LOOP
    IF v_it.insumo_id <> p_insumo_id THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s é de outro insumo.', v_it.codigo));
    END IF;
    IF v_it.status <> 'ativo' THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s não está ativa (%s).', v_it.codigo, v_it.status));
    END IF;
    IF COALESCE(v_it.unidades, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('Diga quantas %ss saíram de %s.', v_tipo, v_it.codigo));
    END IF;
    IF v_it.qtd > v_it.saldo + 0.001 THEN
      RETURN jsonb_build_object('ok', false, 'erro', format(
        '%s só tem %s %ss, e foram informadas %s.',
        v_it.codigo, FLOOR(v_it.saldo / v_peso + 0.0001), v_tipo, v_it.unidades));
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(quantidade), 0) INTO v_sistema
    FROM locais_lotes WHERE local_id = v_local;
  v_medido := ROUND(p_tinha * v_peso, 3);

  -- Contou fechadas num lugar que o sistema acha vazio, e não entrou nada:
  -- não há lote a quem atribuir.
  IF v_sistema <= 0 AND v_medido > 0 AND NOT EXISTS (SELECT 1 FROM _abu_itens) THEN
    RETURN jsonb_build_object('ok', false, 'erro', format(
      'O sistema não tem %s na produção e não sabe de qual lote são essas %s. '
      'Registre junto com a próxima caixa que levar.', v_insumo.nome, p_tinha));
  END IF;

  -- ── Acerto: o que estava lá contra o que o sistema supunha ─
  IF ABS(v_medido - v_sistema) >= 0.001 THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
            p_responsavel_id, format(
              'Contagem no reabastecimento: %s %ss fechadas na produção.', p_tinha, v_tipo))
    RETURNING id INTO v_acerto_mov;

    IF v_sistema > 0 THEN
      -- Rateio na proporção de cada lote. O item sai antes do ajuste, enquanto
      -- as quantidades ainda são as velhas.
      v_fator := v_medido / v_sistema;
      FOR v_linha IN
        SELECT lote_id, quantidade, unidade FROM locais_lotes
         WHERE local_id = v_local AND quantidade > 0
      LOOP
        v_dif := ROUND(v_linha.quantidade * v_fator, 3) - v_linha.quantidade;
        CONTINUE WHEN ABS(v_dif) < 0.001;
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_origem_id, local_destino_id, quantidade, unidade)
        VALUES (v_acerto_mov, v_linha.lote_id,
                CASE WHEN v_dif < 0 THEN v_local END,
                CASE WHEN v_dif > 0 THEN v_local END,
                ABS(v_dif), v_linha.unidade);
      END LOOP;
      PERFORM ajustar_conteudo_recipiente(v_local, v_medido);
    ELSE
      -- O sistema acha vazio e a contagem diz que tem: vai para a primeira
      -- embalagem que está entrando, com a ressalva registrada — mesmo
      -- caminho do "órfão" do reabastecimento de pote.
      v_orfao := v_medido;
    END IF;
  END IF;

  -- ── Entrada ───────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM _abu_itens) THEN
    v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
    INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
    VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'transferencia',
            p_responsavel_id, p_justificativa)
    RETURNING id INTO v_mov_id;

    FOR v_it IN SELECT * FROM _abu_itens ORDER BY validade_pos_abertura, codigo LOOP
      v_validade := CASE
        WHEN v_insumo.shelf_life_dias_pos_abertura IS NOT NULL
        THEN LEAST(CURRENT_DATE + v_insumo.shelf_life_dias_pos_abertura, v_it.validade_original)
        ELSE v_it.validade_original
      END;

      PERFORM abastecer_recipiente(v_local, v_it.id, v_it.qtd, v_it.unidade, v_validade);

      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
      VALUES (v_mov_id, v_it.id, v_local, v_it.qtd, v_it.unidade);

      UPDATE lotes
         SET quantidade_disponivel = GREATEST(ROUND(quantidade_disponivel - v_it.qtd, 3), 0),
             status = CASE WHEN quantidade_disponivel - v_it.qtd <= 0.001
                           THEN 'esgotado'::status_lote_enum ELSE status END,
             updated_at = NOW()
       WHERE id = v_it.id;

      IF v_orfao > 0 THEN
        PERFORM abastecer_recipiente(v_local, v_it.id, v_orfao, v_it.unidade, v_validade);
        INSERT INTO movimentacoes_itens
          (movimentacao_id, lote_id, local_destino_id, quantidade, unidade)
        VALUES (v_acerto_mov, v_it.id, v_local, v_orfao, v_it.unidade);
        PERFORM registrar_excecao(p_empresa_id, p_responsavel_id, 'acerto_sem_lote',
          jsonb_build_object('quantidade', v_orfao, 'lote', v_it.codigo),
          COALESCE(NULLIF(trim(p_justificativa), ''),
                   'A produção tinha unidades que o sistema não conhecia.'));
        v_orfao := 0;
      END IF;

      v_levou := v_levou + v_it.unidades;
    END LOOP;
  END IF;

  -- Contou: o número é medição.
  UPDATE locais
     SET conteudo_estimado = FALSE, conteudo_conferido_em = NOW(), updated_at = NOW()
   WHERE id = v_local;

  PERFORM reaplicar_teorico_do_insumo(p_empresa_id, p_insumo_id);

  RETURN jsonb_build_object(
    'ok',          true,
    'movimentacao', v_mov_codigo,
    'tipo',        v_tipo,
    'tinha',       p_tinha,
    'levou',       v_levou,
    'total',       p_tinha + v_levou,
    'acerto',      ROUND(v_medido - v_sistema, 3)
  );
END;
$function$;

REVOKE ALL ON FUNCTION registrar_abastecimento_unidades(UUID, UUID, UUID, INTEGER, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_abastecimento_unidades(UUID, UUID, UUID, INTEGER, JSONB, TEXT)
  TO authenticated, service_role;

-- ── 4. O planejador fala em garrafas e pacotes ─────────────
-- Parte do corpo em produção (pg_get_functiondef em 28/09/2026, migration
-- 122). Insumo por unidade entra como a porção: tem = unidades inteiras na
-- produção; precisa = demanda ÷ peso da unidade, arredondado para cima.
CREATE OR REPLACE FUNCTION public.planejar_recipientes(p_empresa_id uuid, p_plano jsonb)
 RETURNS TABLE(insumo_id uuid, via text, codigo text, nome text, unidade text, recipiente_modelo text, capacidade numeric, demanda numeric, demanda_com_folga numeric, recipientes_atuais integer, recipientes_necessarios integer, faltam integer)
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
  -- DUAS LINHAS por insumo, uma para cada caminho.
  --
  -- A porcao mede o que passa pelo saco de confeitar; o recipiente mede o
  -- resto. Medir a demanda inteira em porcoes dizia "67 sacos" para um dia so
  -- de brownie tradicional -- que nao tem topping nenhum e leva os 13,36 kg
  -- inteiros do pote.
  --
  -- A linha que der ZERO e descartada logo abaixo. Um dia sem topping nao deve
  -- falar em sacos: silencio informa melhor que "0 sacos".
  demanda_insumo AS (
    SELECT it.insumo_id AS ins_id,
           'porcionado'::TEXT AS via,
           SUM(COALESCE(it.quantidade_porcionada, 0) * p.formas) AS qtd
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
    UNION ALL
    SELECT it.insumo_id,
           'recipiente'::TEXT,
           SUM((it.quantidade - COALESCE(it.quantidade_porcionada, 0)) * p.formas)
      FROM plano p
      JOIN fichas_tecnicas_versoes v ON v.ficha_id = p.ficha_id AND v.ativa
      JOIN fichas_tecnicas_itens it  ON it.versao_id = v.id
     GROUP BY it.insumo_id
  ),
  recipientes AS (
    SELECT l.insumo_id AS ins_id,
           -- Um recipiente, uma contagem. COUNT(*) contava as linhas de lote
           -- (migration 122).
           COUNT(DISTINCT l.id)::INTEGER AS n,
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
  -- Insumo abastecido por unidade (migration 126): garrafa de óleo, pacote de
  -- ovo. Não há pote — conta-se a unidade que existe na mão de quem trabalha,
  -- o mesmo princípio da porção.
  unid AS (
    SELECT c.insumo_id AS ins_id, e.subunidade_peso AS peso,
           COALESCE(e.subunidade_tipo, 'unidade') AS tipo
      FROM insumos_armazenamento_config c
      JOIN insumos_embalagem_config e ON e.insumo_id = c.insumo_id
     WHERE c.modo_ep::TEXT = 'unidade'
       AND e.tem_subunidades AND e.subunidade_peso > 0
  ),
  base AS (
    SELECT i.id, d.via, i.codigo, i.nome, i.unidade_medida,
           i.recipiente_subtipo, i.recipiente_capacidade_max,
           d.qtd, COALESCE(r.n, 0) AS n, COALESCE(r.conteudo, 0) AS conteudo,
           -- A porcao mede a linha porcionada e so ela. Na linha do resto, o
           -- que vale e a capacidade do recipiente, como em qualquer insumo.
           CASE WHEN d.via = 'porcionado' THEN po.tamanho
                WHEN u.peso IS NOT NULL   THEN u.peso
                ELSE NULL END AS porcao,
           CASE WHEN d.via = 'recipiente' THEN u.tipo END AS modelo_unid
      FROM demanda_insumo d
      JOIN insumos i ON i.id = d.ins_id
      LEFT JOIN recipientes r ON r.ins_id = d.ins_id
      LEFT JOIN porcao po ON po.ins_id = d.ins_id
      LEFT JOIN unid u ON u.ins_id = d.ins_id
     WHERE i.empresa_id = p_empresa_id
       AND d.qtd > 0
       -- Linha porcionada sem porcao configurada nao tem como ser medida.
       AND (d.via <> 'porcionado' OR po.tamanho IS NOT NULL)
  )
  SELECT
    b.id,
    b.via,
    b.codigo::TEXT,
    b.nome::TEXT,
    b.unidade_medida::TEXT,
    CASE WHEN b.modelo_unid IS NOT NULL THEN b.modelo_unid
         WHEN b.porcao IS NOT NULL THEN 'saco_confeitar'
         ELSE b.recipiente_subtipo::TEXT END,
    COALESCE(b.porcao, b.recipiente_capacidade_max),
    ROUND(b.qtd, 4),
    ROUND(b.qtd * (1 + v_folga), 4),
    CASE WHEN b.porcao IS NOT NULL
         THEN FLOOR(b.conteudo / b.porcao + 0.0001)::INTEGER
         ELSE b.n END,
    CASE WHEN COALESCE(b.porcao, b.recipiente_capacidade_max, 0) > 0
         THEN CEIL(b.qtd * (1 + v_folga) / COALESCE(b.porcao, b.recipiente_capacidade_max))::INTEGER
         ELSE NULL END,
    CASE WHEN COALESCE(b.porcao, b.recipiente_capacidade_max, 0) > 0
         THEN GREATEST(
                CEIL(b.qtd * (1 + v_folga) / COALESCE(b.porcao, b.recipiente_capacidade_max))::INTEGER
                - CASE WHEN b.porcao IS NOT NULL
                       THEN FLOOR(b.conteudo / b.porcao + 0.0001)::INTEGER
                       ELSE b.n END, 0)
         ELSE NULL END
  FROM base b
  -- Ordem do codigo (migration 031): e a ordem em que os recipientes sao
  -- conferidos na pratica, e mantem tela e folha impressa iguais.
  -- Ordem do codigo (migration 031), com o porcionado antes do resto: e a
  -- ordem em que a bancada trabalha -- enche os sacos, depois usa o balde.
  ORDER BY b.codigo, (b.via = 'recipiente');
END;
$function$;

REVOKE ALL ON FUNCTION planejar_recipientes(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION planejar_recipientes(UUID, JSONB) TO authenticated, service_role;

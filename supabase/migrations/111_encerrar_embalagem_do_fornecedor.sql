-- ============================================================
-- Migration 111 — encerrar a embalagem do fornecedor que acabou
--
-- Alguns insumos não moram em balde: o doce de leite, a lata de desmoldante, o
-- balde de glucose e a garrafa de baunilha são consumidos de dentro da própria
-- embalagem. A transferência cria um ponto de consumo efêmero (073) e o QR do
-- lote, já colado na embalagem, serve de etiqueta.
--
-- O BURACO. Esse ponto de consumo nunca era encerrado. A baixa vem do consumo
-- teórico, que quase nunca bate, e quando a embalagem vai para o lixo ninguém
-- diz isso ao sistema — o único botão "esgotar" mora na tela de Recipientes,
-- em Cadastros, que não é onde o operador está com o balde vazio na mão.
--
-- O resultado é estoque fantasma: o sistema segue debitando teórico de uma
-- embalagem que já foi para a lixeira, e o saldo de EP daquele insumo sobe
-- indefinidamente acima do real.
--
-- POR QUE NO FECHAMENTO DA SESSÃO. A embalagem do fornecedor é o oposto do
-- balde da cozinha. O balde sobrevive: o que não se mede hoje, a auditoria de
-- sexta corrige. A embalagem vai para o lixo — não vai estar lá na sexta. O
-- momento do descarte é a última chance de observá-la, e quem esvazia é a
-- produção.
--
-- NÃO USA `esgotar_recipiente`, que faz quase isto: ela APAGA as linhas de
-- `locais_lotes`, e com isso o dossiê perde de qual lote saiu o que estava na
-- embalagem. `ajustar_conteudo_recipiente` (037) zera preservando o vínculo.
-- ============================================================

CREATE OR REPLACE FUNCTION registrar_embalagens_encerradas(
  p_sessao_id      UUID,
  p_empresa_id     UUID,
  p_responsavel_id UUID,
  p_itens          JSONB   -- [{local_id, restante}] — restante 0 = acabou
) RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 -- `extensions` junto: é lá que mora o uuid-ossp no Supabase, e sem isto a
 -- função quebra em `uuid_generate_v4()`. Foi o tropeço da 108.
 SET search_path = public, extensions
AS $function$
DECLARE
  v_item        RECORD;
  v_local       locais%ROWTYPE;
  v_tinha       DECIMAL;
  v_erros       TEXT[] := '{}';
  v_mov_id      UUID;
  v_mov_codigo  TEXT;
  v_encerradas  INTEGER := 0;
  v_parciais    INTEGER := 0;
  v_diferenca   DECIMAL := 0;
  v_linha       RECORD;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'encerradas', 0, 'ainda_tem', 0,
                              'diferenca_total', 0);
  END IF;

  -- ── Conferência: nada é escrito antes de tudo passar ──────
  -- Uma chamada que falha no meio deixaria metade das embalagens encerradas e
  -- o operador sem saber quais.
  FOR v_item IN
    SELECT (e->>'local_id')::UUID AS local_id,
           ROUND(COALESCE((e->>'restante')::DECIMAL, 0), 3) AS restante
      FROM jsonb_array_elements(p_itens) e
  LOOP
    SELECT * INTO v_local
      FROM locais WHERE id = v_item.local_id AND empresa_id = p_empresa_id;

    IF NOT FOUND THEN
      v_erros := v_erros || 'Embalagem não encontrada.';
      CONTINUE;
    END IF;

    IF NOT v_local.efemero THEN
      v_erros := v_erros || format(
        '%s é um recipiente da cozinha, não uma embalagem do fornecedor. '
        'Recipiente não se encerra: ele é pesado no reabastecimento.', v_local.nome);
      CONTINUE;
    END IF;

    IF NOT v_local.ativo THEN
      v_erros := v_erros || format('%s já foi encerrada antes.', v_local.nome);
      CONTINUE;
    END IF;

    IF v_item.restante < 0 THEN
      v_erros := v_erros || format('%s: sobra negativa não existe.', v_local.nome);
    END IF;

    IF v_local.capacidade_max IS NOT NULL
       AND v_item.restante > v_local.capacidade_max + 0.001 THEN
      v_erros := v_erros || format(
        '%s: sobrou %s, mais do que a embalagem comporta (%s).',
        v_local.nome, qtd_legivel(v_item.restante), qtd_legivel(v_local.capacidade_max));
    END IF;
  END LOOP;

  IF array_length(v_erros, 1) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', array_to_string(v_erros, E'\n'));
  END IF;

  -- ── Escrita ───────────────────────────────────────────────
  -- Um movimento só para a operação inteira: é o fechamento de uma sessão, não
  -- sete acontecimentos separados.
  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id,
                             sessao_producao_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'acerto_recipiente',
          p_responsavel_id, p_sessao_id,
          'Embalagens do fornecedor conferidas no fechamento da produção.')
  RETURNING id INTO v_mov_id;

  FOR v_item IN
    SELECT (e->>'local_id')::UUID AS local_id,
           ROUND(COALESCE((e->>'restante')::DECIMAL, 0), 3) AS restante
      FROM jsonb_array_elements(p_itens) e
  LOOP
    SELECT COALESCE(SUM(quantidade), 0) INTO v_tinha
      FROM locais_lotes WHERE local_id = v_item.local_id;

    -- O item do movimento sai ANTES do ajuste: depois dele as quantidades já
    -- são as novas, e a diferença por lote não teria mais de onde ser lida.
    FOR v_linha IN
      SELECT ll.lote_id, ll.quantidade, ll.unidade
        FROM locais_lotes ll
       WHERE ll.local_id = v_item.local_id AND ll.quantidade > 0
    LOOP
      INSERT INTO movimentacoes_itens
        (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
      VALUES (v_mov_id, v_linha.lote_id, v_item.local_id,
              ROUND(v_linha.quantidade
                    * (1 - LEAST(v_item.restante / NULLIF(v_tinha, 0), 1)), 3),
              v_linha.unidade);
    END LOOP;

    PERFORM ajustar_conteudo_recipiente(v_item.local_id, v_item.restante);

    IF v_item.restante <= 0 THEN
      -- Foi para o lixo: não pode continuar aparecendo como ponto de consumo.
      -- Desativa, não exclui — `movimentacoes_itens` aponta para esta linha e o
      -- histórico da produção precisa continuar legível.
      UPDATE locais SET ativo = false, updated_at = NOW() WHERE id = v_item.local_id;
      v_encerradas := v_encerradas + 1;
    ELSE
      v_parciais := v_parciais + 1;
    END IF;

    v_diferenca := v_diferenca + GREATEST(v_tinha - v_item.restante, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'movimentacao',    v_mov_codigo,
    'encerradas',      v_encerradas,
    'ainda_tem',       v_parciais,
    'diferenca_total', ROUND(v_diferenca, 3)
  );
END;
$function$;

COMMENT ON FUNCTION registrar_embalagens_encerradas(UUID, UUID, UUID, JSONB) IS
  'Fecha a conta das embalagens do fornecedor no fim da produção: as que '
  'zeraram saem de cena, as que sobraram ficam com o que foi declarado. '
  'A diferença vira acerto de recipiente, nunca perda.';

REVOKE ALL ON FUNCTION registrar_embalagens_encerradas(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_embalagens_encerradas(UUID, UUID, UUID, JSONB)
  TO authenticated, service_role;

-- ============================================================
-- v_acerto_embalagem — o destino do número
--
-- Não entra no painel de perdas de propósito. A maior parte desta diferença é
-- o consumo TEÓRICO errando, não insumo perdido: se ela dá sempre para o mesmo
-- lado no mesmo insumo, quem está errada é a ficha; se dá para os dois lados,
-- é perda e variação de fornecedor. Somar isso à perda de produção esconderia
-- as duas respostas de uma vez.
-- ============================================================
CREATE OR REPLACE VIEW v_acerto_embalagem AS
SELECT m.empresa_id,
       date_trunc('month', m.created_at)::DATE       AS mes,
       i.id                                          AS insumo_id,
       i.codigo                                      AS insumo_codigo,
       i.nome                                        AS insumo_nome,
       i.unidade_medida                              AS unidade,
       COUNT(DISTINCT mi.local_origem_id)::INTEGER   AS embalagens,
       ROUND(SUM(mi.quantidade), 3)                  AS diferenca
  FROM movimentacoes m
  JOIN movimentacoes_itens mi ON mi.movimentacao_id = m.id
  JOIN locais l               ON l.id = mi.local_origem_id AND l.efemero
  JOIN lotes lo               ON lo.id = mi.lote_id
  JOIN insumos i              ON i.id = lo.insumo_id
 WHERE m.tipo = 'acerto_recipiente'
 GROUP BY m.empresa_id, date_trunc('month', m.created_at), i.id, i.codigo, i.nome, i.unidade_medida;

-- View nasce insegura: sem isto ela é legível sem login (migrations 050/051).
ALTER VIEW v_acerto_embalagem SET (security_invoker = true);

COMMENT ON VIEW v_acerto_embalagem IS
  'Quanto o sistema errou sobre as embalagens do fornecedor, por insumo e mês. '
  'Diferença sempre para o mesmo lado num insumo é sinal de ficha técnica '
  'desatualizada; para os dois lados, é perda e variação de fornecedor.';

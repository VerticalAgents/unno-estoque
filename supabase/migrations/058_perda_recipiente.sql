-- ============================================================
-- Migration 058 — Descartar o conteúdo de um recipiente
--
-- BUG
-- A tela oferecia "Descartar" no recipiente do EP mostrando o que há dentro
-- dele, mas `registrar_perda_insumo` validava contra
-- `lotes.quantidade_disponivel` — que é o saldo no ESTOQUE CENTRAL. Como
-- transferir para o pote já baixa o EC, um lote inteiramente transferido fica
-- com saldo 0 no EC enquanto o pote está cheio. Resultado: descartar
-- exatamente o que a tela dizia haver disponível voltava
-- "Quantidade a descartar maior que disponível."
--
-- E quando o lote AINDA tinha saldo no EC, era pior que um erro: a função
-- deixava passar e baixava o EC — estoque que existe de verdade na prateleira
-- — sem tirar nada do pote. O pote seguia cheio no sistema.
--
-- É o mesmo erro que a 036 corrigiu para o consumo de produção ("o consumo
-- baixa `locais_lotes`, nunca o EC"). O descarte ficou de fora na época.
--
-- SEGUNDO PROBLEMA: um recipiente pode ter vários lotes misturados (034), e a
-- tela mandava um único `lote_id` — o de validade mais próxima. Descartar
-- 4,8 kg de um balde com 3,6 de um lote e 1,2 de outro debitava 4,8 do
-- primeiro. Rastreabilidade falsa.
--
-- CORREÇÃO
-- `registrar_perda_recipiente` desconta do pote, rateando entre os lotes de
-- dentro na proporção do que cada um tinha — o mesmo tratamento da 036, e o
-- único honesto: depois de misturado ninguém sabe de qual lote veio cada grama.
-- Uma linha de perda por lote, para o histórico continuar apontando lotes reais.
-- ============================================================

-- Quantidade como gente lê: 10 em vez de 10.000, 4.8 em vez de 4.800.
-- Mensagem de erro com zero à toa faz o operador desconfiar do número.
CREATE OR REPLACE FUNCTION qtd_legivel(p_qtd DECIMAL)
RETURNS TEXT AS $$
  -- O FM já corta os zeros da direita, mas deixa o ponto órfão em "10." — daí
  -- o TRIM do '.' por fora.
  SELECT TRIM(TRAILING '.' FROM TRIM(to_char(COALESCE(p_qtd, 0), 'FM9999999990.999')));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION registrar_perda_recipiente(
  p_empresa_id     UUID,
  p_local_id       UUID,
  p_quantidade     DECIMAL,
  p_motivo         TEXT,
  p_descricao      TEXT,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_local        RECORD;
  v_total        DECIMAL := 0;
  v_linha        RECORD;
  v_mov_codigo   TEXT;
  v_mov_id       UUID;
  v_perda_codigo TEXT;
  v_cota         DECIMAL;
  v_acumulado    DECIMAL := 0;
  v_restantes    INTEGER;
  v_lotes        INTEGER := 0;
BEGIN
  SELECT l.id, l.nome, l.insumo_id, l.tipo, i.unidade_medida
    INTO v_local
    FROM locais l
    JOIN insumos i ON i.id = l.insumo_id
   WHERE l.id = p_local_id AND l.empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Recipiente não encontrado.');
  END IF;

  IF v_local.tipo <> 'estoque_produtivo' THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      'Este local não é um recipiente do estoque produtivo.');
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe uma quantidade maior que zero.');
  END IF;

  SELECT COALESCE(SUM(quantidade), 0) INTO v_total
    FROM locais_lotes
   WHERE local_id = p_local_id AND quantidade > 0;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('%s já está vazio.', v_local.nome));
  END IF;

  -- Tolerância de 1 g: o rateio proporcional deixa poeira de arredondamento, e
  -- quem clica em "descartar tudo" não deve ser barrado por um milésimo.
  IF p_quantidade > v_total + 0.001 THEN
    RETURN jsonb_build_object('ok', false, 'erro',
      format('O recipiente tem %s %s. Não é possível descartar %s.',
             qtd_legivel(v_total),
             v_local.unidade_medida,
             qtd_legivel(p_quantidade)));
  END IF;

  p_quantidade := LEAST(p_quantidade, v_total);

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id, observacoes)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'perda_insumo',
          p_responsavel_id, p_descricao)
  RETURNING id INTO v_mov_id;

  SELECT COUNT(*) INTO v_restantes
    FROM locais_lotes WHERE local_id = p_local_id AND quantidade > 0;

  FOR v_linha IN
    SELECT ll.lote_id, ll.quantidade, COALESCE(ll.unidade, v_local.unidade_medida) AS unidade
      FROM locais_lotes ll
     WHERE ll.local_id = p_local_id AND ll.quantidade > 0
     ORDER BY ll.validade_ep NULLS LAST, ll.data_transferencia
  LOOP
    v_restantes := v_restantes - 1;

    -- O último lote absorve a sobra do arredondamento, para a soma das cotas
    -- bater exatamente com o que foi descartado.
    IF v_restantes = 0 THEN
      v_cota := p_quantidade - v_acumulado;
    ELSE
      v_cota := ROUND(p_quantidade * (v_linha.quantidade / v_total), 3);
    END IF;

    v_cota := LEAST(v_cota, v_linha.quantidade);
    CONTINUE WHEN v_cota <= 0;
    v_acumulado := v_acumulado + v_cota;

    v_perda_codigo := gerar_proximo_codigo(p_empresa_id, 'perdas_insumo', 'PERDA');
    INSERT INTO perdas_insumo (
      empresa_id, codigo, data, lote_id, insumo_id, local_id,
      quantidade, unidade, motivo, descricao, responsavel_id
    ) VALUES (
      p_empresa_id, v_perda_codigo, CURRENT_DATE, v_linha.lote_id,
      v_local.insumo_id, p_local_id,
      v_cota, v_linha.unidade, p_motivo::motivo_perda_enum,
      p_descricao, p_responsavel_id
    );

    INSERT INTO movimentacoes_itens
      (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
    VALUES (v_mov_id, v_linha.lote_id, p_local_id, v_cota, v_linha.unidade);

    -- Baixa no RECIPIENTE, nunca no estoque central (ver cabeçalho).
    UPDATE locais_lotes
       SET quantidade = GREATEST(quantidade - v_cota, 0)
     WHERE local_id = p_local_id AND lote_id = v_linha.lote_id;

    v_lotes := v_lotes + 1;
  END LOOP;

  -- Linha zerada não é conteúdo: sai, senão o pote continua "ocupado" por um
  -- lote de saldo 0 e a transferência recusa marca diferente.
  DELETE FROM locais_lotes WHERE local_id = p_local_id AND quantidade <= 0;

  RETURN jsonb_build_object(
    'ok', true,
    'quantidade_descartada', v_acumulado,
    'lotes_afetados', v_lotes,
    'movimentacao', v_mov_codigo
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_perda_recipiente IS
  'Descarta conteúdo de um recipiente do EP, rateando entre os lotes '
  'misturados dentro dele. Baixa locais_lotes, nunca o estoque central.';

-- ============================================================
-- registrar_perda_insumo — mesma armadilha, pela outra porta
--
-- A tela "Registrar Perda" deixa escolher um lote e, opcionalmente, o local
-- onde ele estava. Escolhido um recipiente do EP, a função baixava o EC do
-- mesmo jeito. Passa a baixar onde a perda de fato aconteceu.
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_perda_insumo(
  p_empresa_id     UUID,
  p_lote_id        UUID,
  p_insumo_id      UUID,
  p_local_id       UUID,
  p_quantidade     DECIMAL,
  p_unidade        TEXT,
  p_motivo         TEXT,
  p_descricao      TEXT,
  p_responsavel_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_perda_codigo TEXT;
  v_perda_id     UUID;
  v_mov_codigo   TEXT;
  v_mov_id       UUID;
  v_lote         lotes%ROWTYPE;
  v_no_pote      DECIMAL;
  v_ep           BOOLEAN := false;
  v_nome_local   TEXT;
BEGIN
  SELECT * INTO v_lote FROM lotes WHERE id = p_lote_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Lote não encontrado.');
  END IF;

  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Informe uma quantidade maior que zero.');
  END IF;

  IF p_local_id IS NOT NULL THEN
    SELECT (tipo = 'estoque_produtivo'), nome INTO v_ep, v_nome_local
      FROM locais WHERE id = p_local_id AND empresa_id = p_empresa_id;
    v_ep := COALESCE(v_ep, false);
  END IF;

  IF v_ep THEN
    SELECT COALESCE(quantidade, 0) INTO v_no_pote
      FROM locais_lotes WHERE local_id = p_local_id AND lote_id = p_lote_id;

    IF COALESCE(v_no_pote, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s não está em %s.', v_lote.codigo, COALESCE(v_nome_local, 'neste recipiente')));
    END IF;

    IF p_quantidade > v_no_pote + 0.001 THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('%s tem %s deste lote. Não é possível descartar %s.',
               COALESCE(v_nome_local, 'O recipiente'),
               qtd_legivel(v_no_pote),
               qtd_legivel(p_quantidade)));
    END IF;

    p_quantidade := LEAST(p_quantidade, v_no_pote);
  ELSE
    IF v_lote.quantidade_disponivel < p_quantidade THEN
      RETURN jsonb_build_object('ok', false, 'erro',
        format('O lote %s tem %s %s no estoque central. Não é possível descartar %s.',
               v_lote.codigo,
               qtd_legivel(v_lote.quantidade_disponivel),
               v_lote.unidade,
               qtd_legivel(p_quantidade)));
    END IF;
  END IF;

  v_perda_codigo := gerar_proximo_codigo(p_empresa_id, 'perdas_insumo', 'PERDA');
  INSERT INTO perdas_insumo (
    empresa_id, codigo, lote_id, insumo_id, local_id,
    quantidade, unidade, motivo, descricao, responsavel_id
  ) VALUES (
    p_empresa_id, v_perda_codigo, p_lote_id, p_insumo_id, p_local_id,
    p_quantidade, p_unidade::unidade_medida_enum,
    p_motivo::motivo_perda_enum, p_descricao, p_responsavel_id
  ) RETURNING id INTO v_perda_id;

  IF v_ep THEN
    UPDATE locais_lotes
       SET quantidade = GREATEST(quantidade - p_quantidade, 0)
     WHERE local_id = p_local_id AND lote_id = p_lote_id;

    DELETE FROM locais_lotes WHERE local_id = p_local_id AND quantidade <= 0;
  ELSE
    UPDATE lotes
       SET quantidade_disponivel = quantidade_disponivel - p_quantidade,
           status = CASE
             WHEN quantidade_disponivel - p_quantidade <= 0 THEN 'descartado'::status_lote_enum
             ELSE status
           END
     WHERE id = p_lote_id;
  END IF;

  v_mov_codigo := gerar_proximo_codigo(p_empresa_id, 'movimentacoes', 'MOV');
  INSERT INTO movimentacoes (id, empresa_id, codigo, tipo, responsavel_id)
  VALUES (uuid_generate_v4(), p_empresa_id, v_mov_codigo, 'perda_insumo', p_responsavel_id)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimentacoes_itens (movimentacao_id, lote_id, local_origem_id, quantidade, unidade)
  VALUES (v_mov_id, p_lote_id, p_local_id, p_quantidade, p_unidade::unidade_medida_enum);

  RETURN jsonb_build_object('ok', true, 'perda_id', v_perda_id, 'codigo', v_perda_codigo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION registrar_perda_insumo IS
  'Registra perda de insumo. Perda em recipiente do EP baixa locais_lotes; '
  'perda no estoque central baixa lotes.quantidade_disponivel.';

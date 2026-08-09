-- ============================================================
-- Migration 079 — Empresa nova nasce com motivos de descarte
--
-- Os motivos são por empresa. A função que cria os padrões existe desde a 054,
-- mas só foi executada para as empresas que existiam naquele dia: não há
-- gatilho nenhum. Uma empresa criada depois abre a Pós-produção e encontra a
-- tela sem coluna alguma — não dá para registrar descarte, e nada explica por
-- quê.
--
-- Os seis padrões da 054 são de padaria ("Assado em demasia", "Corte torto").
-- Servir isso a todo cliente novo é o mesmo erro de colocar dado de um cliente
-- na migration, só que disfarçado de padrão. A empresa nova nasce com três
-- motivos que valem para qualquer produção, e edita em Configurações.
-- ============================================================

CREATE OR REPLACE FUNCTION inicializar_motivos_descarte_padrao(p_empresa_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO motivos_descarte (empresa_id, codigo, nome, ordem) VALUES
    (p_empresa_id, 'fora_padrao',    'Fora do padrão', 1),
    (p_empresa_id, 'corpo_estranho', 'Corpo estranho', 2),
    (p_empresa_id, 'quebrado',       'Quebrado',       3)
  ON CONFLICT (empresa_id, codigo) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION inicializar_motivos_descarte_padrao(UUID) IS
  'Motivos genéricos para uma empresa nova não encontrar a Pós-produção vazia. '
  'Deliberadamente curtos e neutros: o vocabulário de cada produção se ajusta '
  'em Configurações.';

CREATE OR REPLACE FUNCTION trg_empresa_nasce_com_motivos()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM inicializar_motivos_descarte_padrao(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS empresa_nasce_com_motivos ON empresas;
CREATE TRIGGER empresa_nasce_com_motivos
  AFTER INSERT ON empresas
  FOR EACH ROW EXECUTE FUNCTION trg_empresa_nasce_com_motivos();

-- Empresas que já existem e ficaram sem nenhum motivo (o buraco que o gatilho
-- fecha daqui para frente). Quem já tem os seus não é tocado.
DO $$
DECLARE v_emp RECORD;
BEGIN
  FOR v_emp IN
    SELECT e.id FROM empresas e
    WHERE NOT EXISTS (SELECT 1 FROM motivos_descarte m WHERE m.empresa_id = e.id)
  LOOP
    PERFORM inicializar_motivos_descarte_padrao(v_emp.id);
  END LOOP;
END $$;

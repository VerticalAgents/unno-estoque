import { supabase } from './supabase'

/**
 * Cancelar uma sessão de produção.
 *
 * Cancelar é diferente de fechar: fechar registra o que foi produzido e gera o
 * lote; cancelar diz que aquela produção não aconteceu, e devolve aos
 * recipientes tudo que a abertura descontou deles (migration 086).
 *
 * A linha da sessão não é apagada — mesma decisão do cancelamento de contagem
 * em `contagem.ts`. Uma sessão que some não deixa rastro de que alguém a
 * abriu, e o motivo escrito é o que explica o buraco na numeração depois.
 *
 * Existe porque desde a 085 o insumo sai dos potes na ABERTURA: uma sessão
 * aberta por engano ficava com o estoque descontado para sempre, e como só
 * pode haver uma sessão aberta por vez, ela ainda bloqueava a abertura da
 * sessão certa.
 */
export async function cancelarSessao(
  sessaoId: string,
  empresaId: string,
  responsavelId: string,
  motivo: string,
): Promise<{ erro: string | null; devolvidos: number }> {
  const { data, error } = await supabase.rpc('cancelar_sessao_producao', {
    p_sessao_id:      sessaoId,
    p_empresa_id:     empresaId,
    p_responsavel_id: responsavelId,
    p_motivo:         motivo,
  })

  const resp = data as { ok: boolean; erro?: string; recipientes?: number } | null

  if (error || !resp?.ok) {
    return {
      erro: resp?.erro ?? error?.message ?? 'Não foi possível cancelar a sessão.',
      devolvidos: 0,
    }
  }
  return { erro: null, devolvidos: Number(resp.recipientes ?? 0) }
}

/**
 * O aviso, igual nas duas telas que oferecem cancelar.
 *
 * O que ele precisa dizer não é "tem certeza" — o modal já pergunta isso. É a
 * consequência que ninguém adivinha: o insumo volta para os potes NO SISTEMA,
 * e o sistema não tem como saber se a produção já usou parte dele. Se já usou,
 * o estoque fica maior que a prateleira até a próxima contagem.
 */
export function avisoCancelamentoSessao(): string {
  return 'Todo o insumo descontado na abertura volta para os recipientes. '
       + 'Se a produção já rodou e consumiu parte dele, o sistema vai ficar com '
       + 'mais insumo do que existe na prateleira, e só a contagem acerta isso. '
       + 'Cancele quando a produção não aconteceu.'
}

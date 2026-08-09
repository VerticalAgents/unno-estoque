import { supabase } from './supabase'

/**
 * Cancelar uma contagem.
 *
 * Cancelar é diferente de encerrar: encerrar leva ao resumo, onde a diferença
 * pode ser aplicada ao estoque. Cancelada não aplica nada — o que foi digitado
 * fica registrado como histórico e o estoque continua exatamente como estava.
 *
 * A linha não é apagada de propósito. Uma contagem que some não deixa rastro de
 * que alguém passou o dia contando, e o histórico é justamente o que responde
 * "quando foi a última vez que conferimos isto?".
 *
 * Estava faltando: uma contagem começada por engano ficava aberta para sempre,
 * e o botão de iniciar recusava criar outra enquanto ela existisse.
 */
export async function cancelarContagem(id: string): Promise<string | null> {
  const { error } = await supabase
    .from('contagens')
    .update({ status: 'cancelada', finalizada_at: new Date().toISOString() })
    .eq('id', id)
  return error?.message ?? null
}

/**
 * O texto do aviso, igual nas três telas que oferecem cancelar.
 *
 * Afirmação, não pergunta: a pergunta já está no título do modal, e repetir
 * faz o usuário ler duas vezes a mesma coisa para achar a informação nova —
 * que é o número de insumos que ele perde.
 */
export function avisoCancelamento(conferidos: number): string {
  return conferidos > 0
    ? `Os ${conferidos} insumo${conferidos > 1 ? 's' : ''} já conferido${conferidos > 1 ? 's' : ''} `
      + 'serão descartados, e o estoque continua como está.'
    : 'Nada foi conferido ainda. O estoque continua como está.'
}

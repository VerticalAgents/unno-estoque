/**
 * A unidade da bancada — a da balança, não a do cadastro.
 *
 * O insumo é cadastrado em kg, mas quem pesa lê "350" no visor. Pedir "0,350"
 * obriga a uma conversão de cabeça no meio da produção, e um zero a mais ou a
 * menos vira 3,5 kg de erro sem ninguém perceber.
 *
 * O banco continua guardando na unidade do cadastro: a conversão é só na tela.
 *
 * Insumo já cadastrado em g, ml ou unid não converte — e a TARA só se aplica
 * onde a bancada é grama. Descontar um peso em gramas de um volume em mL
 * exigiria a densidade, e de "unidades" não faz sentido nenhum.
 */
export function bancada(unidade: string): { rotulo: string; fator: number } {
  const u = (unidade ?? '').toLowerCase()
  if (u === 'kg') return { rotulo: 'g',  fator: 1000 }
  if (u === 'l')  return { rotulo: 'ml', fator: 1000 }
  return { rotulo: unidade ?? '', fator: 1 }
}

/** `true` quando faz sentido descontar a tara do recipiente. */
export function usaTara(unidade: string): boolean {
  return bancada(unidade).rotulo === 'g'
}

/**
 * Converte para a unidade da bancada e formata.
 *
 * Em gramas não se usa separador de milhar: "17.000" em português é exatamente
 * como 17,000 kg aparece, e os dois números conviveriam na mesma tela.
 * "17000 g" não deixa dúvida.
 */
export function emBancada(valor: number, fator: number): string {
  const x = (valor ?? 0) * fator
  return fator === 1 ? x.toFixed(3) : String(Math.round(x * 1000) / 1000)
}

/**
 * O caminho de volta: o que foi digitado na bancada, na unidade do cadastro.
 *
 * O arredondamento evita que 350 g vire 0.35000000000000003 kg — resíduo de
 * ponto flutuante que depois aparece somado em relatório.
 */
export function daBancada(valorNaBancada: number, fator: number): number {
  return Number(((valorNaBancada || 0) / fator).toFixed(6))
}

/**
 * Busca que perdoa acento, cedilha e caixa.
 *
 * Quem procura "acucar" na correria da produção não vai parar para achar o
 * cedilha e o til no teclado do celular — e antes disso a lista simplesmente
 * não devolvia nada, como se o insumo não existisse.
 *
 * `normalize('NFD')` separa a letra do sinal ("ç" vira "c" + cedilha solto,
 * "ú" vira "u" + acento solto) e o replace joga fora os sinais. É por isso que
 * o cedilha entra de graça: para o Unicode ele é um acento como outro
 * qualquer.
 *
 * `\p{Diacritic}` em vez do intervalo U+0300–U+036F escrito à mão: o intervalo
 * exige digitar os próprios acentos soltos no código, que ficam INVISÍVEIS no
 * editor — e um caractere que ninguém enxerga é a coisa mais fácil do mundo de
 * apagar sem querer.
 */
export function normalizar(texto: string | null | undefined): string {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * O item combina com o que foi digitado?
 *
 * Busca vazia devolve `true` — quem não digitou nada quer ver tudo.
 *
 * Cada palavra é procurada por conta própria, em qualquer um dos campos: assim
 * "refinado acucar" acha "Açúcar Refinado", e "0002 acucar" acha o lote pelo
 * código e pelo nome ao mesmo tempo. A ordem em que se digita não devia
 * importar, e agora não importa.
 */
export function combina(busca: string, ...campos: (string | null | undefined)[]): boolean {
  const palavras = normalizar(busca).split(/\s+/).filter(Boolean)
  if (palavras.length === 0) return true

  const alvo = campos.map(normalizar).join(' ')
  return palavras.every((p) => alvo.includes(p))
}

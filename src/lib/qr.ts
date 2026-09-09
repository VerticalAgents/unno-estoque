import { supabase } from './supabase'

/**
 * Extrai o código do lote a partir do valor escaneado do QR.
 *
 * Formatos aceitos:
 *   "QR-INS001-0002.15/15"                      (legado: valor literal de lotes.qr_code)
 *   "INS001-0002.15/15|2026-04-10|123456"       (etiqueta impressa com data + NF)
 *   "INS001-0002.15/15"                         (só o código)
 *
 * Retorna o codigo do lote, pronto pra buscar em lotes.codigo.
 */
export function parseQRLoteCodigo(qr: string): string {
  const bruto = qr.replace(/^QR-/i, '').split('|')[0].trim()
  return normalizarCodigoLote(bruto) ?? bruto
}

/**
 * Põe no formato do banco o que a pessoa digitou à mão.
 *
 * Quem digita está digitando porque o QR não leu — está na bancada, com a
 * embalagem numa mão e o celular na outra. Exigir maiúscula, o traço, o ponto,
 * a barra e os zeros à esquerda é transformar uma saída de emergência em outro
 * obstáculo. Tudo isto vira `INS014-0005.1/2`:
 *
 *   ins014-0005.1/2 · INS014 0005 1 2 · 14-5.1/2 · ins0140005.1.2
 *
 * A conversão é aritmética, não adivinhação: todo código de lote do banco tem
 * a mesma forma — INS + 3 dígitos, hífen, 4 dígitos, e o par `n/m` da unidade.
 * Só os números importam; o resto é pontuação.
 *
 * Devolve `null` quando não sobra número suficiente para montar um código —
 * é o caso das etiquetas de recipiente da cozinha, que são hexadecimais e não
 * podem passar por aqui.
 */
export function normalizarCodigoLote(entrada: string): string | null {
  const grupos = entrada
    .toUpperCase()
    // Ponto, barra, traço, vírgula e espaço dizem todos a mesma coisa: acabou
    // um número, começou outro.
    .replace(/[^A-Z0-9]+/g, ' ')
    // "INS0140005" digitado sem separador continua sendo INS + 3 + 4.
    .replace(/\bINS ?(\d{3})(\d{4})\b/, ' $1 $2 ')
    .replace(/INS/g, ' ')
    .split(/\s+/)
    .filter(t => /^\d+$/.test(t))
    .map(t => parseInt(t, 10))

  if (grupos.length < 2) return null

  const [insumo, lote, unidade, total] = grupos
  const base = `INS${String(insumo).padStart(3, '0')}-${String(lote).padStart(4, '0')}`
  return unidade !== undefined && total !== undefined
    ? `${base}.${unidade}/${total}`
    : base
}

/**
 * O código sem a parte que já está escrita ao lado: `INS014-0005.1/2` vira
 * `0005.1/2`.
 *
 * No celular a linha inteira não cabe e o navegador corta justamente o fim —
 * que é a única parte que distingue um balde do outro. O `INS014` é o insumo,
 * e o nome do insumo está logo acima em português.
 */
export function codigoCurtoLote(codigo: string): string {
  return codigo.match(/INS\d{3}-(\d{4}(?:\.\d+\/\d+)?)/)?.[1] ?? codigo
}

/** "Doce de Leite · INS014-0005.1/2" → "Doce de Leite". */
export function nomeSemCodigo(nome: string): string {
  return nome.split('·')[0].trim()
}

/** O QR fixo de um ponto de consumo que É a embalagem de um lote. */
export function qrDaEmbalagem(codigoLote: string): string {
  return `QR-LOTE-${codigoLote}`
}

/**
 * Acha o ponto de consumo (EP) que um QR representa.
 *
 * Duas etiquetas diferentes chegam aqui. A do recipiente da cozinha, com QR
 * próprio; e a do LOTE, colada na embalagem do fornecedor desde o recebimento —
 * quando o pacote é o próprio ponto de consumo (migration 073), não existe
 * etiqueta de recipiente para colar, e nem faria sentido criar uma segunda
 * identidade para a mesma coisa física.
 *
 * Por isso a busca tem dois passos: o QR fixo do recipiente e, se não achar, o
 * QR derivado do código do lote.
 */
export async function resolverLocalPorQr<T = { id: string }>(
  qr: string,
  select = '*',
): Promise<T | null> {
  const busca = (valor: string) =>
    supabase.from('locais').select(select).eq('qr_code_fixo', valor).eq('ativo', true).maybeSingle()

  const { data: direto } = await busca(qr)
  if (direto) return direto as T

  // Digitado em minúscula. As etiquetas de recipiente da cozinha são
  // hexadecimais e não passam pelo normalizador de código de lote.
  if (qr !== qr.toUpperCase()) {
    const { data: maiuscula } = await busca(qr.toUpperCase())
    if (maiuscula) return maiuscula as T
  }

  const { data: porLote } = await busca(qrDaEmbalagem(parseQRLoteCodigo(qr)))
  return (porLote as T | null) ?? null
}

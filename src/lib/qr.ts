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
  return qr.replace(/^QR-/, '').split('|')[0].trim()
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

  const { data: porLote } = await busca(qrDaEmbalagem(parseQRLoteCodigo(qr)))
  return (porLote as T | null) ?? null
}

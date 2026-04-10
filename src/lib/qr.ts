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

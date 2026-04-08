import type { UnidadeMedida } from '../types/database.types'

// ── Date formatting ──────────────────────────────────────────

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return '—'
  const d = typeof date === 'string'
    ? new Date(date.length === 10 ? date + 'T00:00:00' : date)
    : date
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('pt-BR')
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export function toInputDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date
  return d.toISOString().split('T')[0]
}

export function today(): string {
  return new Date().toISOString().split('T')[0]
}

export function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// ── Quantity formatting ──────────────────────────────────────

export function formatQty(qty: number, unit: UnidadeMedida): string {
  const formatted = qty % 1 === 0 ? qty.toString() : qty.toFixed(3).replace(/\.?0+$/, '')
  return `${formatted} ${unit}`
}

export function formatKg(kg: number): string {
  if (kg < 1) return `${(kg * 1000).toFixed(0)} g`
  return `${kg.toFixed(kg % 1 === 0 ? 0 : 3).replace(/\.?0+$/, '')} kg`
}

// ── QR Code helpers ──────────────────────────────────────────

export function isQrLote(qr: string): boolean {
  return qr.startsWith('QR-LOTE-')
}

export function isQrLocal(qr: string): boolean {
  return qr.startsWith('QR-LOCAL-') || qr.startsWith('QR-EP-')
}

export function isQrUnidade(qr: string): boolean {
  return qr.startsWith('QR-REMB-')
}

// ── Validity badge ───────────────────────────────────────────

export type ValidityStatus = 'ok' | 'warning' | 'danger' | 'expired'

export function getValidityStatus(validadePosAbertura: string): ValidityStatus {
  const days = daysUntil(validadePosAbertura)
  if (days < 0) return 'expired'
  if (days <= 3) return 'danger'
  if (days <= 7) return 'warning'
  return 'ok'
}

export function validityLabel(days: number): string {
  if (days < 0) return 'Vencido'
  if (days === 0) return 'Vence hoje'
  if (days === 1) return 'Vence amanhã'
  return `${days} dias`
}

// ── FIFO check ───────────────────────────────────────────────

export function isFifoWarning(selectedDate: string, oldestDate: string): boolean {
  return new Date(selectedDate) > new Date(oldestDate)
}

// ── Reembalagem helpers ──────────────────────────────────────

export const INSUMOS_COM_REEMBALAGEM = {
  NUTELLA: 'INS027',
  DDL: 'INS014',
  STIKADINHO: 'INS023',
}

export function precisaReembalagem(codigoInsumo: string): boolean {
  return Object.values(INSUMOS_COM_REEMBALAGEM).includes(codigoInsumo)
}

export function precisaDestinoMultiplo(codigoInsumo: string): boolean {
  return codigoInsumo === INSUMOS_COM_REEMBALAGEM.DDL
}

// ── Calculates number of sacos from kg ───────────────────────

export function calcSacos(kgTotal: number, tamanhoGramas: number): { qtd: number; sobra: number } {
  const totalGramas = kgTotal * 1000
  const qtd = Math.floor(totalGramas / tamanhoGramas)
  const sobra = totalGramas - qtd * tamanhoGramas
  return { qtd, sobra }
}

// ── Deviation badge ──────────────────────────────────────────

export type DesvioStatus = 'ok' | 'warning' | 'danger'

export function getDesvioStatus(consumoReal: number, consumoTeorico: number): DesvioStatus {
  if (consumoTeorico === 0) return 'ok'
  const pct = Math.abs(consumoReal - consumoTeorico) / consumoTeorico
  if (pct <= 0.05) return 'ok'
  if (pct <= 0.15) return 'warning'
  return 'danger'
}

// ── Truncate text ────────────────────────────────────────────

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str
}

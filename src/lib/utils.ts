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

/**
 * A segunda-feira da semana que o planejamento deve abrir, em YYYY-MM-DD.
 *
 * No sábado ou domingo devolve a semana que vem: quem planeja no fim de semana
 * está planejando a semana seguinte, e abrir na que já acabou seria mostrar
 * trabalho feito.
 *
 * Datas montadas componente a componente de propósito — `new Date('2026-08-03')`
 * é meia-noite UTC, que no Brasil cai no dia 2.
 */
export function semanaDeTrabalho(): string {
  const d = new Date()
  const dow = d.getDay()                       // 0 = domingo
  if (dow === 0 || dow === 6) d.setDate(d.getDate() + 2)
  const dow2 = d.getDay()
  d.setDate(d.getDate() + (dow2 === 0 ? -6 : 1 - dow2))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// ── Quantity formatting ──────────────────────────────────────

/**
 * Número em português: vírgula decimal e ponto de milhar.
 *
 * `toFixed` fala inglês. A tela mostrava "1654.83 kg" para mil seiscentos e
 * cinquenta e quatro quilos — ponto onde devia ter vírgula, e nenhum separador
 * de milhar. Num número de quatro dígitos isso não é estética: "1654.83" se lê
 * como mil e seiscentos com esforço, "1.654,83" se lê de relance.
 *
 * `max` é o teto de casas, não o piso: 190 continua "190", não "190,000".
 */
function numeroBR(n: number, max = 3): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: max })
}

export function formatQty(qty: number, unit: UnidadeMedida): string {
  return `${numeroBR(qty)} ${unit}`
}

/**
 * Peso em quilos — ou em gramas, quando é menos de um quilo.
 *
 * Duas casas, e não três: quem lê o total do estoque quer a ordem de grandeza,
 * e o miligrama ali é ruído. O detalhe fica na linha do insumo.
 */
export function formatKg(kg: number): string {
  if (kg < 1) return `${numeroBR(kg * 1000, 0)} g`
  return `${numeroBR(kg, 2)} kg`
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

// ── Porcionamento ────────────────────────────────────────────
//
// Aqui havia uma lista de códigos de insumo — INS027, INS014, INS023 — que
// decidia quais passavam por reembalagem. Cadastrar o quarto insumo porcionado
// exigia editar o código. Agora quem decide é `modo_ep` no cadastro do insumo
// (migration 073).

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

// ── Ordem natural ────────────────────────────────────────────

/**
 * Comparador para códigos e nomes numerados: INS2 antes de INS10.
 *
 * É o gêmeo em JavaScript da função `chave_natural` do banco (migration 053).
 * Existe porque nem toda lista dá para reordenar no SQL — listas já gravadas,
 * como os insumos de uma contagem antiga, só têm conserto na exibição.
 */
export function ordemNatural(a: string, b: string): number {
  return (a ?? '').localeCompare(b ?? '', 'pt-BR', { numeric: true, sensitivity: 'base' })
}

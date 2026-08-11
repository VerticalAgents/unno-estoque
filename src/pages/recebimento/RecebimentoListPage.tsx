import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Lote } from '../../types/database.types'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { StatusBadge } from '../../components/ui/Badge'
import { formatDate, formatQty, daysUntil, getValidityStatus } from '../../lib/utils'
import { combina } from '../../lib/busca'

type LoteRow = Lote & { insumo: { nome: string; unidade_medida: string } }

type StatusGroup = 'ativo' | 'esgotado' | 'inativo'

function getStatusGroup(status: string): StatusGroup {
  if (status === 'ativo') return 'ativo'
  if (status === 'esgotado') return 'esgotado'
  return 'inativo' // descartado | vencido
}

/**
 * Chave de agrupamento: lotes criados no mesmo recebimento (mesmo RPC call)
 * têm insumo_id, data_recebimento, validade_original, fornecedor_id idênticos
 * E created_at dentro do mesmo minuto (mesma transação DB).
 */
function getGrupoKey(lote: LoteRow): string {
  const minuto = lote.created_at.substring(0, 16) // "YYYY-MM-DDTHH:MM"
  return [lote.insumo_id, lote.data_recebimento, lote.validade_original, lote.fornecedor_id ?? '', minuto].join('|')
}

function agruparLotes(lotes: LoteRow[]): { key: string; lotes: LoteRow[] }[] {
  const map = new Map<string, LoteRow[]>()
  for (const lote of lotes) {
    const key = getGrupoKey(lote)
    const arr = map.get(key) ?? []
    arr.push(lote)
    map.set(key, arr)
  }
  return Array.from(map.entries()).map(([key, lotes]) => ({ key, lotes }))
}

// ── Print icon ───────────────────────────────────────────────

const PrintIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
  </svg>
)

// ── Card de grupo/lote unificado ─────────────────────────────

interface GrupoCardProps {
  grupo: { key: string; lotes: LoteRow[] }
  expanded: boolean
  onToggle: () => void
  onCancelar: (loteId: string) => void
  onPrintGrupo: (lotes: LoteRow[]) => void
  confirmId: string | null
  setConfirmId: (id: string | null) => void
  cancelando: string | null
}

function GrupoCard({
  grupo,
  expanded,
  onToggle,
  onCancelar,
  onPrintGrupo,
  confirmId,
  setConfirmId,
  cancelando,
}: GrupoCardProps) {
  const { lotes: gl } = grupo
  const rep = gl[0]
  const isSingle = gl.length === 1
  const singleLote = isSingle ? gl[0] : null

  const qtdDisponivel = gl.reduce((s, l) => s + l.quantidade_disponivel, 0)
  const qtdRecebida = gl.reduce((s, l) => s + l.quantidade_recebida, 0)
  const todosMesmoStatus = gl.every(l => l.status === gl[0].status)
  const statusGroup = getStatusGroup(rep.status)

  // Para grupo: pendente se qualquer sublote ativo sem etiqueta
  const grupoSemEtiqueta = gl.some(l => l.status === 'ativo' && !l.etiqueta_impressa)

  // Validade alert para lote único
  const validityStatus = singleLote ? getValidityStatus(singleLote.validade_original) : 'ok'
  const days = singleLote ? daysUntil(singleLote.validade_original) : 0

  // Card background por status
  const cardBg =
    statusGroup === 'inativo' ? 'border-red-100 bg-red-50/40' :
    statusGroup === 'esgotado' ? 'border-gray-200 bg-gray-50' :
    ''

  // Código exibido no subtítulo
  const codigoSubtitle = isSingle
    ? rep.codigo
    : gl.length <= 3
      ? gl.map(l => l.codigo).join(' · ')
      : `${gl[0].codigo} … ${gl[gl.length - 1].codigo}`

  return (
    <div className={`rounded-xl border overflow-hidden ${cardBg || 'border-gray-200 bg-white'} shadow-sm`}>
      {/* Header do card — clicável para expandir se grupo */}
      <div
        className={`p-4 flex items-start gap-3 ${!isSingle ? 'cursor-pointer hover:bg-black/[0.02] transition-colors' : ''}`}
        onClick={!isSingle ? onToggle : undefined}
      >
        {/* Info principal */}
        <div className="flex-1 min-w-0">
          {/* Linha 1: nome + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">{rep.insumo?.nome}</span>
            {todosMesmoStatus && <StatusBadge status={rep.status} />}
            {!isSingle && (
              <span className="inline-flex items-center text-xs font-medium text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full">
                {gl.length} sublotes
              </span>
            )}
            {/* Badge etiqueta pendente (só para ativos) */}
            {statusGroup === 'ativo' && grupoSemEtiqueta && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                Sem etiqueta
              </span>
            )}
            {/* Validade alerts (lote único) */}
            {singleLote && validityStatus === 'danger' && (
              <span className="text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Vence em {days}d</span>
            )}
            {singleLote && validityStatus === 'warning' && (
              <span className="text-xs font-medium text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded-full">Vence em {days}d</span>
            )}
          </div>

          {/* Linha 2: código(s) */}
          <p className="font-mono text-xs text-gray-400 mt-0.5">{codigoSubtitle}</p>

          {/* Linha 3: detalhes */}
          <div className="flex gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            <span>Recebido: {formatDate(rep.data_recebimento)}</span>
            <span>Validade: {formatDate(rep.validade_original)}</span>
            <span>
              Disponível: {formatQty(qtdDisponivel, rep.unidade)}
              {qtdDisponivel !== qtdRecebida && (
                <span className="ml-1 text-gray-300">/ {formatQty(qtdRecebida, rep.unidade)} recebidos</span>
              )}
            </span>
            {rep.numero_nf && (
              <span className="text-gray-400">NF {rep.numero_nf}</span>
            )}
            {rep.temperatura_recebimento != null && (
              <span className="text-cyan-600 font-medium">{rep.temperatura_recebimento} °C</span>
            )}
          </div>
        </div>

        {/* Ações */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {/* Botão imprimir */}
          {isSingle && singleLote ? (
            <Link
              to={`/recebimento/imprimir/${singleLote.id}`}
              className={`p-2 rounded-lg transition-colors ${
                singleLote.status === 'ativo' && !singleLote.etiqueta_impressa
                  ? 'text-amber-500 hover:bg-amber-50'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              }`}
              title={singleLote.status === 'ativo' && !singleLote.etiqueta_impressa ? 'Etiqueta ainda não impressa — clique para imprimir' : 'Imprimir etiqueta'}
            >
              <PrintIcon />
            </Link>
          ) : (
            <button
              onClick={() => onPrintGrupo(gl)}
              className={`p-2 rounded-lg transition-colors ${
                grupoSemEtiqueta
                  ? 'text-amber-500 hover:bg-amber-50'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              }`}
              title={grupoSemEtiqueta ? 'Há sublotes sem etiqueta — clique para imprimir' : 'Imprimir todas as etiquetas'}
            >
              <PrintIcon />
            </button>
          )}

          {/* Cancelar (só lote único ativo) */}
          {isSingle && singleLote && singleLote.status === 'ativo' && (
            confirmId === singleLote.id ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onCancelar(singleLote.id)}
                  disabled={cancelando === singleLote.id}
                  className="px-2 py-1 text-xs font-medium bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
                >
                  {cancelando === singleLote.id ? '...' : 'Confirmar'}
                </button>
                <button onClick={() => setConfirmId(null)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">
                  Não
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmId(singleLote.id)}
                className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"
                title="Cancelar lote"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            )
          )}

          {/* Chevron para grupos */}
          {!isSingle && (
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          )}
        </div>
      </div>

      {/* Sublotes expandidos */}
      {!isSingle && expanded && (
        <div className="border-t border-gray-100 divide-y divide-gray-100 bg-gray-50/60">
          {gl.map((lote) => {
            const vs = getValidityStatus(lote.validade_original)
            const d = daysUntil(lote.validade_original)
            return (
              <div key={lote.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium text-gray-900">{lote.codigo}</span>
                    <StatusBadge status={lote.status} />
                    {lote.status === 'ativo' && !lote.etiqueta_impressa && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                        Sem etiqueta
                      </span>
                    )}
                    {vs === 'danger' && <span className="text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Vence em {d}d</span>}
                    {vs === 'warning' && <span className="text-xs font-medium text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded-full">Vence em {d}d</span>}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">Disponível: {formatQty(lote.quantidade_disponivel, lote.unidade)}</p>
                </div>
                <Link
                  to={`/recebimento/imprimir/${lote.id}`}
                  className={`p-2 rounded-lg transition-colors ${
                    lote.status === 'ativo' && !lote.etiqueta_impressa
                      ? 'text-amber-500 hover:bg-amber-50'
                      : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                  }`}
                  title={lote.status === 'ativo' && !lote.etiqueta_impressa ? 'Sem etiqueta — imprimir' : 'Imprimir etiqueta'}
                >
                  <PrintIcon />
                </Link>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Seção colapsável de status (Esgotados / Descartados) ─────

function SecaoStatus({
  titulo,
  grupos,
  bgClass,
  borderClass,
  textClass,
  expandedGroups,
  onToggleGroup,
  onCancelar,
  onPrintGrupo,
  confirmId,
  setConfirmId,
  cancelando,
}: {
  titulo: string
  grupos: { key: string; lotes: LoteRow[] }[]
  bgClass: string
  borderClass: string
  textClass: string
  expandedGroups: Set<string>
  onToggleGroup: (key: string) => void
  onCancelar: (id: string) => void
  onPrintGrupo: (lotes: LoteRow[]) => void
  confirmId: string | null
  setConfirmId: (id: string | null) => void
  cancelando: string | null
}) {
  const [open, setOpen] = useState(false)
  if (grupos.length === 0) return null
  const total = grupos.reduce((s, g) => s + g.lotes.length, 0)

  return (
    <div className={`rounded-xl border ${borderClass} overflow-hidden`}>
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between px-4 py-3 ${bgClass} hover:brightness-95 transition-all text-left`}
      >
        <span className={`text-sm font-medium ${textClass}`}>
          {titulo} <span className="font-normal opacity-70">({total} lote{total > 1 ? 's' : ''})</span>
        </span>
        <svg
          className={`w-4 h-4 ${textClass} opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="p-3 space-y-2">
          {grupos.map(g => (
            <GrupoCard
              key={g.key}
              grupo={g}
              expanded={expandedGroups.has(g.key)}
              onToggle={() => onToggleGroup(g.key)}
              onCancelar={onCancelar}
              onPrintGrupo={onPrintGrupo}
              confirmId={confirmId}
              setConfirmId={setConfirmId}
              cancelando={cancelando}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────

export function RecebimentoListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [lotes, setLotes] = useState<LoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [cancelando, setCancelando] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [cancelMsg, setCancelMsg] = useState('')

  async function load() {
    if (!profile) return
    const { data } = await supabase
      .from('lotes')
      .select('*, insumo:insumos(nome, unidade_medida)')
      .eq('empresa_id', profile.empresa_id)
      .order('created_at', { ascending: false })
      .limit(200)
    setLotes((data ?? []) as LoteRow[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleCancelar(loteId: string) {
    setCancelando(loteId)
    setCancelMsg('')

    const { count } = await supabase
      .from('movimentacoes_itens')
      .select('*', { count: 'exact', head: true })
      .eq('lote_id', loteId)

    if ((count ?? 0) > 1) {
      setCancelMsg('Este lote já possui movimentações e não pode ser cancelado.')
      setCancelando(null)
      setConfirmId(null)
      return
    }

    const { error } = await supabase
      .from('lotes')
      .update({ status: 'descartado' })
      .eq('id', loteId)

    if (error) setCancelMsg(error.message)
    setCancelando(null)
    setConfirmId(null)
    load()
  }

  function handlePrintGrupo(gl: LoteRow[]) {
    navigate('/recebimento/imprimir-lotes', {
      state: {
        lotes: gl.map(l => ({
          lote_id: l.id,
          codigo: l.codigo,
          qr_code: l.qr_code ?? l.codigo,
          quantidade: l.quantidade_recebida,
        })),
      },
    })
  }

  // ── Filtragem e separação por status ─────────────────────────

  const grupos = agruparLotes(lotes)

  const filteredGrupos = grupos.filter(g =>
    g.lotes.some(l => combina(search, l.codigo, l.insumo?.nome))
  )

  const gruposAtivos    = filteredGrupos.filter(g => g.lotes.some(l => l.status === 'ativo'))
  const gruposEsgotados = filteredGrupos.filter(g => g.lotes.every(l => l.status === 'esgotado'))
  const gruposInativos  = filteredGrupos.filter(g =>
    g.lotes.every(l => l.status === 'descartado' || l.status === 'vencido')
  )

  // Banner de etiquetas pendentes
  const lotesSemEtiqueta = lotes.filter(l => l.status === 'ativo' && !l.etiqueta_impressa)

  // Props compartilhadas entre GrupoCard e SecaoStatus
  const sharedProps = {
    onCancelar: handleCancelar,
    onPrintGrupo: handlePrintGrupo,
    confirmId,
    setConfirmId,
    cancelando,
  }

  const secaoProps = {
    ...sharedProps,
    expandedGroups,
    onToggleGroup: toggleGroup,
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Recebimento de Lotes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Histórico de entradas no Estoque Central</p>
        </div>
        <Link to="/recebimento/novo">
          <Button size="md" icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          }>
            Novo lote
          </Button>
        </Link>
      </div>

      {/* Banner etiquetas pendentes */}
      {lotesSemEtiqueta.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
            <p className="text-sm font-medium text-amber-800">
              {lotesSemEtiqueta.length} lote{lotesSemEtiqueta.length > 1 ? 's' : ''} sem etiqueta impressa
            </p>
          </div>
          <button
            onClick={() => navigate('/recebimento/imprimir-lotes', {
              state: {
                lotes: lotesSemEtiqueta.map(l => ({
                  lote_id: l.id,
                  codigo: l.codigo,
                  qr_code: l.qr_code ?? l.codigo,
                  quantidade: l.quantidade_recebida,
                })),
              },
            })}
            className="shrink-0 text-xs font-semibold text-amber-700 hover:text-amber-900 flex items-center gap-1"
          >
            Imprimir pendentes
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>
      )}

      {/* Erro cancelamento */}
      {cancelMsg && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
          <span>{cancelMsg}</span>
          <button onClick={() => setCancelMsg('')} className="text-red-400 hover:text-red-600 ml-3">✕</button>
        </div>
      )}

      {/* Busca */}
      <div className="mb-4">
        <input
          type="search"
          placeholder="Buscar por código ou insumo..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-4 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filteredGrupos.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-gray-500">Nenhum lote encontrado.</p>
          <Link to="/recebimento/novo" className="text-brand-600 text-sm mt-2 inline-block">
            Registrar primeiro lote →
          </Link>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Lotes ativos */}
          {gruposAtivos.map(g => (
            <GrupoCard
              key={g.key}
              grupo={g}
              expanded={expandedGroups.has(g.key)}
              onToggle={() => toggleGroup(g.key)}
              {...sharedProps}
            />
          ))}

          {/* Esgotados — colapsável */}
          <SecaoStatus
            titulo="Esgotados"
            grupos={gruposEsgotados}
            bgClass="bg-gray-100"
            borderClass="border-gray-200"
            textClass="text-gray-600"
            {...secaoProps}
          />

          {/* Descartados / Vencidos — colapsável */}
          <SecaoStatus
            titulo="Descartados / Vencidos"
            grupos={gruposInativos}
            bgClass="bg-red-50"
            borderClass="border-red-100"
            textClass="text-red-700"
            {...secaoProps}
          />
        </div>
      )}
    </div>
  )
}

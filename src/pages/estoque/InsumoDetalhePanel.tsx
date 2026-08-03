import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { EstoqueConsolidado, Lote, Local, MotivoPerdaEnum } from '../../types/database.types'
import { formatDate, formatQty, daysUntil } from '../../lib/utils'
import { Button } from '../../components/ui/Button'
import { Select, Textarea } from '../../components/ui/Input'
import { Input } from '../../components/ui/Input'

// ── Motivos de descarte ──────────────────────────────────────
const MOTIVOS: { value: MotivoPerdaEnum; label: string }[] = [
  { value: 'vencimento',          label: 'Fora da validade' },
  { value: 'embalagem_danificada',label: 'Embalagem danificada / avaria' },
  { value: 'contaminacao',        label: 'Contaminação' },
  { value: 'queda_acidente',      label: 'Queda / Acidente' },
  { value: 'qualidade_reprovada', label: 'Qualidade reprovada' },
  { value: 'outro',               label: 'Outro' },
]

// ── Types ────────────────────────────────────────────────────
type LoteEC = Lote
type RecipienteEP = Local & { quantidade: number | null; validade_ep: string | null }

type DescarteAlvo =
  | { tipo: 'lote'; lote: LoteEC }
  | { tipo: 'recipiente'; recipiente: RecipienteEP }

// ── Helpers ──────────────────────────────────────────────────
function validadeTag(date: string | null) {
  if (!date) return null
  const d = daysUntil(date)
  const cls = d < 0 ? 'text-red-700 bg-red-100' : d <= 30 ? 'text-red-600 bg-red-50' : d <= 60 ? 'text-yellow-700 bg-yellow-50' : 'text-green-700 bg-green-50'
  const label = d < 0 ? 'Vencido' : d === 0 ? 'Vence hoje' : `${d}d`
  return <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label} · {formatDate(date)}</span>
}

// ── Descarte Modal ───────────────────────────────────────────
function DescarteModal({
  alvo,
  insumo,
  onClose,
  onSuccess,
}: {
  alvo: DescarteAlvo
  insumo: EstoqueConsolidado
  onClose: () => void
  onSuccess: () => void
}) {
  const { profile } = useAuth()
  const maxQty = alvo.tipo === 'lote'
    ? alvo.lote.quantidade_disponivel
    : (alvo.recipiente.quantidade ?? 0)

  const [motivo, setMotivo] = useState<MotivoPerdaEnum | ''>('')
  const [quantidade, setQuantidade] = useState(maxQty.toString())
  const [descricao, setDescricao] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!motivo) { setError('Selecione o motivo do descarte.'); return }
    const qty = parseFloat(quantidade)
    if (!qty || qty <= 0) { setError('Informe uma quantidade válida.'); return }
    if (qty > maxQty) { setError(`Quantidade máxima disponível: ${maxQty} ${insumo.unidade_medida}.`); return }
    setError('')
    setSaving(true)

    // O recipiente tem RPC própria: ele pode conter vários lotes misturados, e
    // o descarte é rateado entre eles no banco. Mandar um lote só daqui debitava
    // tudo do primeiro — e a baixa ia parar no estoque central, não no pote.
    const { data, error: rpcError } = alvo.tipo === 'recipiente'
      ? await supabase.rpc('registrar_perda_recipiente', {
          p_empresa_id:     profile.empresa_id,
          p_local_id:       alvo.recipiente.id,
          p_quantidade:     qty,
          p_motivo:         motivo,
          p_descricao:      descricao || null,
          p_responsavel_id: profile.id,
        })
      : await supabase.rpc('registrar_perda_insumo', {
          p_empresa_id:     profile.empresa_id,
          p_lote_id:        alvo.lote.id,
          p_insumo_id:      insumo.insumo_id,
          p_local_id:       null,
          p_quantidade:     qty,
          p_unidade:        insumo.unidade_medida,
          p_motivo:         motivo,
          p_descricao:      descricao || null,
          p_responsavel_id: profile.id,
        })

    setSaving(false)
    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao registrar descarte.')
      return
    }
    onSuccess()
  }

  const titulo = alvo.tipo === 'lote'
    ? `Lote ${alvo.lote.codigo}`
    : alvo.recipiente.nome

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Registrar descarte</h3>
            <p className="text-sm text-gray-500 mt-0.5">{titulo} · {insumo.insumo_nome}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Info do alvo */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 space-y-0.5">
            <p><span className="font-medium">Disponível:</span> {formatQty(maxQty, insumo.unidade_medida)}</p>
            {alvo.tipo === 'lote' && (
              <p><span className="font-medium">Validade:</span> {formatDate(alvo.lote.validade_pos_abertura)}</p>
            )}
            {alvo.tipo === 'recipiente' && alvo.recipiente.validade_ep && (
              <p><span className="font-medium">Validade EP:</span> {formatDate(alvo.recipiente.validade_ep)}</p>
            )}
          </div>

          <Select
            label="Motivo do descarte"
            required
            value={motivo}
            onChange={e => setMotivo(e.target.value as MotivoPerdaEnum)}
          >
            <option value="">Selecionar motivo...</option>
            {MOTIVOS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>

          <Input
            label={`Quantidade a descartar (${insumo.unidade_medida})`}
            type="number"
            step="0.001"
            min="0.001"
            max={maxQty}
            required
            value={quantidade}
            onChange={e => setQuantidade(e.target.value)}
            hint={`Máximo: ${formatQty(maxQty, insumo.unidade_medida)}`}
          />

          <Textarea
            label="Observações"
            value={descricao}
            onChange={e => setDescricao(e.target.value)}
            placeholder="Descreva o ocorrido com mais detalhes..."
            rows={3}
          />

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="danger" fullWidth loading={saving}>
              Confirmar descarte
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Painel principal ─────────────────────────────────────────
export function InsumoDetalhePanel({
  insumo,
  onClose,
}: {
  insumo: EstoqueConsolidado
  onClose: () => void
}) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [lotesEC, setLotesEC] = useState<LoteEC[]>([])
  const [recipientesEP, setRecipientesEP] = useState<RecipienteEP[]>([])
  const [loading, setLoading] = useState(true)
  const [descarteAlvo, setDescarteAlvo] = useState<DescarteAlvo | null>(null)

  async function load() {
    if (!profile) return
    setLoading(true)

    const [{ data: lotes }, { data: locais }, { data: estados }] = await Promise.all([
      supabase
        .from('lotes')
        .select('*')
        .eq('empresa_id', profile.empresa_id)
        .eq('insumo_id', insumo.insumo_id)
        .eq('status', 'ativo')
        .order('validade_original', { ascending: true }),
      supabase
        .from('locais')
        .select('*')
        .eq('empresa_id', profile.empresa_id)
        .eq('insumo_id', insumo.insumo_id)
        .eq('tipo', 'estoque_produtivo')
        .eq('ativo', true)
        .order('nome'),
      supabase
        .from('locais_estado_atual')
        .select('local_id, quantidade, validade_ep, lote_id'),
    ])

    setLotesEC((lotes ?? []) as LoteEC[])

    // Monta mapa de estado por local_id para evitar problemas com o join do Supabase
    const estadoMap = Object.fromEntries(
      ((estados ?? []) as { local_id: string; quantidade: number; validade_ep: string | null; lote_id: string | null }[])
        .map(e => [e.local_id, e])
    )

    const recipientes = ((locais ?? []) as Local[]).map(r => {
      const ea = estadoMap[r.id]
      return {
        ...r,
        quantidade: ea ? Number(ea.quantidade) : null,
        validade_ep: ea?.validade_ep ?? null,
      } as RecipienteEP
    })

    setRecipientesEP(recipientes)
    setLoading(false)
  }

  useEffect(() => { load() }, [insumo.insumo_id])

  function handleDescarteSuccess() {
    setDescarteAlvo(null)
    load()
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      {/* Slide-over */}
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-200 shrink-0">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-0.5">{insumo.insumo_codigo}</p>
            <h2 className="text-lg font-bold text-gray-900 leading-tight">{insumo.insumo_nome}</h2>
            <div className="flex gap-3 mt-1 text-sm text-gray-500">
              <span>EC: <strong className="text-gray-800">{formatQty(insumo.qtd_estoque_central, insumo.unidade_medida)}</strong></span>
              <span>EP: <strong className="text-gray-800">{formatQty(insumo.qtd_estoque_produtivo, insumo.unidade_medida)}</strong></span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* ── Lotes no EC ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Lotes no EC</span>
                  <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{lotesEC.length}</span>
                </div>

                {lotesEC.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">Nenhum lote ativo no estoque central.</p>
                ) : (
                  <div className="space-y-2">
                    {lotesEC.map(lote => (
                      <div key={lote.id} className="rounded-lg border border-gray-200 p-3 flex items-start justify-between gap-3">
                        <div className="space-y-0.5 min-w-0">
                          <p className="font-mono text-xs font-semibold text-gray-700">{lote.codigo}</p>
                          <p className="text-sm font-medium text-gray-900">{formatQty(lote.quantidade_disponivel, lote.unidade)}</p>
                          <div>{validadeTag(lote.validade_pos_abertura)}</div>
                          {lote.validade_original !== lote.validade_pos_abertura && (
                            <p className="text-xs text-gray-400">Val. original: {formatDate(lote.validade_original)}</p>
                          )}
                        </div>
                        <div className="shrink-0 flex flex-col gap-1.5">
                          <button
                            onClick={() => navigate(`/recebimento/imprimir/${lote.id}`)}
                            className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-200 hover:border-gray-400 rounded-md px-2.5 py-1.5 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
                            </svg>
                            Etiqueta
                          </button>
                          <button
                            onClick={() => setDescarteAlvo({ tipo: 'lote', lote })}
                            className="flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400 rounded-md px-2.5 py-1.5 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                            Descartar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Divider */}
              <hr className="border-gray-100" />

              {/* ── Recipientes no EP ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Recipientes no EP</span>
                  <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{recipientesEP.length}</span>
                </div>

                {recipientesEP.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">Nenhum recipiente associado a este insumo.</p>
                ) : (
                  <div className="space-y-2">
                    {recipientesEP.map(r => {
                      const temConteudo = r.quantidade != null && r.quantidade > 0
                      return (
                        <div key={r.id} className={`rounded-lg border p-3 flex items-start justify-between gap-3 ${temConteudo ? 'border-gray-200' : 'border-gray-100 bg-gray-50'}`}>
                          <div className="space-y-0.5 min-w-0">
                            <p className="text-sm font-medium text-gray-900">{r.nome}</p>
                            <p className="text-xs text-gray-500">{r.subtipo ?? '—'}</p>
                            <p className={`text-sm font-semibold ${temConteudo ? 'text-gray-800' : 'text-gray-400'}`}>
                              {temConteudo ? formatQty(r.quantidade!, insumo.unidade_medida) : 'Vazio'}
                            </p>
                            {r.validade_ep && <div>{validadeTag(r.validade_ep)}</div>}
                          </div>
                          {temConteudo && (
                            <button
                              onClick={() => setDescarteAlvo({ tipo: 'recipiente', recipiente: r })}
                              className="shrink-0 flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400 rounded-md px-2.5 py-1.5 transition-colors"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                              </svg>
                              Descartar
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>

      {/* Modal de descarte */}
      {descarteAlvo && (
        <DescarteModal
          alvo={descarteAlvo}
          insumo={insumo}
          onClose={() => setDescarteAlvo(null)}
          onSuccess={handleDescarteSuccess}
        />
      )}
    </>
  )
}

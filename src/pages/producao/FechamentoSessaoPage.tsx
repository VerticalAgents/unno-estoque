import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { getDesvioStatus } from '../../lib/utils'

interface SkuRow {
  id: string
  ficha_tecnica_id: string
  quantidade_planejada: number
  ficha_tecnica: { nome: string }
  ficha_versao: { peso_medio_g: number | null } | null
  perdida: number
  descartada_gramatura: number
  peso_descartado_g: number
}

interface LocalRow {
  id: string
  local_id: string
  lote_id: string
  insumo_id: string
  quantidade_inicial: number
  consumo_teorico: number
  local: { nome: string }
  insumo: { nome: string; unidade_medida: string }
  lote: { codigo: string; unidade: string }
  sobra: number
  zerado: boolean
}

// ── Persistence helpers ──────────────────────────────────────

function storageKey(sessaoId: string) {
  return `fechamento_${sessaoId}`
}

interface StoredState {
  skuInputs: Record<string, { perdida: number; descartada_gramatura: number; peso_descartado_g: number }>
  localInputs: Record<string, { sobra: number; zerado: boolean }>
  obs: string
}

function saveState(sessaoId: string, state: StoredState) {
  try { sessionStorage.setItem(storageKey(sessaoId), JSON.stringify(state)) } catch {}
}

function loadState(sessaoId: string): StoredState | null {
  try {
    const raw = sessionStorage.getItem(storageKey(sessaoId))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// ── Component ─────────────────────────────────────────────────

export function FechamentoSessaoPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [sessao, setSessao] = useState<{ codigo: string; data_producao: string } | null>(null)
  const [skus, setSkus] = useState<SkuRow[]>([])
  const [locais, setLocais] = useState<LocalRow[]>([])
  const [obs, setObs] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)

  useEffect(() => {
    if (!id || !profile) return
    Promise.all([
      supabase.from('sessoes_producao').select('codigo,data_producao').eq('id', id).single(),
      supabase.from('sessoes_producao_skus')
        .select('*, ficha_tecnica:fichas_tecnicas(nome), ficha_versao:fichas_tecnicas_versoes(peso_medio_g)')
        .eq('sessao_id', id),
      supabase.from('sessoes_producao_locais')
        .select('*, local:locais(nome), insumo:insumos(nome,unidade_medida), lote:lotes(codigo,unidade)')
        .eq('sessao_id', id),
    ]).then(([s, sk, loc]) => {
      if (s.data) setSessao(s.data as typeof sessao)

      const stored = loadState(id)

      const skuRows = ((sk.data ?? []) as unknown as SkuRow[]).map((r) => {
        const saved = stored?.skuInputs?.[r.id]
        return {
          ...r,
          perdida: saved?.perdida ?? 0,
          descartada_gramatura: saved?.descartada_gramatura ?? 0,
          peso_descartado_g: saved?.peso_descartado_g ?? 0,
        }
      })

      const localRows = ((loc.data ?? []) as unknown as LocalRow[]).map((r) => {
        const saved = stored?.localInputs?.[r.id]
        return {
          ...r,
          sobra: saved?.sobra ?? r.quantidade_inicial,
          zerado: saved?.zerado ?? false,
        }
      })

      setSkus(skuRows)
      setLocais(localRows)
      if (stored?.obs) setObs(stored.obs)
      setDataLoaded(true)
    })
  }, [id, profile])

  // Persist to sessionStorage on every state change
  const persist = useCallback((newSkus: SkuRow[], newLocais: LocalRow[], newObs: string) => {
    if (!id || !dataLoaded) return
    const skuInputs: StoredState['skuInputs'] = {}
    const localInputs: StoredState['localInputs'] = {}
    for (const s of newSkus) skuInputs[s.id] = { perdida: s.perdida, descartada_gramatura: s.descartada_gramatura, peso_descartado_g: s.peso_descartado_g }
    for (const l of newLocais) localInputs[l.id] = { sobra: l.sobra, zerado: l.zerado }
    saveState(id, { skuInputs, localInputs, obs: newObs })
  }, [id, dataLoaded])

  function setSku(skuId: string, field: 'perdida' | 'descartada_gramatura' | 'peso_descartado_g', val: number) {
    setSkus((prev) => {
      const next = prev.map((s) => s.id === skuId ? { ...s, [field]: val } : s)
      persist(next, locais, obs)
      return next
    })
  }

  function setSobra(localId: string, val: number) {
    setLocais((prev) => {
      const next = prev.map((l) => l.id === localId ? { ...l, sobra: val } : l)
      persist(skus, next, obs)
      return next
    })
  }

  function toggleZerado(localId: string) {
    setLocais((prev) => {
      const next = prev.map((l) => {
        if (l.id !== localId) return l
        const novoZerado = !l.zerado
        return { ...l, zerado: novoZerado, sobra: novoZerado ? 0 : l.quantidade_inicial }
      })
      persist(skus, next, obs)
      return next
    })
  }

  function updateObs(val: string) {
    setObs(val)
    persist(skus, locais, val)
  }

  // ── Derived calculations ─────────────────────────────────────

  const totalConsumido = locais.reduce((acc, l) => acc + (l.quantidade_inicial - l.sobra), 0)
  const totalTeorico = locais.reduce((acc, l) => acc + (l.consumo_teorico ?? 0), 0)
  const fatorInsumos = totalTeorico > 0 ? ((totalConsumido - totalTeorico) / totalTeorico * 100) : null

  // Per-SKU derived values
  function skuProduzida(s: SkuRow): number {
    return Math.max(s.quantidade_planejada - s.perdida - s.descartada_gramatura, 0)
  }

  function skuFatorPerda(s: SkuRow): number | null {
    if (s.quantidade_planejada <= 0) return null
    const pesoMedio = (s.ficha_versao as unknown as { peso_medio_g?: number } | null)?.peso_medio_g
    if (pesoMedio && pesoMedio > 0) {
      // Weight-based: (perdas_processo × peso_médio + peso_real_descartado) / (planejado × peso_médio)
      const perdaGramas = s.perdida * pesoMedio + s.peso_descartado_g
      const esperadoGramas = s.quantidade_planejada * pesoMedio
      return esperadoGramas > 0 ? (perdaGramas / esperadoGramas * 100) : null
    }
    // Unit-based fallback
    return ((s.perdida + s.descartada_gramatura) / s.quantidade_planejada * 100)
  }

  function skuValidation(s: SkuRow): string | null {
    if (s.perdida + s.descartada_gramatura > s.quantidade_planejada) {
      return `Perdas (${s.perdida + s.descartada_gramatura}) excedem o planejado (${s.quantidade_planejada}).`
    }
    return null
  }

  const totalPlanejado = skus.reduce((acc, s) => acc + s.quantidade_planejada, 0)
  const totalProduzida = skus.reduce((acc, s) => acc + skuProduzida(s), 0)
  const totalDescartado = skus.reduce((acc, s) => acc + s.perdida + s.descartada_gramatura, 0)
  const fatorProdutoGlobal = totalPlanejado > 0 ? (totalDescartado / totalPlanejado * 100) : null

  const hasValidationError = skus.some((s) => skuValidation(s) !== null)

  async function handleConfirmar() {
    if (!profile || !id) return
    if (hasValidationError) { setError('Corrija os erros antes de fechar.'); setShowConfirm(false); return }
    setLoading(true)

    const { data, error: err } = await supabase.rpc('fechar_sessao_producao', {
      p_sessao_id:      id,
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_skus: skus.map((s) => ({
        ficha_id: s.ficha_tecnica_id,
        quantidade_perdida: s.perdida,
        quantidade_descartada_gramatura: s.descartada_gramatura,
        peso_descartado_gramatura_g: s.peso_descartado_g || null,
      })),
      p_locais: locais.map((l) => ({
        local_id: l.local_id,
        lote_id: l.lote_id,
        quantidade_final: l.sobra,
      })),
      p_observacoes: obs || null,
    })

    setLoading(false)
    if (err || !(data as { ok: boolean })?.ok) {
      setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro ao fechar sessão.')
      setShowConfirm(false)
      return
    }

    // Clear persisted state on success
    try { sessionStorage.removeItem(storageKey(id)) } catch {}
    navigate('/producao')
  }

  return (
    <div className="p-4 max-w-lg mx-auto min-h-screen">
      <button onClick={() => navigate('/producao')} className="text-sm text-gray-500 flex items-center gap-1 mb-4">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Voltar
      </button>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Fechar Sessão</h1>
      {sessao && <p className="text-sm text-gray-500 mb-6">{sessao.codigo} · {sessao.data_producao}</p>}

      {/* Produção */}
      <div className="space-y-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Produção</h2>
        {skus.map((s) => {
          const pesoMedio = (s.ficha_versao as unknown as { peso_medio_g?: number } | null)?.peso_medio_g
          const produzida = skuProduzida(s)
          const fatorPerda = skuFatorPerda(s)
          const validErr = skuValidation(s)

          return (
            <Card key={s.id} className="p-4 space-y-3">
              <div>
                <p className="font-medium text-gray-900">{s.ficha_tecnica?.nome}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-gray-400">Planejado: {s.quantidade_planejada} un.</p>
                  {produzida > 0 || s.perdida > 0 || s.descartada_gramatura > 0 ? (
                    <p className="text-xs font-medium text-brand-600">Produzidos: {produzida} un.</p>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Perdidos (processo)"
                  type="number"
                  min="0"
                  max={s.quantidade_planejada}
                  value={s.perdida || ''}
                  onChange={(e) => setSku(s.id, 'perdida', parseInt(e.target.value) || 0)}
                />
                <Input
                  label="Descartados por gramatura"
                  type="number"
                  min="0"
                  max={s.quantidade_planejada}
                  value={s.descartada_gramatura || ''}
                  onChange={(e) => setSku(s.id, 'descartada_gramatura', parseInt(e.target.value) || 0)}
                  hint={pesoMedio ? `Peso esperado: ${pesoMedio}g/un` : undefined}
                />
              </div>

              {s.descartada_gramatura > 0 && (
                <Input
                  label="Peso total descartado por gramatura (g)"
                  type="number"
                  min="0"
                  step="0.1"
                  value={s.peso_descartado_g || ''}
                  onChange={(e) => setSku(s.id, 'peso_descartado_g', parseFloat(e.target.value) || 0)}
                  hint="Soma do peso de todas as unidades descartadas"
                />
              )}

              {validErr ? (
                <p className="text-xs font-medium text-red-600">{validErr}</p>
              ) : fatorPerda !== null && fatorPerda > 0 ? (
                <p className="text-xs font-medium text-gray-600">
                  Perda: <span className={fatorPerda <= 3 ? 'text-emerald-600' : fatorPerda <= 8 ? 'text-yellow-600' : 'text-red-600'}>
                    {fatorPerda.toFixed(1)}%
                  </span>
                  {pesoMedio && s.peso_descartado_g > 0 && (
                    <span className="text-gray-400"> (calculado em peso)</span>
                  )}
                </p>
              ) : null}
            </Card>
          )
        })}
      </div>

      {/* Recipientes */}
      <div className="space-y-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Recipientes</h2>
        {locais.length === 0 && (
          <p className="text-sm text-gray-400 italic">Nenhum recipiente vinculado.</p>
        )}
        {locais.map((l) => {
          const consumoReal = l.quantidade_inicial - l.sobra
          const desvio = getDesvioStatus(consumoReal, l.consumo_teorico)
          return (
            <Card key={l.id} className={`p-4 space-y-2 ${l.zerado ? 'opacity-60' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{l.local?.nome}</p>
                  <p className="text-xs text-gray-400">{l.insumo?.nome} · Lote {l.lote?.codigo}</p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleZerado(l.id)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    l.zerado
                      ? 'bg-red-50 border-red-300 text-red-700 font-medium'
                      : 'border-gray-300 text-gray-500 hover:border-red-300 hover:text-red-600'
                  }`}
                >
                  {l.zerado ? 'Zerado' : 'Zerar'}
                </button>
              </div>

              <p className="text-xs text-gray-400">
                Inicial: {l.quantidade_inicial} {l.lote?.unidade}
                {l.consumo_teorico > 0 && ` · Teórico: ${l.consumo_teorico} ${l.lote?.unidade}`}
              </p>

              {!l.zerado && (
                <Input
                  label={`Sobra restante (${l.lote?.unidade})`}
                  type="number"
                  step="0.001"
                  min="0"
                  value={l.sobra}
                  onChange={(e) => setSobra(l.id, parseFloat(e.target.value) || 0)}
                />
              )}

              {l.consumo_teorico > 0 && (
                <p className={`text-xs font-medium ${desvio === 'ok' ? 'text-emerald-600' : desvio === 'warning' ? 'text-yellow-600' : 'text-red-600'}`}>
                  Consumo real: {consumoReal.toFixed(3)} · Desvio: {(consumoReal - l.consumo_teorico).toFixed(3)}
                </p>
              )}
            </Card>
          )
        })}
      </div>

      {/* Resumo */}
      {(fatorInsumos !== null || fatorProdutoGlobal !== null) && (
        <Card className="p-4 mb-4 bg-gray-50 border border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Resumo</h2>
          <div className="grid grid-cols-2 gap-3">
            {fatorInsumos !== null && (
              <div>
                <p className="text-xs text-gray-500">Perda de insumos</p>
                <p className={`text-lg font-bold ${fatorInsumos <= 3 ? 'text-emerald-600' : fatorInsumos <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {fatorInsumos.toFixed(1)}%
                </p>
                <p className="text-xs text-gray-400">consumo real vs teórico</p>
              </div>
            )}
            {fatorProdutoGlobal !== null && (
              <div>
                <p className="text-xs text-gray-500">Perda de produto</p>
                <p className={`text-lg font-bold ${fatorProdutoGlobal <= 3 ? 'text-emerald-600' : fatorProdutoGlobal <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {fatorProdutoGlobal.toFixed(1)}%
                </p>
                <p className="text-xs text-gray-400">% do planejado</p>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-200">
            Unidades aproveitadas: <strong>{totalProduzida}</strong> de <strong>{totalPlanejado}</strong> planejadas
          </p>
        </Card>
      )}

      <div className="mb-4">
        <Input label="Observações (opcional)" value={obs} onChange={(e) => updateObs(e.target.value)} />
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <Button variant="danger" size="xl" fullWidth onClick={() => setShowConfirm(true)} disabled={hasValidationError}>
        FECHAR SESSÃO
      </Button>

      <ConfirmModal
        open={showConfirm}
        title="Fechar sessão de produção?"
        variant="danger"
        confirmLabel="FECHAR"
        loading={loading}
        description="Esta ação registra o consumo e não pode ser desfeita."
        summary={
          <div>
            {skus.map((s) => (
              <p key={s.id}>
                {s.ficha_tecnica?.nome}: {skuProduzida(s)} produzidos, {s.perdida} perdidos no processo
                {s.descartada_gramatura > 0 && `, ${s.descartada_gramatura} descartados por gramatura`}
              </p>
            ))}
          </div>
        }
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

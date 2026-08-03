import { useEffect, useMemo, useState, useCallback } from 'react'
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
  multiplicador: number | null
  ficha_tecnica: { nome: string }
  ficha_versao: { peso_medio_g: number | null; perda_esperada_g_forma: number | null } | null
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
  /** Sobra pesada por recipiente. A conferência é por pote desde que a mistura
   *  de lotes foi liberada — a balança dá um número só por recipiente. */
  localTotais?: Record<string, number>
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
  // Sobra pesada por RECIPIENTE (não por lote). Quando o pote tem mistura, a
  // balança dá um número só e o banco rateia entre os lotes de dentro.
  const [sobraLocal, setSobraLocal] = useState<Record<string, number>>({})

  /**
   * Agrupa as linhas por recipiente. Um pote pode ter vários lotes desde que a
   * mistura foi liberada (migration 035), e a conferência é feita por pote.
   *
   * A ordem é por validade: o pote cujo conteúdo vence antes aparece primeiro.
   * É apenas SUGESTÃO — na prática a produção usa o que estiver à mão, e o
   * sistema não impõe nada.
   */
  const potes = useMemo(() => {
    const mapa = new Map<string, {
      local_id: string; nome: string; insumo: string; unidade: string
      inicial: number; teorico: number; sobra: number; lotes: LocalRow[]
    }>()

    for (const l of locais) {
      const atual = mapa.get(l.local_id) ?? {
        local_id: l.local_id,
        nome: l.local?.nome ?? '—',
        insumo: l.insumo?.nome ?? '—',
        unidade: l.lote?.unidade ?? l.insumo?.unidade_medida ?? '',
        inicial: 0, teorico: 0, sobra: 0, lotes: [] as LocalRow[],
      }
      atual.inicial += l.quantidade_inicial
      atual.teorico += l.consumo_teorico ?? 0
      atual.lotes.push(l)
      mapa.set(l.local_id, atual)
    }

    return [...mapa.values()].map(p => ({
      ...p,
      sobra: sobraLocal[p.local_id] ?? p.inicial,
    }))
  }, [locais, sobraLocal])

  function setSobraLocalValue(localId: string, valor: number) {
    setSobraLocal(s => {
      const next = { ...s, [localId]: valor }
      // guarda o que foi digitado: a conferência é feita no celular, andando
      // pela cozinha, e recarregar a página não pode apagar o trabalho
      if (id && dataLoaded) {
        const anterior = loadState(id)
        saveState(id, {
          skuInputs:   anterior?.skuInputs ?? {},
          localInputs: anterior?.localInputs ?? {},
          localTotais: next,
          obs:         anterior?.obs ?? obs,
        })
      }
      return next
    })
  }
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
        .select('*, ficha_tecnica:fichas_tecnicas(nome), ficha_versao:fichas_tecnicas_versoes(peso_medio_g, perda_esperada_g_forma)')
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

      // Sobra por recipiente: retoma o que já foi digitado, senão parte do que
      // os lotes tinham dentro dele.
      const totais: Record<string, number> = {}
      for (const r of localRows) {
        totais[r.local_id] = (totais[r.local_id] ?? 0) + (r.quantidade_inicial ?? 0)
      }
      setSobraLocal({ ...totais, ...(stored?.localTotais ?? {}) })

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

  /** O que o fechamento realmente mede, por ficha. */
  const [medicoes, setMedicoes] = useState<Record<string, { formas: string; sobra: string }>>({})
  const medicao = (id: string) => medicoes[id] ?? { formas: '', sobra: '' }
  const numMed = (v: string) => parseFloat((v ?? '').replace(',', '.')) || 0



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

    // As medições são gravadas direto na tabela: são números observados, não
    // movimento de estoque, e assim `fechar_sessao_producao` — que rateia
    // consumo entre lotes — não precisa ser mexida.
    for (const s of skus) {
      const formas = numMed(medicao(s.id).formas)
      await supabase.from('sessoes_producao_skus').update({
        formas_assadas: formas > 0 ? Math.round(formas) : (s.multiplicador ?? null),
        massa_sobra_g: numMed(medicao(s.id).sobra) || null,
      }).eq('id', s.id)
    }

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
      // Um registro por recipiente; o rateio entre os lotes é feito no banco
      p_locais: potes.map((p) => ({
        local_id: p.local_id,
        quantidade_final: p.lotes.every(l => l.zerado) ? 0 : p.sobra,
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

              {/* O que dá para medir hoje: quantas formas foram ao forno e
                  quanta massa ficou no tacho. As unidades só existem amanhã,
                  quando o brownie é desenformado — elas entram na Pós-produção. */}
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Formas assadas"
                  type="number"
                  min="0"
                  value={medicao(s.id).formas}
                  onChange={e => setMedicoes(m => ({ ...m, [s.id]: { ...medicao(s.id), formas: e.target.value } }))}
                  hint={`Planejado: ${s.multiplicador ?? 0} forma(s)`}
                />
                <Input
                  label="Massa que sobrou (g)"
                  type="number"
                  min="0"
                  step="1"
                  value={medicao(s.id).sobra}
                  onChange={e => setMedicoes(m => ({ ...m, [s.id]: { ...medicao(s.id), sobra: e.target.value } }))}
                  hint="Pesagem do tacho e utensílios"
                />
              </div>

              {(() => {
                const formas = numMed(medicao(s.id).formas) || (s.multiplicador ?? 0)
                const margem = (s.ficha_versao as unknown as { perda_esperada_g_forma?: number } | null)
                  ?.perda_esperada_g_forma ?? 50
                const esperado = formas * Number(margem)
                const sobra = numMed(medicao(s.id).sobra)
                if (esperado <= 0) return null
                const acima = sobra > esperado
                return (
                  <p className={`text-xs ${sobra === 0 ? 'text-gray-500' : acima ? 'text-amber-700' : 'text-emerald-700'}`}>
                    Esperado para {formas} forma(s): <strong>{esperado} g</strong>
                    {sobra > 0 && (acima
                      ? ` — ${Math.round(sobra - esperado)} g acima da margem`
                      : ` — dentro da margem`)}
                  </p>
                )
              })()}


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
        {/* Um peso por RECIPIENTE, não por lote: a balança pesa o pote inteiro.
            Quando há mistura, o sistema rateia o consumo entre os lotes de dentro
            na proporção do que cada um tinha (fechar_sessao_producao). */}
        {potes.map((p, idx) => {
          const zerado = p.lotes.every(l => l.zerado)
          const consumoReal = p.inicial - p.sobra
          const desvio = getDesvioStatus(consumoReal, p.teorico)
          const misturado = p.lotes.length > 1
          return (
            <Card key={p.local_id} className={`p-4 space-y-2 ${zerado ? 'opacity-60' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900 dark:text-unno-text">
                    {p.nome}
                    {/* Sugestão sem efeito no cálculo: quem produz usa o que
                        estiver à mão. Serve só para gastar antes o que vence antes. */}
                    {idx === 0 && potes.length > 1 && (
                      <span className="ml-2 text-[0.65rem] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
                        sugerido usar primeiro
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400">
                    {p.insumo}
                    {misturado ? (
                      <span className="text-unno-amber"> · {p.lotes.length} lotes misturados</span>
                    ) : (
                      <> · Lote {p.lotes[0]?.lote?.codigo}</>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => p.lotes.forEach(l => toggleZerado(l.id))}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    zerado
                      ? 'bg-red-50 border-red-300 text-red-700 font-medium'
                      : 'border-gray-300 text-gray-500 hover:border-red-300 hover:text-red-600'
                  }`}
                >
                  {zerado ? 'Zerado' : 'Zerar'}
                </button>
              </div>

              {misturado && (
                <div className="text-[0.7rem] text-gray-500 dark:text-unno-muted space-y-0.5 pl-2 border-l-2 border-unno-amber/40">
                  {p.lotes.map(l => (
                    <p key={l.id} className="font-mono">
                      {l.lote?.codigo} — {l.quantidade_inicial} {l.lote?.unidade}
                    </p>
                  ))}
                </div>
              )}

              <p className="text-xs text-gray-400">
                Inicial: {p.inicial.toFixed(3)} {p.unidade}
                {p.teorico > 0 && ` · Teórico: ${p.teorico.toFixed(3)} ${p.unidade}`}
              </p>

              {!zerado && (
                <Input
                  label={`Sobra no recipiente (${p.unidade})`}
                  type="number"
                  step="0.001"
                  min="0"
                  value={p.sobra}
                  onChange={(e) => setSobraLocalValue(p.local_id, parseFloat(e.target.value) || 0)}
                />
              )}

              {p.teorico > 0 && (
                <p className={`text-xs font-medium ${desvio === 'ok' ? 'text-emerald-600' : desvio === 'warning' ? 'text-yellow-600' : 'text-red-600'}`}>
                  Consumo real: {consumoReal.toFixed(3)} · Desvio: {(consumoReal - p.teorico).toFixed(3)}
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

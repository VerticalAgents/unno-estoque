import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { ConfirmModal } from '../../components/ui/ConfirmModal'

/**
 * A PRODUÇÃO NÃO PESA MAIS OS RECIPIENTES.
 *
 * Esta tela pedia o peso da sobra de cada pote — ~35 pesagens por sessão — e
 * dali saía o consumo real. O que importa, porém, é a TAXA DE PERDA POR
 * INSUMO, não o valor de cada sessão: medir todo dia era preciosismo, e era
 * trabalho de quem precisa é produzir.
 *
 * Agora `fechar_sessao_producao` (migration 065) dá baixa pelo consumo TEÓRICO
 * e a perda é apurada na auditoria de estoque, quando se quiser.
 *
 * Fica aqui só o que de fato se mede no fim da produção: quantas formas foram
 * ao forno e quanta massa sobrou no tacho. As unidades só existem no dia
 * seguinte, quando o brownie é desenformado — elas entram na Pós-produção.
 */

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

// ── Persistence helpers ──────────────────────────────────────

function storageKey(sessaoId: string) {
  return `fechamento_${sessaoId}`
}

interface StoredState {
  skuInputs: Record<string, { perdida: number; descartada_gramatura: number; peso_descartado_g: number }>
  /** Formas assadas e massa no tacho, do jeito que foram digitadas. */
  medicoes?: Record<string, { formas: string; sobra: string }>
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
  /** O que o fechamento realmente mede, por ficha. */
  const [medicoes, setMedicoes] = useState<Record<string, { formas: string; sobra: string }>>({})
  const [obs, setObs] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)

  const medicao = (skuId: string) => medicoes[skuId] ?? { formas: '', sobra: '' }
  const numMed = (v: string) => parseFloat((v ?? '').replace(',', '.')) || 0

  useEffect(() => {
    if (!id || !profile) return
    Promise.all([
      supabase.from('sessoes_producao').select('codigo,data_producao').eq('id', id).single(),
      supabase.from('sessoes_producao_skus')
        .select('*, ficha_tecnica:fichas_tecnicas(nome), ficha_versao:fichas_tecnicas_versoes(peso_medio_g, perda_esperada_g_forma)')
        .eq('sessao_id', id),
    ]).then(([s, sk]) => {
      if (s.data) setSessao(s.data as typeof sessao)

      const stored = loadState(id)

      setSkus(((sk.data ?? []) as unknown as SkuRow[]).map((r) => {
        const saved = stored?.skuInputs?.[r.id]
        return {
          ...r,
          perdida: saved?.perdida ?? 0,
          descartada_gramatura: saved?.descartada_gramatura ?? 0,
          peso_descartado_g: saved?.peso_descartado_g ?? 0,
        }
      }))

      if (stored?.medicoes) setMedicoes(stored.medicoes)
      if (stored?.obs) setObs(stored.obs)
      setDataLoaded(true)
    })
  }, [id, profile])

  /**
   * Guarda o que foi digitado: a conferência é feita no celular, andando pela
   * fábrica, e recarregar a página não pode apagar o trabalho.
   */
  const persist = useCallback((
    newSkus: SkuRow[],
    newMedicoes: Record<string, { formas: string; sobra: string }>,
    newObs: string,
  ) => {
    if (!id || !dataLoaded) return
    const skuInputs: StoredState['skuInputs'] = {}
    for (const s of newSkus) {
      skuInputs[s.id] = {
        perdida: s.perdida,
        descartada_gramatura: s.descartada_gramatura,
        peso_descartado_g: s.peso_descartado_g,
      }
    }
    saveState(id, { skuInputs, medicoes: newMedicoes, obs: newObs })
  }, [id, dataLoaded])

  function setMedicao(skuId: string, campo: 'formas' | 'sobra', valor: string) {
    setMedicoes((m) => {
      const next = { ...m, [skuId]: { ...(m[skuId] ?? { formas: '', sobra: '' }), [campo]: valor } }
      persist(skus, next, obs)
      return next
    })
  }

  function updateObs(val: string) {
    setObs(val)
    persist(skus, medicoes, val)
  }

  // ── Derived calculations ─────────────────────────────────────

  function skuProduzida(s: SkuRow): number {
    return Math.max(s.quantidade_planejada - s.perdida - s.descartada_gramatura, 0)
  }

  function skuFatorPerda(s: SkuRow): number | null {
    if (s.quantidade_planejada <= 0) return null
    const pesoMedio = s.ficha_versao?.peso_medio_g
    if (pesoMedio && pesoMedio > 0) {
      // Em peso: (perdas_processo × peso_médio + peso_real_descartado) / (planejado × peso_médio)
      const perdaGramas = s.perdida * pesoMedio + s.peso_descartado_g
      const esperadoGramas = s.quantidade_planejada * pesoMedio
      return esperadoGramas > 0 ? (perdaGramas / esperadoGramas * 100) : null
    }
    // Sem peso médio cadastrado, cai para a contagem em unidades
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
    // movimento de estoque.
    for (const s of skus) {
      const formas = numMed(medicao(s.id).formas)
      await supabase.from('sessoes_producao_skus').update({
        formas_assadas: formas > 0 ? Math.round(formas) : (s.multiplicador ?? null),
        massa_sobra_g: numMed(medicao(s.id).sobra) || null,
      }).eq('id', s.id)
    }

    // Sem `p_locais`: a baixa dos recipientes é feita pelo consumo teórico
    // dentro da própria função (migration 065).
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
      p_observacoes: obs || null,
    })

    setLoading(false)
    if (err || !(data as { ok: boolean })?.ok) {
      setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro ao fechar sessão.')
      setShowConfirm(false)
      return
    }

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
          const pesoMedio = s.ficha_versao?.peso_medio_g
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
                  quanta massa ficou no tacho. */}
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Formas assadas"
                  type="number" inputMode="decimal"
                  min="0"
                  value={medicao(s.id).formas}
                  onChange={e => setMedicao(s.id, 'formas', e.target.value)}
                  hint={`Planejado: ${s.multiplicador ?? 0} forma(s)`}
                />
                <Input
                  label="Massa que sobrou (g)"
                  type="number" inputMode="decimal"
                  min="0"
                  step="1"
                  value={medicao(s.id).sobra}
                  onChange={e => setMedicao(s.id, 'sobra', e.target.value)}
                  hint="Pesagem do tacho e utensílios"
                />
              </div>

              {(() => {
                const formas = numMed(medicao(s.id).formas) || (s.multiplicador ?? 0)
                const margem = s.ficha_versao?.perda_esperada_g_forma ?? 50
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

      {/* Os recipientes têm baixa automática pelo teórico — dizer isso evita a
          pergunta "e onde eu informo o que sobrou nos potes?". */}
      <Card className="p-3 mb-4 bg-gray-50 border border-gray-200">
        <p className="text-xs text-gray-600">
          O consumo dos recipientes é dado baixa automaticamente pelo previsto na
          ficha técnica. A perda de insumo é apurada na{' '}
          <strong>auditoria de estoque</strong>, não aqui.
        </p>
      </Card>

      {/* Resumo */}
      {fatorProdutoGlobal !== null && (
        <Card className="p-4 mb-4 bg-gray-50 border border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Resumo</h2>
          <div>
            <p className="text-xs text-gray-500">Perda de produto</p>
            <p className={`text-lg font-bold ${fatorProdutoGlobal <= 3 ? 'text-emerald-600' : fatorProdutoGlobal <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
              {fatorProdutoGlobal.toFixed(1)}%
            </p>
            <p className="text-xs text-gray-400">% do planejado</p>
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

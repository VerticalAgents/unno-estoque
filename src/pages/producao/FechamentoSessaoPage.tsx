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
  insumo: {
    nome: string
    unidade_medida: string
    categoria: { nome: string; cor_hex: string | null } | null
  }
  lote: { codigo: string; unidade: string; validade_pos_abertura: string | null }
  sobra: number
  zerado: boolean
}

/** Insumo sem categoria cadastrada ainda precisa aparecer em algum lugar. */
const SEM_CATEGORIA = 'Sem categoria'

/** "#2" antes de "#10" — comparação alfabética põe o 10 na frente. */
const naturalmente = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

/**
 * A unidade da bancada, que é a da balança — não a do cadastro.
 *
 * O insumo é cadastrado em kg, mas quem pesa a sobra lê "350" no visor. Pedir
 * "0,350" obriga a uma conversão de cabeça no meio da produção, e um zero a
 * mais ou a menos vira 3,5 kg de desvio sem ninguém perceber.
 *
 * O banco continua guardando na unidade do cadastro: a conversão é só na tela.
 */
function bancada(unidade: string): { rotulo: string; fator: number } {
  const u = (unidade ?? '').toLowerCase()
  if (u === 'kg') return { rotulo: 'g',  fator: 1000 }
  if (u === 'l')  return { rotulo: 'ml', fator: 1000 }
  return { rotulo: unidade ?? '', fator: 1 }
}

/**
 * Em gramas não se usa separador de milhar: "17.000" em português é
 * exatamente como 17,000 kg aparece, e os dois números conviveriam na mesma
 * tela. "17000 g" não deixa dúvida.
 */
function emBancada(valor: number, fator: number): string {
  const x = valor * fator
  return fator === 1 ? x.toFixed(3) : String(Math.round(x * 1000) / 1000)
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
   * A ordem é a MESMA fila que o banco usa para distribuir o teórico
   * (migration 059): dentro de cada insumo, validade mais próxima primeiro e,
   * empatando, o número menor. Se a tela ordenasse diferente, o "usar
   * primeiro" apontaria um pote e os números apontariam outro.
   *
   * É SUGESTÃO — na prática a produção usa o que estiver à mão, e o sistema
   * não impõe nada.
   */
  const potes = useMemo(() => {
    const mapa = new Map<string, {
      local_id: string; nome: string; insumo: string; insumo_id: string; unidade: string
      categoria: string; cor: string | null
      inicial: number; teorico: number; sobra: number; validade: string
      lotes: LocalRow[]
    }>()

    for (const l of locais) {
      const atual = mapa.get(l.local_id) ?? {
        local_id: l.local_id,
        nome: l.local?.nome ?? '—',
        insumo: l.insumo?.nome ?? '—',
        insumo_id: l.insumo_id,
        categoria: l.insumo?.categoria?.nome ?? SEM_CATEGORIA,
        cor: l.insumo?.categoria?.cor_hex ?? null,
        unidade: l.lote?.unidade ?? l.insumo?.unidade_medida ?? '',
        inicial: 0, teorico: 0, sobra: 0,
        // sem validade vai para o fim da fila, não para o começo
        validade: '9999-12-31',
        lotes: [] as LocalRow[],
      }
      atual.inicial += l.quantidade_inicial
      atual.teorico += l.consumo_teorico ?? 0
      const v = l.lote?.validade_pos_abertura
      if (v && v < atual.validade) atual.validade = v
      atual.lotes.push(l)
      mapa.set(l.local_id, atual)
    }

    const lista = [...mapa.values()]
      // "Zerado" É sobra zero. Antes o botão só marcava a bandeira e a sobra
      // continuava valendo o conteúdo cheio, então o desvio aparecia como
      // -teórico: a tela dizia que nada tinha sido consumido no pote que
      // acabara de ser dado como esvaziado.
      .map(p => ({
        ...p,
        sobra: p.lotes.every(l => l.zerado) ? 0 : (sobraLocal[p.local_id] ?? p.inicial),
      }))
      .sort((a, b) =>
        naturalmente.compare(a.insumo, b.insumo) ||
        a.validade.localeCompare(b.validade) ||
        naturalmente.compare(a.nome, b.nome))

    // "Usar primeiro" é por INSUMO, não uma vez na página: cada insumo tem a
    // sua fila. Marca o primeiro pote que a produção precisa de fato abrir.
    const jaMarcado = new Set<string>()
    return lista.map(p => {
      const primeiro = p.teorico > 0 && !jaMarcado.has(p.insumo_id)
      if (primeiro) jaMarcado.add(p.insumo_id)

      /**
       * O papel do pote na produção do dia. Com o teórico enfileirado (059) os
       * três casos são bem diferentes de trabalho, e tratá-los igual é o que
       * fazia a lista ter 51 cartões idênticos:
       *
       *   nao_usa — nem se abre. Nada a fazer.
       *   esvazia — vai até o fim. A resposta é sempre "sobrou zero".
       *   pesa    — sobra um pedaço. Este sim vai à balança.
       *
       * Só existe um `pesa` por insumo: é o último da fila.
       */
      const papel: 'nao_usa' | 'esvazia' | 'pesa' =
        p.teorico <= 0 ? 'nao_usa'
          : p.teorico >= p.inicial - 0.0005 ? 'esvazia'
          : 'pesa'

      return { ...p, primeiroDoInsumo: primeiro, papel }
    })
  }, [locais, sobraLocal])

  /** Um bloco por insumo. `potes` já vem na ordem da fila, então basta juntar. */
  const grupos = useMemo(() => {
    const mapa = new Map<string, {
      insumo_id: string; insumo: string; unidade: string
      categoria: string; cor: string | null
      teorico: number; potes: typeof potes
    }>()
    for (const p of potes) {
      const g = mapa.get(p.insumo_id) ?? {
        insumo_id: p.insumo_id, insumo: p.insumo, unidade: p.unidade,
        categoria: p.categoria, cor: p.cor,
        teorico: 0, potes: [] as typeof potes,
      }
      g.teorico += p.teorico
      g.potes.push(p)
      mapa.set(p.insumo_id, g)
    }
    return [...mapa.values()]
  }, [potes])

  /**
   * Seções por categoria (BALDES, LIQUIDOS, COBERTURAS, CONSERVANTES).
   *
   * A categoria não é enfeite: ela agrupa o que fica junto na fábrica. Quem
   * confere os baldes de secos não vai buscar a garrafinha de conservante no
   * meio do caminho — percorre uma prateleira de cada vez.
   */
  const secoes = useMemo(() => {
    const mapa = new Map<string, { nome: string; cor: string | null; grupos: typeof grupos }>()
    for (const g of grupos) {
      const s = mapa.get(g.categoria) ?? { nome: g.categoria, cor: g.cor, grupos: [] as typeof grupos }
      s.grupos.push(g)
      mapa.set(g.categoria, s)
    }
    return [...mapa.values()]
      .map(s => ({
        ...s,
        // Quantos potes ainda estão como vieram: nem pesados, nem zerados.
        // Vai no cabeçalho para que recolher a categoria não esconda trabalho.
        pendentes: s.grupos
          .flatMap(g => g.potes)
          .filter(p => p.papel !== 'nao_usa' && p.sobra === p.inicial).length,
      }))
      .sort((a, b) => {
        // "Sem categoria" por último: é a sobra do cadastro, não uma prateleira.
        if (a.nome === SEM_CATEGORIA) return 1
        if (b.nome === SEM_CATEGORIA) return -1
        return naturalmente.compare(a.nome, b.nome)
      })
  }, [grupos])

  /** Categorias recolhidas. Vazio = todas abertas. */
  const [categoriasFechadas, setCategoriasFechadas] = useState<Record<string, boolean>>({})

  /** Quais insumos estão com a lista de potes não usados aberta. */
  const [naoUsadosAbertos, setNaoUsadosAbertos] = useState<Record<string, boolean>>({})

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
        .select('*, local:locais(nome), insumo:insumos(nome,unidade_medida,categoria:categorias_insumo(nome,cor_hex)), lote:lotes(codigo,unidade,validade_pos_abertura)')
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

  // Soma pelos POTES, não pelas linhas de lote. `l.sobra` só é alterada pelo
  // botão Zerar — o peso digitado no recipiente vai para `sobraLocal`. Somar
  // por lote fazia a "Perda de insumos" do resumo ignorar tudo que era pesado.
  const totalConsumido = potes.reduce((acc, p) => acc + (p.inicial - p.sobra), 0)
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
        // `p.sobra` já vale 0 quando o pote está zerado (ver o memo `potes`)
        quantidade_final: p.sobra,
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
    <div className="p-4 max-w-6xl mx-auto min-h-screen">
      <button onClick={() => navigate('/producao')} className="text-sm text-gray-500 flex items-center gap-1 mb-4">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Voltar
      </button>
      <h1 className="text-xl font-bold text-gray-900 mb-1">Fechar Sessão</h1>
      {sessao && <p className="text-sm text-gray-500 mb-6">{sessao.codigo} · {sessao.data_producao}</p>}

      {/* Duas colunas: a lista de recipientes é longa e a produção precisa
          ficar à vista enquanto se percorre os potes. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] items-start">

      {/* Produção — vem primeiro no HTML para que no celular, onde as colunas
          viram uma só, continue sendo a primeira coisa da página.

          `self-start` é o que deixa a coluna grudar: sem ele o item de grid
          estica até o fim da linha e não sobra folga para rolar. O
          `max-h`/`overflow` salva o caso de a lateral ficar mais alta que a
          tela — aí ela rola por dentro em vez de perder o sticky. */}
      <aside className="space-y-4 self-start lg:col-start-2 lg:row-start-1
                        lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      <div className="space-y-3">
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

      {/* Resumo — acompanha a produção na lateral: os dois números que ele
          mostra mudam a cada pote pesado, e voltar ao fim da página para
          conferir cada mudança é o que a coluna fixa evita. */}
      {(fatorInsumos !== null || fatorProdutoGlobal !== null) && (
        <Card className="p-4 bg-gray-50 border border-gray-200">
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
      </aside>

      {/* Recipientes */}
      <div className="space-y-3 lg:col-start-1 lg:row-start-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Recipientes</h2>
          {/* Dizer de saída quantos números a pessoa vai ter que digitar: sem
              isso a página parece ter 51 tarefas quando tem 18. */}
          {grupos.length > 0 && (
            <p className="text-xs text-gray-400">
              {grupos.length} insumos · {potes.filter(p => p.papel === 'pesa').length} para pesar
            </p>
          )}
        </div>
        {locais.length === 0 && (
          <p className="text-sm text-gray-400 italic">Nenhum recipiente vinculado.</p>
        )}
        {/* Um bloco por INSUMO, não por recipiente. São 51 potes na sessão de
            teste, mas só 18 pedem balança — um por insumo, o último da fila.
            Os outros ou esvaziam por completo (a resposta é sempre zero) ou
            nem são abertos. Tratar os três casos como o mesmo trabalho é o que
            fazia a lista ficar quilométrica.

            Um peso por RECIPIENTE, não por lote: a balança pesa o pote inteiro.
            Quando há mistura, o sistema rateia o consumo entre os lotes de
            dentro na proporção do que cada um tinha (fechar_sessao_producao). */}
        {secoes.map((sec) => {
        const fechada = categoriasFechadas[sec.nome] ?? false
        return (
        <div key={sec.nome} className="space-y-3">
          {/* Cabeçalho da prateleira, que também recolhe. A bolinha usa a cor
              cadastrada na categoria — mesmo código de cor do resto do sistema.
              O contador de pendentes fica visível fechado: recolher serve para
              tirar da frente o que já foi resolvido, não para perder de vista
              o que falta. */}
          <button
            type="button"
            onClick={() => setCategoriasFechadas(s => ({ ...s, [sec.nome]: !fechada }))}
            className="flex items-center gap-2 pt-2 w-full text-left group"
          >
            <span className="text-xs text-gray-400 w-3 shrink-0">{fechada ? '▸' : '▾'}</span>
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: sec.cor ?? '#9ca3af' }}
            />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 group-hover:text-gray-700">
              {sec.nome}
            </h3>
            <span className="text-xs text-gray-400">
              {sec.grupos.length === 1 ? '1 insumo' : `${sec.grupos.length} insumos`}
            </span>
            {sec.pendentes > 0 && (
              <span className="text-xs text-unno-amber ml-auto">
                {sec.pendentes} {sec.pendentes === 1 ? 'pendente' : 'pendentes'}
              </span>
            )}
            {sec.pendentes === 0 && (
              <span className="text-xs text-emerald-600 ml-auto">tudo conferido</span>
            )}
          </button>

        {!fechada && sec.grupos.map((g) => {
          const b = bancada(g.unidade)
          const usados     = g.potes.filter(p => p.papel !== 'nao_usa')
          const naoUsados  = g.potes.filter(p => p.papel === 'nao_usa')
          const abertos    = naoUsadosAbertos[g.insumo_id] ?? false
          const visiveis   = abertos ? [...usados, ...naoUsados] : usados
          const pendentes  = usados.filter(
            p => p.papel === 'esvazia' && !p.lotes.every(l => l.zerado)).length

          return (
            <Card key={g.insumo_id} className="p-4">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <p className="font-medium text-gray-900 dark:text-unno-text">{g.insumo}</p>
                {g.teorico > 0 && (
                  <p className="text-xs text-gray-500 whitespace-nowrap">
                    precisa de <strong>{emBancada(g.teorico, b.fator)} {b.rotulo}</strong>
                  </p>
                )}
              </div>

              {/* O pote que "esvazia" só entra na conta depois de confirmado:
                  sem clique a sobra continua sendo o conteúdo inteiro, e o
                  consumo sairia zero. Avisar aqui evita fechar sem perceber. */}
              {pendentes > 0 && (
                <p className="text-xs text-unno-amber mb-1">
                  {pendentes === 1
                    ? 'Falta confirmar 1 recipiente esvaziado.'
                    : `Faltam confirmar ${pendentes} recipientes esvaziados.`}
                </p>
              )}

              <div className="divide-y divide-gray-100 dark:divide-white/5">
                {visiveis.map((p) => {
                  const zerado = p.lotes.every(l => l.zerado)
                  const consumoReal = p.inicial - p.sobra
                  const desvio = getDesvioStatus(consumoReal, p.teorico)
                  const misturado = p.lotes.length > 1

                  return (
                    <div key={p.local_id} className={`py-2 ${p.papel === 'nao_usa' ? 'opacity-60' : ''}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 dark:text-unno-text truncate">
                            {p.nome}
                            {p.primeiroDoInsumo && (
                              <span className="ml-2 text-[0.65rem] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
                                usar primeiro
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-gray-400">
                            {p.papel === 'esvazia' && `esvaziar por completo · ${emBancada(p.inicial, b.fator)} ${b.rotulo}`}
                            {p.papel === 'pesa' && `tem ${emBancada(p.inicial, b.fator)} · usar ${emBancada(p.teorico, b.fator)} ${b.rotulo}`}
                            {p.papel === 'nao_usa' && `não entra hoje · ${emBancada(p.inicial, b.fator)} ${b.rotulo}`}
                            {misturado && (
                              <span className="text-unno-amber"> · {p.lotes.length} lotes misturados</span>
                            )}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {!zerado && (
                            <input
                              type="number"
                              aria-label={`Sobra em ${p.nome} (${b.rotulo})`}
                              step={b.fator === 1 ? '0.001' : '1'}
                              min="0"
                              value={emBancada(p.sobra, b.fator)}
                              onChange={(e) => {
                                // Volta para a unidade do cadastro. O arredondamento
                                // evita que 350 g vire 0.35000000000000003 kg.
                                const digitado = parseFloat(e.target.value) || 0
                                setSobraLocalValue(p.local_id, Number((digitado / b.fator).toFixed(6)))
                              }}
                              className={`w-24 text-right text-sm rounded-lg border px-2 py-1.5 bg-white
                                dark:bg-unno-surface dark:text-unno-text focus:outline-none focus:ring-2
                                focus:ring-brand-500/40 ${
                                  p.papel === 'esvazia'
                                    ? 'border-unno-amber/60'
                                    : 'border-gray-300 dark:border-white/10'
                                }`}
                            />
                          )}
                          <span className="text-xs text-gray-400 w-5">{zerado ? '' : b.rotulo}</span>
                          <button
                            type="button"
                            onClick={() => p.lotes.forEach(l => toggleZerado(l.id))}
                            className={`text-xs px-2 py-1 rounded border transition-colors whitespace-nowrap ${
                              zerado
                                ? 'bg-red-50 border-red-300 text-red-700 font-medium'
                                : 'border-gray-300 text-gray-500 hover:border-red-300 hover:text-red-600'
                            }`}
                          >
                            {zerado ? 'Zerado' : 'Zerar'}
                          </button>
                        </div>
                      </div>

                      {misturado && (
                        <div className="mt-1 text-[0.7rem] text-gray-500 dark:text-unno-muted space-y-0.5 pl-2 border-l-2 border-unno-amber/40">
                          {p.lotes.map(l => (
                            <p key={l.id} className="font-mono">
                              {l.lote?.codigo} — {emBancada(l.quantidade_inicial, b.fator)} {b.rotulo}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* O desvio só interessa quando há teórico e quando o
                          número já foi mexido: senão toda linha nasce vermelha. */}
                      {p.teorico > 0 && (zerado || p.sobra !== p.inicial) && (
                        <p className={`mt-1 text-xs font-medium ${desvio === 'ok' ? 'text-emerald-600' : desvio === 'warning' ? 'text-yellow-600' : 'text-red-600'}`}>
                          Consumo real: {emBancada(consumoReal, b.fator)} {b.rotulo}
                          {' · '}Desvio: {emBancada(consumoReal - p.teorico, b.fator)} {b.rotulo}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Os não usados continuam alcançáveis: a fila é sugestão, e quem
                  produz pode ter aberto outro pote. Só não ocupam a tela. */}
              {naoUsados.length > 0 && (
                <button
                  type="button"
                  onClick={() => setNaoUsadosAbertos(s => ({ ...s, [g.insumo_id]: !abertos }))}
                  className="mt-2 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-unno-text"
                >
                  {abertos ? '▾ ocultar' : '▸ mostrar'} {naoUsados.length}{' '}
                  {naoUsados.length === 1 ? 'recipiente não usado hoje' : 'recipientes não usados hoje'}
                </button>
              )}
            </Card>
          )
        })}
        </div>
        )
        })}
      </div>

      </div>{/* fim da grade */}

      {/* Observações e o botão ficam fora da lateral fixa, na largura toda: o
          fechamento é irreversível e não deve ficar a um clique de distância
          enquanto ainda há pote por pesar. */}
      <div className="mb-4 mt-4">
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

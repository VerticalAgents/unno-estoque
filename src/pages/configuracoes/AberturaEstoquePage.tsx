import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { bancada, daBancada, emBancada, usaTara } from '../../lib/unidades'

/**
 * ABERTURA DE ESTOQUE — o primeiro dia de quem migra a operação para cá.
 *
 * Quem começa a usar o sistema já tem estoque: sacos na prateleira e baldes
 * cheios. Nada disso passou por um recebimento, e nada tem QR code ainda.
 * Fingir uma nota fiscal para cada item resolveria a tela e estragaria o
 * relatório — por isso o lote nasce marcado como saldo de abertura.
 *
 * A regra que orienta as duas etapas: **conta-se o que se enxerga.** O que
 * está no balde não entra na prateleira. A soma é problema do sistema, não de
 * quem está com a balança na mão.
 *
 * UNIDADES: a prateleira fala a unidade do cadastro (o saco diz "25 kg"); o
 * balde fala a da balança (o visor diz "4820 g"). A conversão acontece só na
 * fronteira do envio, como na Contagem.
 */

type Insumo = {
  id: string
  codigo: string
  nome: string
  unidade_medida: string
  tamanho_embalagem: number | null
}

type Recipiente = {
  id: string
  nome: string
  insumo_id: string
  capacidade_max: number | null
  peso_tara: number | null
}

type Marca = { id: string; nome: string }

/**
 * Um conjunto de embalagens iguais na prateleira.
 *
 * Descreve o que se vê: tantos pacotes fechados de tanto cada, mais o que
 * sobrou no que já está aberto. Pedir "quantidade total" e "em quantas
 * embalagens" parecia mais simples e era uma armadilha — 98 kg em 10
 * embalagens viravam dez etiquetas de 9,8 kg, e nenhum fardo de verdade tem
 * 9,8 kg. Quem transferisse um fardo fechado erraria 200 g todas as vezes.
 */
type Linha = {
  key: string
  marca_id: string
  validade: string
  sem_validade: boolean
  fechadas: string
  tamanho: string
  aberta: string
}

type Balde = {
  modo: 'vazio' | 'cheio' | 'peso'
  peso_bruto: string
  linha_key: string // de qual linha veio o conteúdo (só importa se houver mais de uma)
}

const novaLinha = (tamanhoPadrao?: number | null): Linha => ({
  key: Math.random().toString(36).slice(2),
  marca_id: '',
  validade: '',
  sem_validade: false,
  fechadas: '',
  tamanho: tamanhoPadrao ? String(tamanhoPadrao) : '',
  aberta: '',
})

const num = (s: string) => parseFloat(s) || 0
const inteiro = (s: string) => parseInt(s) || 0

/** Quanto essa linha representa, na unidade do insumo. */
function totalLinha(l: Linha): number {
  return Number((inteiro(l.fechadas) * num(l.tamanho) + num(l.aberta)).toFixed(3))
}

/** Quantas etiquetas essa linha gera: uma por pacote fechado, mais a aberta. */
function etiquetasLinha(l: Linha): number {
  const fechadas = num(l.tamanho) > 0 ? inteiro(l.fechadas) : 0
  return fechadas + (num(l.aberta) > 0 ? 1 : 0)
}

export function AberturaEstoquePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [etapa, setEtapa] = useState<1 | 2 | 3>(1)
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [recipientes, setRecipientes] = useState<Recipiente[]>([])
  const [marcasPorInsumo, setMarcasPorInsumo] = useState<Record<string, Marca[]>>({})
  const [jaTemLotes, setJaTemLotes] = useState(false)

  const [linhas, setLinhas] = useState<Record<string, Linha[]>>({})
  const [baldes, setBaldes] = useState<Record<string, Balde>>({})

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase
        .from('insumos')
        .select('id, codigo, nome, unidade_medida, tamanho_embalagem')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true)
        .order('codigo'),
      supabase
        .from('locais')
        .select('id, nome, insumo_id, capacidade_max, peso_tara')
        .eq('empresa_id', profile.empresa_id)
        .eq('tipo', 'estoque_produtivo')
        .eq('ativo', true)
        .order('nome'),
      supabase
        .from('fornecedores_insumos_marcas')
        .select('insumo_id, marca:marcas(id, nome)'),
      supabase
        .from('lotes')
        .select('id', { count: 'exact', head: true })
        .eq('empresa_id', profile.empresa_id)
        .eq('status', 'ativo'),
    ]).then(([ins, loc, vinc, lot]) => {
      const listaInsumos = (ins.data ?? []) as Insumo[]
      setInsumos(listaInsumos)
      setRecipientes((loc.data ?? []) as Recipiente[])
      setJaTemLotes((lot.count ?? 0) > 0)

      // Marcas que já foram vinculadas a cada insumo. Sem vínculo, a linha
      // simplesmente não mostra o campo — é opcional, não vale poluir a tela.
      const porInsumo: Record<string, Marca[]> = {}
      for (const v of (vinc.data ?? []) as { insumo_id: string; marca: Marca | Marca[] | null }[]) {
        const m = Array.isArray(v.marca) ? v.marca[0] : v.marca
        if (!m) continue
        const atual = porInsumo[v.insumo_id] ?? []
        if (!atual.some(x => x.id === m.id)) porInsumo[v.insumo_id] = [...atual, m]
      }
      setMarcasPorInsumo(porInsumo)

      // Uma linha em branco por insumo, e todo balde começa vazio: o padrão é
      // "não tenho", para que o que for preenchido seja sempre uma afirmação.
      const iniciais: Record<string, Linha[]> = {}
      for (const i of listaInsumos) iniciais[i.id] = [novaLinha(i.tamanho_embalagem)]
      setLinhas(iniciais)

      const b: Record<string, Balde> = {}
      for (const r of (loc.data ?? []) as Recipiente[]) {
        b[r.id] = { modo: 'vazio', peso_bruto: '', linha_key: '' }
      }
      setBaldes(b)
      setCarregando(false)
    })
  }, [profile])

  const recipientesPorInsumo = useMemo(() => {
    const m: Record<string, Recipiente[]> = {}
    for (const r of recipientes) (m[r.insumo_id] ??= []).push(r)
    return m
  }, [recipientes])

  function alterarLinha(insumoId: string, key: string, campo: keyof Linha, valor: string | boolean) {
    setLinhas(prev => ({
      ...prev,
      [insumoId]: (prev[insumoId] ?? []).map(l => (l.key === key ? { ...l, [campo]: valor } : l)),
    }))
  }

  function desdobrar(insumoId: string) {
    const tamanho = insumos.find(i => i.id === insumoId)?.tamanho_embalagem
    setLinhas(prev => ({ ...prev, [insumoId]: [...(prev[insumoId] ?? []), novaLinha(tamanho)] }))
  }

  function removerLinha(insumoId: string, key: string) {
    setLinhas(prev => ({ ...prev, [insumoId]: (prev[insumoId] ?? []).filter(l => l.key !== key) }))
    // Um balde não pode apontar para uma linha que deixou de existir.
    setBaldes(prev => {
      const novo = { ...prev }
      for (const id of Object.keys(novo)) {
        if (novo[id].linha_key === key) novo[id] = { ...novo[id], linha_key: '' }
      }
      return novo
    })
  }

  /** Quanto há no balde, na unidade do insumo. */
  function conteudoDoBalde(rec: Recipiente, insumo: Insumo): number {
    const b = baldes[rec.id]
    if (!b || b.modo === 'vazio') return 0
    if (b.modo === 'cheio') return rec.capacidade_max ?? 0
    const bruto = parseFloat(b.peso_bruto)
    if (isNaN(bruto)) return 0
    const tara = usaTara(insumo.unidade_medida) ? rec.peso_tara ?? 0 : 0
    return daBancada(Math.max(0, bruto - tara), bancada(insumo.unidade_medida).fator)
  }

  const resumo = useMemo(() => {
    let totalPrateleira = 0
    let totalBaldes = 0
    let insumosComSaldo = 0
    let etiquetas = 0
    let potesCheios = 0

    for (const insumo of insumos) {
      const ls = linhas[insumo.id] ?? []
      const naPrateleira = ls.reduce((s, l) => s + totalLinha(l), 0)
      const eti = ls.reduce((s, l) => s + etiquetasLinha(l), 0)
      const nosBaldes = (recipientesPorInsumo[insumo.id] ?? []).reduce(
        (s, r) => s + conteudoDoBalde(r, insumo),
        0,
      )
      const cheios = (recipientesPorInsumo[insumo.id] ?? []).filter(
        r => conteudoDoBalde(r, insumo) > 0,
      ).length

      totalPrateleira += naPrateleira
      totalBaldes += nosBaldes
      etiquetas += eti
      potesCheios += cheios
      if (naPrateleira > 0 || nosBaldes > 0) insumosComSaldo++
    }

    return { totalPrateleira, totalBaldes, insumosComSaldo, etiquetas, potesCheios }
  }, [insumos, linhas, baldes, recipientesPorInsumo])

  /** Erros que travam o envio, apontando o insumo pelo nome. */
  const problemas = useMemo(() => {
    const lista: string[] = []
    for (const insumo of insumos) {
      for (const l of linhas[insumo.id] ?? []) {
        // Pacote fechado sem tamanho não vira quantidade nenhuma — sem este
        // aviso o insumo entraria zerado e ninguém perceberia.
        if (inteiro(l.fechadas) > 0 && num(l.tamanho) <= 0) {
          lista.push(`${insumo.nome}: informe quanto vem em cada embalagem fechada.`)
        }
        if (totalLinha(l) <= 0) continue
        if (!l.validade && !l.sem_validade) {
          lista.push(`${insumo.nome}: informe a validade ou marque "não sei".`)
        }
      }
      for (const r of recipientesPorInsumo[insumo.id] ?? []) {
        // "Cheio" sem capacidade cadastrada não vira quantidade nenhuma. Sem
        // este aviso o pote entraria como vazio e ninguém perceberia.
        if (baldes[r.id]?.modo === 'cheio' && r.capacidade_max == null) {
          lista.push(`${r.nome}: marcado como cheio, mas não tem capacidade cadastrada.`)
        }
        const q = conteudoDoBalde(r, insumo)
        if (q <= 0) continue
        if (r.capacidade_max != null && q > r.capacidade_max) {
          lista.push(
            `${r.nome}: ${q} ${insumo.unidade_medida} passa da capacidade de ${r.capacidade_max}.`,
          )
        }
        const ls = (linhas[insumo.id] ?? []).filter(l => totalLinha(l) > 0)
        if (ls.length > 1 && !baldes[r.id]?.linha_key) {
          lista.push(`${r.nome}: escolha de qual embalagem veio o conteúdo.`)
        }
      }
    }
    return lista
  }, [insumos, linhas, baldes, recipientesPorInsumo])

  async function aplicar() {
    if (!profile) return
    setErro('')
    setSalvando(true)

    const itens: unknown[] = []

    for (const insumo of insumos) {
      const ls = linhas[insumo.id] ?? []
      const comSaldo = ls.filter(l => totalLinha(l) > 0)
      const recs = recipientesPorInsumo[insumo.id] ?? []

      // Cada balde entra na linha de onde veio. Com uma linha só (o caso
      // comum) não há escolha a fazer, e todos caem nela.
      const baldesDaLinha = (key: string) =>
        recs
          .filter(r => {
            if (conteudoDoBalde(r, insumo) <= 0) return false
            if (comSaldo.length <= 1) return true
            return baldes[r.id]?.linha_key === key
          })
          .map(r => ({ local_id: r.id, quantidade: conteudoDoBalde(r, insumo) }))

      if (comSaldo.length === 0) {
        // Balde cheio de insumo que não tem nada na prateleira: ainda é saldo.
        const soltos = recs
          .filter(r => conteudoDoBalde(r, insumo) > 0)
          .map(r => ({ local_id: r.id, quantidade: conteudoDoBalde(r, insumo) }))
        if (soltos.length > 0) {
          // Aproveita a validade e a marca que a pessoa digitou na etapa 1,
          // mesmo sem quantidade: ela olhou o rótulo, seria perder informação.
          const ref = ls[0]
          itens.push({
            insumo_id: insumo.id,
            marca_id: ref?.marca_id || null,
            validade: ref && !ref.sem_validade ? ref.validade || null : null,
            quantidade_prateleira: 0,
            embalagens: 1,
            baldes: soltos,
          })
        }
        continue
      }

      for (const l of comSaldo) {
        const comum = {
          insumo_id: insumo.id,
          marca_id: l.marca_id || null,
          validade: l.sem_validade ? null : l.validade || null,
        }
        // Os baldes entram uma vez só, no primeiro lote que essa linha gerar.
        let baldesPendentes = baldesDaLinha(l.key)

        const fechadas = inteiro(l.fechadas)
        const tamanho = num(l.tamanho)
        if (fechadas > 0 && tamanho > 0) {
          itens.push({
            ...comum,
            quantidade_prateleira: Number((fechadas * tamanho).toFixed(3)),
            embalagens: fechadas,
            baldes: baldesPendentes,
          })
          baldesPendentes = []
        }

        // A embalagem aberta vira lote próprio, com a quantidade que ela
        // realmente tem. É o que faz a etiqueta dizer 8 kg em vez de 9,8.
        const aberta = num(l.aberta)
        if (aberta > 0) {
          itens.push({
            ...comum,
            quantidade_prateleira: aberta,
            embalagens: 1,
            observacoes: 'Saldo de abertura — embalagem aberta',
            baldes: baldesPendentes,
          })
        }
      }
    }

    if (itens.length === 0) {
      setErro('Nada foi informado — preencha ao menos um insumo.')
      setSalvando(false)
      return
    }

    const { data, error } = await supabase.rpc('abrir_estoque_inicial', {
      p_empresa_id: profile.empresa_id,
      p_responsavel_id: profile.id,
      p_itens: itens,
    })

    const res = data as { ok: boolean; erro?: string; lotes?: unknown[] } | null

    if (error || !res?.ok) {
      setErro(error?.message ?? res?.erro ?? 'Não foi possível criar o estoque inicial.')
      setSalvando(false)
      return
    }

    // O ciclo só fecha com a etiqueta colada: é ela que dá QR ao que já existia.
    if (res.lotes && res.lotes.length > 0) {
      navigate('/recebimento/imprimir-lotes', { state: { lotes: res.lotes } })
    } else {
      navigate('/estoque/insumos')
    }
  }

  if (carregando) {
    return <div className="p-6 text-sm text-gray-500">Carregando…</div>
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-5">
        <button
          onClick={() => navigate('/configuracoes')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Abertura de estoque</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          O que você já tem hoje, para o sistema começar sabendo do que existe.
        </p>
      </div>

      <Passos etapa={etapa} />

      {jaTemLotes && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Já existe estoque ativo no sistema. Você pode seguir para lançar o que faltou,
          mas confira antes para não contar a mesma coisa duas vezes.
        </div>
      )}

      {etapa === 1 && (
        <EtapaPrateleira
          insumos={insumos}
          linhas={linhas}
          marcasPorInsumo={marcasPorInsumo}
          onAlterar={alterarLinha}
          onDesdobrar={desdobrar}
          onRemover={removerLinha}
        />
      )}

      {etapa === 2 && (
        <EtapaBaldes
          insumos={insumos}
          recipientesPorInsumo={recipientesPorInsumo}
          linhas={linhas}
          baldes={baldes}
          setBaldes={setBaldes}
          setRecipientes={setRecipientes}
          conteudoDoBalde={conteudoDoBalde}
        />
      )}

      {etapa === 3 && (
        <EtapaConferir resumo={resumo} problemas={problemas} insumos={insumos} />
      )}

      {erro && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {erro}
        </div>
      )}

      <div className="flex gap-3 mt-4 acoes-fixas">
        {etapa > 1 && (
          <Button variant="secondary" size="lg" onClick={() => setEtapa(e => (e - 1) as 1 | 2)}>
            Voltar
          </Button>
        )}
        {etapa < 3 ? (
          <Button size="lg" fullWidth onClick={() => setEtapa(e => (e + 1) as 2 | 3)}>
            Continuar
          </Button>
        ) : (
          <Button
            size="lg"
            fullWidth
            loading={salvando}
            disabled={problemas.length > 0}
            onClick={aplicar}
          >
            Criar estoque e imprimir etiquetas
          </Button>
        )}
      </div>
    </div>
  )
}

function Passos({ etapa }: { etapa: number }) {
  const nomes = ['Prateleira', 'Baldes', 'Conferir']
  return (
    <div className="flex items-center gap-2 mb-5">
      {nomes.map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <span
            className={[
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
              i + 1 === etapa
                ? 'bg-brand-600 text-white'
                : i + 1 < etapa
                  ? 'bg-brand-100 text-brand-700'
                  : 'bg-gray-100 text-gray-500',
            ].join(' ')}
          >
            {i + 1}. {n}
          </span>
          {i < nomes.length - 1 && <span className="text-gray-300">›</span>}
        </div>
      ))}
    </div>
  )
}

// ── Etapa 1 ───────────────────────────────────────────────────
function EtapaPrateleira({
  insumos,
  linhas,
  marcasPorInsumo,
  onAlterar,
  onDesdobrar,
  onRemover,
}: {
  insumos: Insumo[]
  linhas: Record<string, Linha[]>
  marcasPorInsumo: Record<string, Marca[]>
  onAlterar: (insumoId: string, key: string, campo: keyof Linha, valor: string | boolean) => void
  onDesdobrar: (insumoId: string) => void
  onRemover: (insumoId: string, key: string) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Quanto há <strong>fora dos baldes</strong> — na prateleira, na câmara, no chão.
        O que já está dentro dos potes fica para a próxima etapa. Deixe em branco o que não tiver.
      </p>

      {insumos.map(insumo => {
        const ls = linhas[insumo.id] ?? []
        const marcas = marcasPorInsumo[insumo.id] ?? []
        return (
          <Card key={insumo.id} className="p-4">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 truncate">{insumo.nome}</p>
                <p className="text-xs text-gray-500">{insumo.codigo}</p>
              </div>
              <span className="text-xs font-medium text-gray-400 shrink-0">
                {insumo.unidade_medida}
              </span>
            </div>

            <div className="space-y-3">
              {ls.map((l, idx) => (
                <div key={l.key} className={idx > 0 ? 'border-t border-gray-100 pt-3' : ''}>
                  {ls.length > 1 && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                        Embalagem {idx + 1}
                      </span>
                      <button
                        onClick={() => onRemover(insumo.id, l.key)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        remover
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Embalagens fechadas
                      </span>
                      <input
                        type="number"
                        inputMode="numeric"
                        step="1"
                        min="0"
                        value={l.fechadas}
                        onChange={e => onAlterar(insumo.id, l.key, 'fechadas', e.target.value)}
                        placeholder="0"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Cada uma tem ({insumo.unidade_medida})
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.001"
                        min="0"
                        value={l.tamanho}
                        onChange={e => onAlterar(insumo.id, l.key, 'tamanho', e.target.value)}
                        placeholder="0"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>
                  </div>

                  <div className="mt-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Embalagem aberta — quanto sobrou ({insumo.unidade_medida})
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.001"
                        min="0"
                        value={l.aberta}
                        onChange={e => onAlterar(insumo.id, l.key, 'aberta', e.target.value)}
                        placeholder="deixe em branco se não houver"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>
                  </div>

                  {/* A conta aparece pronta: é o que confere com a prateleira. */}
                  {totalLinha(l) > 0 && (
                    <p className="mt-2 text-sm text-gray-600">
                      Total:{' '}
                      <strong className="text-gray-900">
                        {totalLinha(l)} {insumo.unidade_medida}
                      </strong>{' '}
                      <span className="text-gray-400">
                        · {etiquetasLinha(l)} etiqueta{etiquetasLinha(l) === 1 ? '' : 's'}
                      </span>
                    </p>
                  )}

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Um <label> dentro de outro faz o clique no texto do
                        checkbox cair no campo de data. São dois campos. */}
                    <div className="flex flex-col gap-1">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Validade da embalagem
                        </span>
                        <input
                          type="date"
                          value={l.validade}
                          disabled={l.sem_validade}
                          onChange={e => onAlterar(insumo.id, l.key, 'validade', e.target.value)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm disabled:bg-gray-50 disabled:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                        <input
                          type="checkbox"
                          checked={l.sem_validade}
                          onChange={e => onAlterar(insumo.id, l.key, 'sem_validade', e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Não sei a validade
                      </label>
                    </div>

                    {marcas.length > 0 && (
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Marca (opcional)
                        </span>
                        <select
                          value={l.marca_id}
                          onChange={e => onAlterar(insumo.id, l.key, 'marca_id', e.target.value)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                        >
                          <option value="">Sem marca</option>
                          {marcas.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.nome}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => onDesdobrar(insumo.id)}
              className="mt-3 text-xs font-medium text-brand-700 hover:underline"
            >
              + Tenho mais de uma marca ou validade
            </button>
          </Card>
        )
      })}
    </div>
  )
}

// ── Etapa 2 ───────────────────────────────────────────────────
function EtapaBaldes({
  insumos,
  recipientesPorInsumo,
  linhas,
  baldes,
  setBaldes,
  setRecipientes,
  conteudoDoBalde,
}: {
  insumos: Insumo[]
  recipientesPorInsumo: Record<string, Recipiente[]>
  linhas: Record<string, Linha[]>
  baldes: Record<string, Balde>
  setBaldes: React.Dispatch<React.SetStateAction<Record<string, Balde>>>
  setRecipientes: React.Dispatch<React.SetStateAction<Recipiente[]>>
  conteudoDoBalde: (rec: Recipiente, insumo: Insumo) => number
}) {
  const comRecipientes = insumos.filter(i => (recipientesPorInsumo[i.id] ?? []).length > 0)

  function ajustar(id: string, patch: Partial<Balde>) {
    setBaldes(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  /** A tara fica salva no recipiente: pesa-se uma vez, vale para sempre. */
  async function salvarTara(rec: Recipiente, valor: string) {
    const tara = parseFloat(valor)
    if (isNaN(tara) || tara < 0) return
    await supabase.from('locais').update({ peso_tara: tara }).eq('id', rec.id)
    setRecipientes(prev => prev.map(r => (r.id === rec.id ? { ...r, peso_tara: tara } : r)))
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Agora o que está <strong>dentro dos potes</strong>. Ponha na balança e digite o peso
        que aparece no visor — o sistema desconta a tara sozinho. O que estiver vazio, deixe
        como está.
      </p>

      {comRecipientes.map(insumo => {
        const b = bancada(insumo.unidade_medida)
        const temTara = usaTara(insumo.unidade_medida)
        const opcoes = (linhas[insumo.id] ?? []).filter(l => totalLinha(l) > 0)

        return (
          <Card key={insumo.id} className="p-4">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <p className="font-semibold text-gray-900 truncate">{insumo.nome}</p>
              <span className="text-xs font-medium text-gray-400 shrink-0">{insumo.codigo}</span>
            </div>

            <div className="space-y-3">
              {(recipientesPorInsumo[insumo.id] ?? []).map(rec => {
                const est = baldes[rec.id]
                const liquido = conteudoDoBalde(rec, insumo)
                const precisaTara = temTara && !rec.peso_tara && est?.modo === 'peso'

                return (
                  <div key={rec.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex items-baseline justify-between gap-2 mb-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{rec.nome}</span>
                      {rec.capacidade_max != null && (
                        <span className="text-xs text-gray-400 shrink-0">
                          cabe {rec.capacidade_max} {insumo.unidade_medida}
                        </span>
                      )}
                    </div>

                    <div className="flex gap-2">
                      {(['vazio', 'cheio', 'peso'] as const).map(modo => (
                        <button
                          key={modo}
                          onClick={() => ajustar(rec.id, { modo })}
                          className={[
                            'flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                            est?.modo === modo
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-gray-300 text-gray-600 hover:bg-gray-50',
                          ].join(' ')}
                        >
                          {modo === 'vazio' ? 'Vazio' : modo === 'cheio' ? 'Cheio' : 'Pesar'}
                        </button>
                      ))}
                    </div>

                    {est?.modo === 'peso' && (
                      <div className="mt-2 space-y-2">
                        {precisaTara && (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                            <p className="text-xs text-amber-800 mb-1.5">
                              Este pote ainda não tem tara. Pese-o vazio uma vez:
                            </p>
                            <input
                              type="number"
                              inputMode="decimal"
                              placeholder={`Peso do pote vazio (${b.rotulo})`}
                              onBlur={e => salvarTara(rec, e.target.value)}
                              className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
                            />
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={est.peso_bruto}
                            onChange={e => ajustar(rec.id, { peso_bruto: e.target.value })}
                            placeholder={`Peso com o pote (${b.rotulo})`}
                            className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                          />
                          {liquido > 0 && (
                            <span className="text-sm font-semibold text-brand-700 whitespace-nowrap">
                              = {emBancada(liquido, b.fator)} {b.rotulo}
                            </span>
                          )}
                        </div>
                        {temTara && (rec.peso_tara ?? 0) > 0 && (
                          <p className="text-xs text-gray-400">
                            tara do pote: {rec.peso_tara} {b.rotulo}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Só aparece quando há mesmo uma escolha a fazer. */}
                    {liquido > 0 && opcoes.length > 1 && (
                      <select
                        value={est?.linha_key ?? ''}
                        onChange={e => ajustar(rec.id, { linha_key: e.target.value })}
                        className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">De qual embalagem veio?</option>
                        {opcoes.map((l, i) => (
                          <option key={l.key} value={l.key}>
                            Embalagem {i + 1}
                            {l.validade ? ` — vence ${l.validade}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

// ── Etapa 3 ───────────────────────────────────────────────────
function EtapaConferir({
  resumo,
  problemas,
  insumos,
}: {
  resumo: {
    totalPrateleira: number
    totalBaldes: number
    insumosComSaldo: number
    etiquetas: number
    potesCheios: number
  }
  problemas: string[]
  insumos: Insumo[]
}) {
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">O que vai ser criado</p>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Item rotulo="Insumos com saldo" valor={`${resumo.insumosComSaldo} de ${insumos.length}`} />
          <Item rotulo="Etiquetas a imprimir" valor={String(resumo.etiquetas)} />
          <Item rotulo="Potes com conteúdo" valor={String(resumo.potesCheios)} />
          <Item
            rotulo="Total lançado"
            valor={`${(resumo.totalPrateleira + resumo.totalBaldes).toFixed(3)}`}
          />
        </dl>
        <p className="text-xs text-gray-500 mt-3">
          Os lotes nascem marcados como <strong>saldo de abertura</strong>, não como compra —
          assim eles não entram nos relatórios de entrada nem atrapalham o primeiro
          fechamento de perdas.
        </p>
      </Card>

      {problemas.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800 mb-1.5">Falta resolver:</p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-red-700">
            {problemas.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Ao confirmar, o sistema abre a página de impressão com as etiquetas dos lotes da
          prateleira. Cole cada uma na embalagem correspondente — é o QR delas que fará a
          transferência e a produção funcionarem daqui pra frente.
        </div>
      )}
    </div>
  )
}

function Item({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{rotulo}</dt>
      <dd className="text-lg font-semibold text-gray-900">{valor}</dd>
    </div>
  )
}

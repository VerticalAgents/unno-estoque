import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { semanaDeTrabalho } from '../../lib/utils'

/**
 * Planejador Semanal de Produção.
 *
 * A regra que manda no algoritmo: trocar de sabor obriga a lavar os utensílios.
 * Por isso a semana NÃO se divide igual entre os dias — enche-se cada dia com
 * um sabor só e lava-se no fim. Misturar dois produtos num dia é exceção,
 * aceitável quando a sobra não fecha um dia inteiro.
 *
 * A distribuição roda aqui e não no banco porque precisa responder a cada tecla
 * e aceitar ajuste manual. O banco (`salvar_plano_semana`, migration 049)
 * guarda o resultado.
 */

const FORMAS_POR_BATELADA = 4
const DIAS_LABEL = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

interface FichaOption {
  id: string
  codigo: string
  nome: string
  rendimento_fornada: number | null
}

/** formas por dia (chave `${data}|${ficha_id}`) */
type Grade = Record<string, number>

/**
 * O que as sessões de produção registraram, vindo de `v_plano_semana`
 * (migration 051). `formas` NULL significa que ainda não aconteceu — é
 * diferente de ter acontecido zero, e é o que distingue "em andamento" de
 * "não cumprido".
 */
interface Realizado {
  formas: number | null
  unidades: number | null
  em_andamento: boolean
  fora_do_plano: boolean
}

const chave = (data: string, fichaId: string) => `${data}|${fichaId}`

// ── Datas ─────────────────────────────────────────────────────
// Tudo em string YYYY-MM-DD para não esbarrar em fuso: `new Date('2026-08-03')`
// é meia-noite UTC, que no Brasil cai no dia 2.

function paraData(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d)
}

function paraISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function somarDias(iso: string, n: number): string {
  const d = paraData(iso)
  d.setDate(d.getDate() + n)
  return paraISO(d)
}

function diaCurto(iso: string): string {
  const d = paraData(iso)
  return `${DIAS_LABEL[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fmt(n: number, casas = 0) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

const printStyles = `
  .semana-print-target { display: none; }

  @page { size: A4 portrait; margin: 14mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    body > * { visibility: hidden; }

    .semana-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0; left: 0; right: 0;
      color: #111;
      font-size: 11pt;
    }
    .semana-print-target * { visibility: visible !important; color: #111 !important; }
    .semana-print-target table { width: 100%; border-collapse: collapse; }
    .semana-print-target th, .semana-print-target td {
      border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left;
    }
    .semana-print-target th {
      border-bottom: 1.5px solid #333; font-size: 9pt; text-transform: uppercase;
    }
    .semana-print-target .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .semana-print-target .mono { font-family: 'Courier New', monospace; font-size: 9pt; }
    .semana-print-target thead { display: table-header-group; }
    .semana-print-target tr { page-break-inside: avoid; }
    .semana-print-target .small { font-size: 8pt; color: #666 !important; }
    /* primeira linha de cada dia abre o bloco */
    .semana-print-target .dia td { border-top: 1px solid #999; padding-top: 8px; }
    .semana-print-target .caixa { letter-spacing: 2px; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

export function PlanejadorSemanaPage({
  onVerAbastecimento,
}: {
  /** Leva as formas de um dia para a aba "Dia". */
  onVerAbastecimento?: (formas: Record<string, string>) => void
}) {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [semana, setSemana] = useState(semanaDeTrabalho)
  const [diasAtivos, setDiasAtivos] = useState<string[]>([])
  const [grade, setGrade] = useState<Grade>({})
  // Mexeu num dia na mão: o auto-distribuir para de rodar, senão desfaria o
  // ajuste na próxima tecla digitada na meta.
  const [ajustado, setAjustado] = useState(false)

  /**
   * Como a meta vira dias.
   *
   *   blocos — um produto por dia, lavando só na troca (o padrão)
   *   igual  — todo dia com o mesmo mix
   *   manual — o sistema não distribui, quem distribui é você
   */
  const [preenchimento, setPreenchimento] = useState<'blocos' | 'igual' | 'manual'>('blocos')
  /** Prioridade: quem vem primeiro ocupa os primeiros dias da semana. */
  const [ordem, setOrdem] = useState<string[]>([])

  // Meta da semana — mesmo desenho da tela de Reabastecimento
  const [modo, setModo] = useState<'unidades' | 'percentual'>('unidades')
  const [alvo, setAlvo] = useState<Record<string, string>>({})
  const [totalDigitado, setTotalDigitado] = useState('')
  const [pct, setPct] = useState<Record<string, string>>({})

  // Capacidade dos recipientes e receitas: buscadas uma vez, usadas em toda
  // edição sem ida ao banco
  const [capacidade, setCapacidade] = useState<Record<string, { nome: string; unidade: string; capacidade: number }>>({})
  const [receitas, setReceitas] = useState<Record<string, { insumo_id: string; quantidade: number }[]>>({})

  const [realizado, setRealizado] = useState<Record<string, Realizado>>({})
  // Linhas de produto abertas na mão num dia, ainda sem quantidade. Some ao
  // trocar de semana; é estado de digitação, não do plano.
  const [abertos, setAbertos] = useState<string[]>([])

  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [salvoEm, setSalvoEm] = useState<string | null>(null)
  const [empresaNome, setEmpresaNome] = useState('')

  const num = (s: string | undefined) => parseFloat((s ?? '').replace(',', '.')) || 0

  const diasDaSemana = useMemo(
    () => Array.from({ length: 7 }, (_, i) => somarDias(semana, i)),
    [semana],
  )

  // ── Carga inicial ───────────────────────────────────────────
  useEffect(() => {
    if (!profile) return

    async function carregar() {
      const [fichasRes, capRes, empRes] = await Promise.all([
        supabase.from('fichas_tecnicas')
          .select('id, codigo, nome, versoes:fichas_tecnicas_versoes!inner(id, rendimento_fornada, ativa)')
          .eq('empresa_id', profile!.empresa_id)
          .eq('ativo', true).eq('tipo', 'produto').order('codigo'),
        supabase.from('v_recipientes_composicao')
          .select('insumo_id, insumo_nome, unidade_medida, capacidade_max')
          .eq('empresa_id', profile!.empresa_id),
        supabase.from('empresas').select('nome').eq('id', profile!.empresa_id).maybeSingle(),
      ])

      const rows = (fichasRes.data ?? []) as unknown as {
        id: string; codigo: string; nome: string
        versoes: { id: string; rendimento_fornada: number | null; ativa: boolean }[]
      }[]
      const opts = rows.map(f => ({
        id: f.id, codigo: f.codigo, nome: f.nome,
        rendimento_fornada: f.versoes.find(v => v.ativa)?.rendimento_fornada ?? null,
      }))
      setFichas(opts)
      setOrdem(o => (o.length > 0 ? o : opts.map(f => f.id)))

      // Capacidade somada dos recipientes por insumo
      const cap: Record<string, { nome: string; unidade: string; capacidade: number }> = {}
      for (const r of (capRes.data ?? []) as unknown as {
        insumo_id: string; insumo_nome: string; unidade_medida: string; capacidade_max: number | null
      }[]) {
        const atual = cap[r.insumo_id] ?? { nome: r.insumo_nome, unidade: r.unidade_medida, capacidade: 0 }
        atual.capacidade += Number(r.capacidade_max ?? 0)
        cap[r.insumo_id] = atual
      }
      setCapacidade(cap)

      // Receita de cada ficha, para a conta de demanda por dia
      const versoes = rows.flatMap(f => {
        const v = f.versoes.find(x => x.ativa)
        return v ? [{ ficha_id: f.id, versao_id: v.id }] : []
      })
      if (versoes.length > 0) {
        const { data: itens } = await supabase
          .from('fichas_tecnicas_itens')
          .select('versao_id, insumo_id, quantidade')
          .in('versao_id', versoes.map(v => v.versao_id))
        const porFicha: Record<string, { insumo_id: string; quantidade: number }[]> = {}
        for (const v of versoes) {
          porFicha[v.ficha_id] = ((itens ?? []) as { versao_id: string; insumo_id: string; quantidade: number }[])
            .filter(i => i.versao_id === v.versao_id)
            .map(i => ({ insumo_id: i.insumo_id, quantidade: Number(i.quantidade) }))
        }
        setReceitas(porFicha)
      }

      setEmpresaNome(empRes.data?.nome ?? '')
      setLoading(false)
    }

    carregar()
  }, [profile])

  // ── Carrega o plano da semana escolhida ─────────────────────
  // Depende das fichas porque reconstrói a meta a partir das formas gravadas —
  // sem elas não há rendimento para converter formas em unidades.
  const carregarSemana = useCallback(async () => {
    if (!profile || fichas.length === 0) return
    setAbertos([])   // linhas abertas na mão são da semana que está saindo
    const { data: plano } = await supabase
      .from('planos_semana')
      .select('id, dias_ativos, updated_at, modo_preenchimento, ordem_fichas, itens:planos_semana_itens(data, ficha_id, formas)')
      .eq('empresa_id', profile.empresa_id)
      .eq('semana_inicio', semana)
      .maybeSingle()

    if (!plano) {
      // Semana nova: segunda a sexta marcadas, grade limpa
      setDiasAtivos(Array.from({ length: 5 }, (_, i) => somarDias(semana, i)))
      setGrade({})
      setAlvo({})
      setTotalDigitado('')
      setPct({})
      setAjustado(false)
      setSalvoEm(null)
      setRealizado({})
      return
    }

    // O que a produção registrou. Só existe para semana com plano salvo — sem
    // plano não há com o que comparar.
    const { data: real } = await supabase
      .from('v_plano_semana')
      .select('data, ficha_id, formas_realizadas, unidades_produzidas, em_andamento, fora_do_plano')
      .eq('empresa_id', profile.empresa_id)
      .eq('semana_inicio', semana)

    setRealizado(Object.fromEntries(
      ((real ?? []) as unknown as {
        data: string; ficha_id: string
        formas_realizadas: number | null; unidades_produzidas: number | null
        em_andamento: boolean; fora_do_plano: boolean
      }[]).map(r => [
        chave(String(r.data).slice(0, 10), r.ficha_id),
        {
          formas: r.formas_realizadas == null ? null : Number(r.formas_realizadas),
          unidades: r.unidades_produzidas == null ? null : Number(r.unidades_produzidas),
          em_andamento: r.em_andamento,
          fora_do_plano: r.fora_do_plano,
        },
      ]),
    ))

    const p = plano as unknown as {
      dias_ativos: string[]; updated_at: string
      modo_preenchimento: 'blocos' | 'igual' | 'manual'
      ordem_fichas: string[]
      itens: { data: string; ficha_id: string; formas: number }[]
    }
    setDiasAtivos((p.dias_ativos ?? []).map(d => String(d).slice(0, 10)))
    setPreenchimento(p.modo_preenchimento ?? 'blocos')
    // Ficha que não estava na ordem salva entra no fim, na ordem do código.
    setOrdem([
      ...(p.ordem_fichas ?? []).filter(id => fichas.some(f => f.id === id)),
      ...fichas.map(f => f.id).filter(id => !(p.ordem_fichas ?? []).includes(id)),
    ])
    const g: Grade = {}
    for (const i of p.itens ?? []) g[chave(String(i.data).slice(0, 10), i.ficha_id)] = i.formas
    setGrade(g)
    setSalvoEm(p.updated_at)

    // A meta do topo é reconstruída aqui, na carga, e não por efeito reativo.
    // Reagir a `grade` faria a meta seguir cada ajuste manual de dia — e aí o
    // aviso de divergência nunca apareceria, porque os dois lados da conta
    // seriam a mesma coisa.
    const porFicha: Record<string, string> = {}
    for (const f of fichas) {
      const formas = Object.entries(g)
        .filter(([k]) => k.endsWith(`|${f.id}`))
        .reduce((s, [, v]) => s + v, 0)
      const un = formas * (f.rendimento_fornada ?? 0)
      if (un > 0) porFicha[f.id] = String(un)
    }
    setAlvo(porFicha)
    setModo('unidades')

    // Plano gravado é plano ajustado: não redistribuir por conta própria.
    setAjustado(true)
  }, [profile, semana, fichas])

  useEffect(() => { carregarSemana() }, [carregarSemana])

  // ── Meta ────────────────────────────────────────────────────
  const alvoEfetivo = useMemo<Record<string, number>>(() => {
    if (modo === 'unidades') {
      return Object.fromEntries(fichas.map(f => [f.id, num(alvo[f.id])]))
    }
    const total = num(totalDigitado)
    return Object.fromEntries(fichas.map(f => [f.id, Math.round(total * num(pct[f.id]) / 100)]))
  }, [modo, fichas, alvo, totalDigitado, pct])

  const totalPct = useMemo(() => fichas.reduce((s, f) => s + num(pct[f.id]), 0), [fichas, pct])

  /** As fichas na ordem de prioridade escolhida. */
  const fichasOrdenadas = useMemo(
    () => [
      ...ordem.map(id => fichas.find(f => f.id === id)).filter(Boolean) as FichaOption[],
      ...fichas.filter(f => !ordem.includes(f.id)),
    ],
    [fichas, ordem],
  )

  /** Meta em unidades → formas e bateladas de cada ficha, na ordem escolhida. */
  const metas = useMemo(
    () => fichasOrdenadas.map(f => {
      const unidades = alvoEfetivo[f.id] ?? 0
      const rend = f.rendimento_fornada ?? 0
      const formas = rend > 0 ? Math.ceil(unidades / rend) : 0
      return { ficha: f, unidades, formas, bateladas: Math.ceil(formas / FORMAS_POR_BATELADA) }
    }).filter(m => m.formas > 0),
    [fichasOrdenadas, alvoEfetivo],
  )

  const totalUnidadesMeta = metas.reduce((s, m) => s + m.unidades, 0)

  // ── A distribuição em blocos ────────────────────────────────
  /**
   * Enche dia a dia com um produto só, na ordem do código. Cada produto só
   * transborda uma vez para o dia seguinte, então há no máximo uma lavagem por
   * troca de produto.
   *
   * A conta corre em bateladas (é o que a produção agenda) e converte para
   * formas no fim, com o último dia de cada produto levando o resto — a última
   * batelada de um produto costuma ser parcial.
   */
  const distribuir = useCallback((): Grade => {
    const dias = diasAtivos.filter(d => diasDaSemana.includes(d)).sort()
    if (dias.length === 0 || metas.length === 0) return {}

    // No modo manual o sistema não opina — quem distribui é o usuário.
    if (preenchimento === 'manual') return {}

    // Mix igual: cada produto espalhado por todos os dias. O último dia que
    // recebe leva as formas restantes, para a soma bater exata.
    if (preenchimento === 'igual') {
      const nova: Grade = {}
      for (const m of metas) {
        const porDia = Math.floor(m.bateladas / dias.length)
        const resto  = m.bateladas % dias.length
        const fatias = dias
          .map((dia, i) => ({ dia, bat: porDia + (i < resto ? 1 : 0) }))
          .filter(f => f.bat > 0)
        let formasRestantes = m.formas
        fatias.forEach((f, i) => {
          const formas = i === fatias.length - 1
            ? formasRestantes
            : Math.min(f.bat * FORMAS_POR_BATELADA, formasRestantes)
          if (formas > 0) nova[chave(f.dia, m.ficha.id)] = formas
          formasRestantes -= formas
        })
      }
      return nova
    }

    const totalBateladas = metas.reduce((s, m) => s + m.bateladas, 0)
    const base = Math.ceil(totalBateladas / dias.length)

    const fila = metas.map(m => ({
      fichaId: m.ficha.id,
      bateladasRestantes: m.bateladas,
      formasRestantes: m.formas,
    }))

    const nova: Grade = {}
    let i = 0

    for (const dia of dias) {
      let capacidadeDia = base
      while (capacidadeDia > 0 && i < fila.length) {
        const item = fila[i]
        const leva = Math.min(item.bateladasRestantes, capacidadeDia)

        // O último pedaço de um produto leva as formas que sobraram, para a
        // soma dos dias bater exatamente com o total da ficha.
        const formas = leva === item.bateladasRestantes
          ? item.formasRestantes
          : Math.min(leva * FORMAS_POR_BATELADA, item.formasRestantes)

        if (formas > 0) {
          nova[chave(dia, item.fichaId)] = (nova[chave(dia, item.fichaId)] ?? 0) + formas
        }

        item.bateladasRestantes -= leva
        item.formasRestantes   -= formas
        capacidadeDia          -= leva

        if (item.bateladasRestantes <= 0) i++
      }
      if (i >= fila.length) break
    }

    return nova
  }, [diasAtivos, diasDaSemana, metas, preenchimento])

  // Redistribui sozinho enquanto ninguém mexeu num dia na mão
  useEffect(() => {
    if (ajustado) return
    setGrade(distribuir())
  }, [distribuir, ajustado])

  function editarDia(dia: string, fichaId: string, valor: string) {
    const n = parseInt(valor) || 0
    setAjustado(true)
    setGrade(g => {
      const novo = { ...g }
      if (n > 0) novo[chave(dia, fichaId)] = n
      else delete novo[chave(dia, fichaId)]
      return novo
    })
  }

  /** Sobe ou desce um produto na prioridade da semana. */
  function moverFicha(indice: number, direcao: -1 | 1) {
    const destino = indice + direcao
    if (destino < 0 || destino >= fichasOrdenadas.length) return
    const ids = fichasOrdenadas.map(f => f.id)
    ;[ids[indice], ids[destino]] = [ids[destino], ids[indice]]
    setOrdem(ids)
    setAjustado(false)   // ordem nova pede distribuição nova
  }

  function alternarDia(dia: string) {
    setDiasAtivos(d => (d.includes(dia) ? d.filter(x => x !== dia) : [...d, dia].sort()))
    setAjustado(false)
  }

  const temRealizado = useMemo(
    () => Object.values(realizado).some(r => r.formas != null),
    [realizado],
  )

  // ── Números por dia ─────────────────────────────────────────
  const porDia = useMemo(() => {
    // Dia que produziu sem estar marcado também precisa aparecer — é metade da
    // resposta de "o que aconteceu nesta semana".
    const diasComProducao = Object.entries(realizado)
      .filter(([, r]) => r.formas != null)
      .map(([k]) => k.split('|')[0])

    const dias = [...new Set([...diasAtivos, ...diasComProducao])]
      .filter(d => diasDaSemana.includes(d))
      .sort()

    return dias.map(dia => {
      const itens = fichas
        .map(f => ({
          ficha: f,
          formas: grade[chave(dia, f.id)] ?? 0,
          real: realizado[chave(dia, f.id)],
        }))
        // Entra quem está planejado ou quem foi produzido
        .filter(i => i.formas > 0 || i.real?.formas != null)

      const formas = itens.reduce((s, i) => s + i.formas, 0)
      const formasReais = itens.reduce((s, i) => s + (i.real?.formas ?? 0), 0)
      const emAndamento = itens.some(i => i.real?.em_andamento)
      const foraDoPlano = itens.some(i => i.real?.fora_do_plano)
      const unidades = itens.reduce((s, i) => s + i.formas * (i.ficha.rendimento_fornada ?? 0), 0)

      // Demanda de insumo daquele dia, para saber se cabe nos recipientes
      const demanda: Record<string, number> = {}
      for (const i of itens) {
        for (const r of receitas[i.ficha.id] ?? []) {
          demanda[r.insumo_id] = (demanda[r.insumo_id] ?? 0) + r.quantidade * i.formas
        }
      }

      // Só a capacidade — o conteúdo dos potes na quinta depende do que for
      // consumido até lá, e prever isso seria chute.
      const apertados = Object.entries(demanda)
        .map(([insumoId, qtd]) => {
          const cap = capacidade[insumoId]
          if (!cap || cap.capacidade <= 0) return null
          const rodadas = Math.ceil(qtd / cap.capacidade)
          return rodadas > 1
            ? { nome: cap.nome, unidade: cap.unidade, qtd, cap: cap.capacidade, rodadas }
            : null
        })
        .filter(Boolean) as { nome: string; unidade: string; qtd: number; cap: number; rodadas: number }[]

      return { dia, itens, formas, formasReais, emAndamento, foraDoPlano, unidades, apertados }
    })
  }, [diasAtivos, diasDaSemana, fichas, grade, receitas, capacidade, realizado])

  const totalFormas = porDia.reduce((s, d) => s + d.formas, 0)
  const totalUnidades = porDia.reduce((s, d) => s + d.unidades, 0)

  /**
   * Quanto de cada ficha ainda falta distribuir, descendo de segunda em diante.
   *
   * Sem isto, distribuir na mão é adivinhação: dá para digitar dia a dia sem
   * nunca saber quanto do total já foi abatido.
   */
  const saldos = useMemo(() => {
    const out: Record<string, { antes: number; depois: number }> = {}
    const acumulado: Record<string, number> = {}
    for (const d of porDia) {
      for (const f of fichas) {
        const meta = metas.find(m => m.ficha.id === f.id)?.formas ?? 0
        const antes = meta - (acumulado[f.id] ?? 0)
        acumulado[f.id] = (acumulado[f.id] ?? 0) + (grade[chave(d.dia, f.id)] ?? 0)
        out[chave(d.dia, f.id)] = { antes, depois: meta - acumulado[f.id] }
      }
    }
    return out
  }, [porDia, fichas, metas, grade])

  /** Meta × distribuído × falta, por ficha. */
  const balanco = useMemo(
    () => metas.map(m => {
      const distribuido = diasDaSemana.reduce((s, d) => s + (grade[chave(d, m.ficha.id)] ?? 0), 0)
      return {
        ficha: m.ficha,
        meta: m.formas,
        distribuido,
        falta: m.formas - distribuido,
      }
    }),
    [metas, grade, diasDaSemana],
  )

  const faltaDistribuir = balanco.some(b => b.falta !== 0)
  // O saldo interessa quando é você quem está distribuindo — nos modos
  // automáticos ele fecha sempre em zero e viraria ruído.
  const mostrarSaldo = preenchimento === 'manual' || ajustado

  async function salvar() {
    if (!profile) return
    setSalvando(true)
    setErro('')

    const itens = Object.entries(grade)
      .filter(([, formas]) => formas > 0)
      .map(([k, formas]) => {
        const [data, ficha_id] = k.split('|')
        return { data, ficha_id, formas }
      })
      .filter(i => diasAtivos.includes(i.data))

    const { data, error } = await supabase.rpc('salvar_plano_semana', {
      p_empresa_id: profile.empresa_id,
      p_semana_inicio: semana,
      p_dias: diasAtivos,
      p_itens: itens,
      p_modo: preenchimento,
      p_ordem: ordem,
    })

    setSalvando(false)
    if (error || !(data as { ok?: boolean })?.ok) {
      setErro(error?.message ?? 'Não foi possível salvar o plano.')
      return
    }
    setSalvoEm(new Date().toISOString())
    setAjustado(true)
  }

  /** As formas de um dia no formato que as outras telas esperam. */
  const formasDoDia = (dia: string): Record<string, string> =>
    Object.fromEntries(
      fichas
        .map(f => [f.id, String(grade[chave(dia, f.id)] ?? 0)])
        .filter(([, v]) => v !== '0'),
    )

  if (loading) return <p className="text-sm text-gray-500">Carregando fichas…</p>

  const fimSemana = somarDias(semana, 6)

  return (
    <div className="space-y-5">
      <style>{printStyles}</style>

      {/* ── Semana ──────────────────────────────────────────── */}
      <Card>
        <CardBody className="flex items-center justify-between gap-3 py-3">
          <Button variant="ghost" size="sm" onClick={() => setSemana(s => somarDias(s, -7))}>
            ‹ Anterior
          </Button>
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-900 dark:text-unno-text">
              {diaCurto(semana).slice(4)} a {diaCurto(fimSemana).slice(4)}
            </p>
            <p className="text-xs text-gray-500 dark:text-unno-muted">
              {salvoEm ? 'plano salvo' : 'não salvo ainda'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSemana(s => somarDias(s, 7))}>
            Próxima ›
          </Button>
        </CardBody>
      </Card>

      {/* ── Meta da semana ──────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Meta da semana"
          subtitle={modo === 'unidades'
            ? 'Quantas unidades de cada produto na semana toda'
            : 'Quanto no total e como isso se reparte'}
        />
        <CardBody className="space-y-3">
          <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/[.04] rounded-lg">
            {([['unidades', 'Por produto'], ['percentual', 'Total e %']] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (key === modo) return
                  if (key === 'percentual') {
                    setTotalDigitado(totalUnidadesMeta > 0 ? String(totalUnidadesMeta) : '')
                    setPct(Object.fromEntries(fichas.map(f => {
                      const u = alvoEfetivo[f.id] ?? 0
                      const p = totalUnidadesMeta > 0 ? (100 * u) / totalUnidadesMeta : 0
                      return [f.id, p > 0 ? String(Math.round(p * 10) / 10) : '']
                    })))
                  } else {
                    setAlvo(Object.fromEntries(fichas.map(f => {
                      const u = alvoEfetivo[f.id] ?? 0
                      return [f.id, u > 0 ? String(u) : '']
                    })))
                  }
                  setModo(key)
                }}
                className={[
                  'flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  modo === key
                    ? 'bg-white dark:bg-unno-raised text-gray-900 dark:text-unno-text shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:text-unno-muted',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

          {modo === 'percentual' && (
            <div className="flex items-center gap-3">
              <p className="flex-1 text-sm font-medium text-gray-900 dark:text-unno-text">
                Produção total da semana
              </p>
              <input
                type="number" min={0} step={100} inputMode="numeric"
                value={totalDigitado}
                onChange={e => { setTotalDigitado(e.target.value); setAjustado(false) }}
                placeholder="0"
                className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right font-semibold
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
              <span className="text-xs text-gray-400 w-14">unidades</span>
            </div>
          )}

          {fichas.map(f => {
            const m = metas.find(x => x.ficha.id === f.id)
            const unidades = alvoEfetivo[f.id] ?? 0
            const part = totalUnidadesMeta > 0 ? (100 * unidades) / totalUnidadesMeta : 0
            return (
              <div key={f.id}>
                <div className="flex items-center gap-3">
                  <p className="flex-1 min-w-0 text-sm font-medium text-gray-900 dark:text-unno-text truncate">
                    {f.codigo} — {f.nome}
                  </p>
                  <input
                    type="number" min={0} step={modo === 'unidades' ? 60 : 0.5} inputMode="decimal"
                    value={modo === 'unidades' ? (alvo[f.id] ?? '') : (pct[f.id] ?? '')}
                    onChange={e => {
                      if (modo === 'unidades') setAlvo(s => ({ ...s, [f.id]: e.target.value }))
                      else setPct(s => ({ ...s, [f.id]: e.target.value }))
                      setAjustado(false)
                    }}
                    placeholder="0"
                    className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                               focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                               dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                  />
                  <span className="text-xs text-gray-400 w-14">
                    {modo === 'unidades' ? 'unidades' : '%'}
                  </span>
                </div>
                {unidades > 0 && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/[.06] overflow-hidden">
                      <div className="h-full bg-brand-500 rounded-full"
                           style={{ width: `${Math.min(part, 100)}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 dark:text-unno-muted tabular-nums whitespace-nowrap">
                      {m ? `${m.formas} formas · ${m.bateladas} bat · ` : ''}{fmt(part, 1)}%
                    </span>
                  </div>
                )}
                {unidades > 0 && !f.rendimento_fornada && (
                  <p className="text-xs text-red-600 mt-1">
                    Sem rendimento cadastrado — Configurações → Produção.
                  </p>
                )}
              </div>
            )
          })}

          {modo === 'percentual' && totalPct > 0 && Math.abs(totalPct - 100) > 0.05 && (
            <div className={`p-3 rounded-lg text-sm ${
              totalPct > 100
                ? 'bg-red-50 border border-red-200 text-red-700'
                : 'bg-amber-50 border border-amber-200 text-amber-800'
            }`}>
              Os percentuais somam <strong>{fmt(totalPct, 1)}%</strong>.
              {totalPct > 100 ? ' Passa de 100%.' : ` Faltam ${fmt(100 - totalPct, 1)}%.`}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Dias ────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Dias e distribuição"
          subtitle="Desmarque feriado ou dia de parada, e escolha como a meta vira dias."
          action={
            <Button
              variant="ghost" size="sm"
              disabled={!ajustado || preenchimento === 'manual'}
              onClick={() => { setAjustado(false); setGrade(distribuir()) }}
              title={preenchimento === 'manual'
                ? 'No modo manual o sistema não distribui'
                : ajustado ? 'Desfaz os ajustes manuais' : 'Já está distribuído automaticamente'}
            >
              Redistribuir
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {diasDaSemana.map(d => {
              const ativo = diasAtivos.includes(d)
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => alternarDia(d)}
                  className={[
                    'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                    ativo
                      ? 'bg-brand-50 border-brand-300 text-brand-700 dark:bg-brand-500/10 dark:border-brand-500/40 dark:text-brand-300'
                      : 'bg-white border-gray-200 text-gray-400 dark:bg-transparent dark:border-white/[.08]',
                  ].join(' ')}
                >
                  {diaCurto(d)}
                </button>
              )
            })}
          </div>

          {/* Como preencher — mesma ideia do toggle da meta */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted mb-1.5">
              Como preencher a semana
            </p>
            <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/[.04] rounded-lg">
              {([
                ['blocos', 'Um sabor por dia'],
                ['igual', 'Mix igual todo dia'],
                ['manual', 'Eu distribuo'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === preenchimento) return
                    setPreenchimento(key)
                    // Trocar de modo é pedir para recalcular; manual mantém o
                    // que está na tela para servir de ponto de partida.
                    setAjustado(key === 'manual')
                  }}
                  className={[
                    'flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors',
                    preenchimento === key
                      ? 'bg-white dark:bg-unno-raised text-gray-900 dark:text-unno-text shadow-sm'
                      : 'text-gray-500 hover:text-gray-700 dark:text-unno-muted',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1.5">
              {preenchimento === 'blocos'
                ? 'Enche cada dia com um sabor só; a lavagem acontece na troca.'
                : preenchimento === 'igual'
                  ? 'Todo dia produz os dois, na mesma proporção da meta.'
                  : 'O sistema não distribui — você preenche os dias como quiser.'}
            </p>
          </div>

          {/* Prioridade: só muda o resultado no modo blocos */}
          {preenchimento === 'blocos' && fichasOrdenadas.length > 1 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted mb-1.5">
                Ordem na semana
              </p>
              <div className="space-y-1">
                {fichasOrdenadas.map((f, i) => (
                  <div key={f.id} className="flex items-center gap-2">
                    <span className="w-5 text-xs text-gray-400 tabular-nums">{i + 1}º</span>
                    <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-unno-text truncate">
                      <span className="text-gray-400 mr-1.5">{f.codigo}</span>{f.nome}
                    </p>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => moverFicha(i, -1)}
                      className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-xs
                                 disabled:opacity-30 hover:bg-gray-50 dark:border-white/[.08]"
                      title="Subir"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === fichasOrdenadas.length - 1}
                      onClick={() => moverFicha(i, 1)}
                      className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-xs
                                 disabled:opacity-30 hover:bg-gray-50 dark:border-white/[.08]"
                      title="Descer"
                    >
                      ↓
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-unno-muted mt-1.5">
                Quem está em cima ocupa os primeiros dias da semana.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Quanto falta distribuir ─────────────────────────── */}
      {mostrarSaldo && balanco.length > 0 && (
        <Card>
          <CardBody className="py-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
              Falta distribuir
            </p>
            {balanco.map(b => (
              <div key={b.ficha.id} className="flex items-center gap-3">
                <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-unno-text truncate">
                  <span className="text-gray-400 mr-1.5">{b.ficha.codigo}</span>{b.ficha.nome}
                </p>
                <div className="w-32 h-1.5 rounded-full bg-gray-100 dark:bg-white/[.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${b.falta < 0 ? 'bg-red-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.min(100, (b.distribuido / (b.meta || 1)) * 100)}%` }}
                  />
                </div>
                <span className={`text-xs tabular-nums whitespace-nowrap w-40 text-right ${
                  b.falta === 0 ? 'text-emerald-700'
                    : b.falta < 0 ? 'text-red-600'
                    : 'text-gray-500 dark:text-unno-muted'
                }`}>
                  {b.distribuido} de {b.meta} formas
                  {b.falta === 0
                    ? ' · completo'
                    : b.falta > 0 ? ` · faltam ${b.falta}`
                    : ` · ${-b.falta} a mais`}
                </span>
              </div>
            ))}
            {!faltaDistribuir && (
              <p className="text-xs text-emerald-700">
                A semana toda está distribuída.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── A semana repartida ──────────────────────────────── */}
      {porDia.length > 0 && (
        <div className="space-y-3">
          {porDia.map(d => (
            <Card key={d.dia}>
              <CardBody className="space-y-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="font-semibold text-gray-900 dark:text-unno-text capitalize">
                    {diaCurto(d.dia)}
                    {d.emAndamento && (
                      <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                        em andamento
                      </span>
                    )}
                    {d.foraDoPlano && (
                      <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                        produção fora do plano
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-unno-muted tabular-nums">
                    {d.formas} formas · {Math.ceil(d.formas / FORMAS_POR_BATELADA)} bateladas ·{' '}
                    {fmt(d.unidades)} un
                  </p>
                </div>

                {fichasOrdenadas.map(f => {
                  const v = grade[chave(d.dia, f.id)] ?? 0
                  const r = realizado[chave(d.dia, f.id)]
                  // No modo manual todas as linhas ficam abertas: você está
                  // distribuindo, e sumir com a linha ao digitar na vizinha é
                  // exatamente o atrito que se quer evitar.
                  // Nos modos automáticos esconde quem não produz, e o botão
                  // "+ produto" abaixo traz de volta.
                  if (preenchimento !== 'manual' && v === 0 && r?.formas == null
                      && d.itens.length > 0 && !abertos.includes(chave(d.dia, f.id))) return null
                  return (
                    <div key={f.id}>
                      <div className="flex items-center gap-3">
                        <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-unno-text truncate">
                          <span className="text-gray-400 mr-1.5">{f.codigo}</span>{f.nome}
                        </p>
                        <input
                          type="number" min={0} step={1} inputMode="numeric"
                          value={v || ''}
                          onChange={e => editarDia(d.dia, f.id, e.target.value)}
                          placeholder="0"
                          className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-right
                                     focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                                     dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                        />
                        {/* O saldo desce de segunda em diante: o que sobra da
                            meta depois de abater este dia e os anteriores. */}
                        {mostrarSaldo && (metas.find(m => m.ficha.id === f.id)?.formas ?? 0) > 0 ? (
                          <span className={`text-xs w-28 text-right tabular-nums ${
                            (saldos[chave(d.dia, f.id)]?.depois ?? 0) < 0 ? 'text-red-600'
                              : (saldos[chave(d.dia, f.id)]?.depois ?? 0) === 0 ? 'text-emerald-700'
                              : 'text-gray-400'
                          }`}>
                            {(saldos[chave(d.dia, f.id)]?.depois ?? 0) < 0
                              ? `${-(saldos[chave(d.dia, f.id)]?.depois ?? 0)} a mais`
                              : `restam ${saldos[chave(d.dia, f.id)]?.depois ?? 0}`}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 w-28 text-right">
                            {v > 0 ? `${fmt(v * (f.rendimento_fornada ?? 0))} un` : 'formas'}
                          </span>
                        )}
                      </div>

                      {/* O que a produção registrou naquele dia */}
                      {r?.formas != null && (
                        <p className={`text-xs mt-1 ml-0.5 ${
                          r.em_andamento ? 'text-blue-700'
                            : r.formas === v ? 'text-emerald-700'
                            : 'text-amber-700'
                        }`}>
                          Produzido: <strong>{r.formas} formas</strong>
                          {r.unidades != null && <> · {fmt(r.unidades)} un</>}
                          {r.em_andamento
                            ? ' · sessão ainda aberta'
                            : r.formas === v ? ' · igual ao plano'
                            : ` · ${r.formas > v ? '+' : ''}${r.formas - v} em relação ao plano`}
                        </p>
                      )}
                    </div>
                  )
                })}

                {/* Acrescentar um produto num dia que já tem outro. Sem isto o
                    usuário fica preso na distribuição que o sistema sugeriu. */}
                {(() => {
                  if (preenchimento === 'manual') return null   // já estão todas na tela
                  const faltando = fichasOrdenadas.filter(f =>
                    (grade[chave(d.dia, f.id)] ?? 0) === 0
                    && realizado[chave(d.dia, f.id)]?.formas == null
                    && !abertos.includes(chave(d.dia, f.id)))
                  if (faltando.length === 0) return null
                  return (
                    <div className="flex flex-wrap gap-1.5">
                      {faltando.map(f => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setAbertos(a => [...a, chave(d.dia, f.id)])}
                          className="px-2 py-1 rounded-lg border border-dashed border-gray-300 text-xs
                                     text-gray-500 hover:text-gray-700 hover:border-gray-400
                                     dark:border-white/[.12] dark:text-unno-muted"
                        >
                          + {f.codigo}
                        </button>
                      ))}
                    </div>
                  )
                })()}

                {/* Dia que não cabe nos recipientes: é estrutural, não depende
                    do estoque de hoje. */}
                {d.apertados.length > 0 && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    <p className="font-medium">Vai precisar de mais de uma rodada de abastecimento</p>
                    {d.apertados.map(a => (
                      <p key={a.nome} className="mt-0.5">
                        {a.nome}: o dia pede {fmt(a.qtd, 2)} {a.unidade} e os recipientes
                        comportam {fmt(a.cap, 2)} — {a.rodadas} rodadas.
                      </p>
                    ))}
                  </div>
                )}

                {d.itens.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {onVerAbastecimento && (
                      <Button size="sm" variant="secondary"
                              onClick={() => onVerAbastecimento(formasDoDia(d.dia))}>
                        Ver o que abastecer
                      </Button>
                    )}
                    <Button size="sm" variant="ghost"
                            onClick={() => navigate('/producao/abrir', { state: { formas: formasDoDia(d.dia) } })}>
                      Abrir sessão
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* O aviso de "não bate com a meta" virou o painel "Falta distribuir",
          acima dos dias — perto de onde se digita, e não no fim da página. */}

      {/* ── Planejado × realizado ───────────────────────────── */}
      {temRealizado && (
        <Card>
          <CardHeader
            title="Planejado × realizado"
            subtitle="O que as sessões de produção registraram nesta semana"
          />
          <CardBody className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 dark:text-unno-muted border-b border-gray-200 dark:border-white/[.06]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Produto</th>
                  <th className="text-right px-3 py-2 font-medium">Planejado</th>
                  <th className="text-right px-3 py-2 font-medium">Produzido</th>
                  <th className="text-right px-4 py-2 font-medium">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {fichas.map(f => {
                  const plan = diasDaSemana.reduce((s, d) => s + (grade[chave(d, f.id)] ?? 0), 0)
                  const real = diasDaSemana.reduce(
                    (s, d) => s + (realizado[chave(d, f.id)]?.formas ?? 0), 0)
                  const aberta = diasDaSemana.some(d => realizado[chave(d, f.id)]?.em_andamento)
                  if (plan === 0 && real === 0) return null
                  const dif = real - plan
                  return (
                    <tr key={f.id} className="border-b border-gray-100 dark:border-white/[.04] last:border-0">
                      <td className="px-4 py-2">
                        <span className="text-gray-400 text-xs mr-1.5">{f.codigo}</span>
                        <span className="text-gray-900 dark:text-unno-text">{f.nome}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted">
                        {plan} formas
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-900 dark:text-unno-text">
                        {real} formas
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${
                        dif === 0 ? 'text-emerald-700' : dif > 0 ? 'text-blue-700' : 'text-amber-700'
                      }`}>
                        {dif === 0 ? 'em dia' : `${dif > 0 ? '+' : ''}${dif}`}
                        {aberta && (
                          <span className="block text-xs font-normal text-gray-400">
                            há sessão aberta
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {totalFormas > 0 && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600 dark:text-unno-muted">
              Semana: <strong className="text-gray-900 dark:text-unno-text">{totalFormas} formas</strong>
              {' '}· {Math.ceil(totalFormas / FORMAS_POR_BATELADA)} bateladas ·{' '}
              {fmt(totalUnidades)} unidades
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                Imprimir
              </Button>
              <Button size="sm" loading={salvando} onClick={salvar}>
                Salvar plano
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {erro && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{erro}</div>
      )}

      {/* ── Folha A4 ────────────────────────────────────────── */}
      <div className="semana-print-target">
        <div style={{ marginBottom: '10px' }}>
          <h1 style={{ fontSize: '15pt', fontWeight: 700, margin: 0 }}>Plano de Produção da Semana</h1>
          <p className="small" style={{ margin: '3px 0 0' }}>
            {empresaNome && <>{empresaNome} · </>}
            {diaCurto(semana).slice(4)} a {diaCurto(fimSemana).slice(4)} ·{' '}
            {totalFormas} formas · {fmt(totalUnidades)} unidades
          </p>
        </div>

        <table>
          {/* A coluna de produzido só existe quando há o que comparar; as
              larguras acompanham, senão a tabela estoura a folha. */}
          <colgroup>
            <col style={{ width: temRealizado ? '14%' : '16%' }} />
            <col style={{ width: temRealizado ? '32%' : '38%' }} />
            <col style={{ width: temRealizado ? '13%' : '15%' }} />
            <col style={{ width: temRealizado ? '13%' : '15%' }} />
            <col style={{ width: temRealizado ? '14%' : '16%' }} />
            {temRealizado && <col style={{ width: '14%' }} />}
          </colgroup>
          <thead>
            <tr>
              <th>Dia</th>
              <th>Produto</th>
              <th className="num">Formas</th>
              <th className="num">Bateladas</th>
              <th className="num">Unidades</th>
              {temRealizado && <th className="num">Produzido</th>}
            </tr>
          </thead>
          <tbody>
            {porDia.map(d => (
              d.itens.map((it, idx) => (
                <tr key={`${d.dia}-${it.ficha.id}`} className={idx === 0 ? 'dia' : ''}>
                  <td>{idx === 0 ? diaCurto(d.dia) : ''}</td>
                  <td><span className="mono">{it.ficha.codigo}</span> {it.ficha.nome}</td>
                  <td className="num">{it.formas}</td>
                  <td className="num">{Math.ceil(it.formas / FORMAS_POR_BATELADA)}</td>
                  <td className="num">{fmt(it.formas * (it.ficha.rendimento_fornada ?? 0))}</td>
                  {temRealizado && (
                    <td className="num">
                      {it.real?.formas != null ? `${it.real.formas} f` : '—'}
                    </td>
                  )}
                </tr>
              ))
            ))}
            <tr className="dia">
              <td colSpan={2}><strong>Total da semana</strong></td>
              <td className="num"><strong>{totalFormas}</strong></td>
              <td className="num">{Math.ceil(totalFormas / FORMAS_POR_BATELADA)}</td>
              <td className="num"><strong>{fmt(totalUnidades)}</strong></td>
              {temRealizado && (
                <td className="num">
                  <strong>{porDia.reduce((s, d) => s + d.formasReais, 0)} f</strong>
                </td>
              )}
            </tr>
          </tbody>
        </table>

        <p className="small" style={{ marginTop: '10px' }}>
          Um produto por dia sempre que a divisão permite — o dia com dois produtos
          é onde os utensílios precisam ser lavados no meio.
        </p>

        <div style={{ marginTop: '22px', fontSize: '9pt' }}>
          <p className="caixa">Conferido por: ______________________________</p>
        </div>
      </div>
    </div>
  )
}

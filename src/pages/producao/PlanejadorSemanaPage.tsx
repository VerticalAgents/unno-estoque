import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { semanaDeTrabalho } from '../../lib/utils'
import { CampoNumerico } from '../../components/ui/CampoNumerico'

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

/**
 * Cor de uma barra de progresso, contínua de 0 a 100%.
 *
 * A barra da última batelada usa quatro cores fixas, e ali está certo: só
 * existem quatro valores possíveis (1 a 4 formas). Aqui o valor é contínuo, e
 * quatro degraus dariam saltos onde a informação é gradual — 49% e 51%
 * pareceriam mundos diferentes.
 *
 * As cores de ancoragem são as MESMAS da barra de bateladas, para as duas
 * parecerem da mesma família. A interpolação é em RGB: para este trajeto
 * (vermelho → âmbar → verde-limão → verde) ela passa longe do cinza, que é o
 * risco de misturar cor nesse espaço.
 */
const ESCALA_PROGRESSO: { p: number; rgb: [number, number, number] }[] = [
  { p: 0,    rgb: [239,  68,  68] }, // red-500
  { p: 0.34, rgb: [245, 166,  35] }, // unno.amber
  { p: 0.67, rgb: [140, 191,  63] }, // unno.lime
  { p: 1,    rgb: [ 23, 168,  96] }, // brand-500
]

function corProgresso(fracao: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fracao) ? fracao : 0))
  let a = ESCALA_PROGRESSO[0]
  let b = ESCALA_PROGRESSO[ESCALA_PROGRESSO.length - 1]
  for (let i = 0; i < ESCALA_PROGRESSO.length - 1; i++) {
    if (f >= ESCALA_PROGRESSO[i].p && f <= ESCALA_PROGRESSO[i + 1].p) {
      a = ESCALA_PROGRESSO[i]
      b = ESCALA_PROGRESSO[i + 1]
      break
    }
  }
  const t = b.p === a.p ? 0 : (f - a.p) / (b.p - a.p)
  const [r, g, bl] = a.rgb.map((v, i) => Math.round(v + (b.rgb[i] - v) * t))
  return `rgb(${r}, ${g}, ${bl})`
}

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

// ── Aviso de abastecimento ───────────────────────────────────

type ModoEp = 'recipiente' | 'embalagem_fornecedor' | 'porcionado' | 'escolher'

type Armazenamento = {
  modo: ModoEp
  /** Tamanho da porção, já na unidade do insumo (o cadastro guarda em g/ml). */
  porcao: number | null
  /** Tamanho da embalagem do fornecedor, na unidade do insumo. */
  embalagem: number | null
}

type Aviso = { nome: string; titulo: string; detalhe: string }

/**
 * "Vai precisar de mais de uma rodada de abastecimento" só faz sentido para um
 * dos modos, e a tela dizia isso para todos.
 *
 * A ideia de RODADA pressupõe um conjunto fixo de potes por onde tudo passa: o
 * pote enche, esvazia e alguém reabastece. Isso é verdade no modo `recipiente`.
 *
 * Não é verdade para a embalagem do fornecedor — ali não há reabastecer, há
 * levar mais um balde da prateleira, e o limite não é a capacidade dos potes e
 * sim quantos pacotes existem no estoque. Nem para o porcionado, onde a unidade
 * que se conta é o SACO, não a caixa.
 *
 * E para quem decide na hora (o doce de leite) a resposta depende de uma
 * escolha que ainda não foi feita quando se planeja a semana — então a tela
 * mostra as duas, em vez de fingir que sabe.
 */
function avisoDeAbastecimento(
  qtd: number,
  cap: { nome: string; unidade: string; capacidade: number } | undefined,
  arm: Armazenamento | undefined,
): Aviso | null {
  if (!cap) return null
  const modo = arm?.modo ?? 'recipiente'
  const un = cap.unidade

  const emSacos = () => {
    if (!arm?.porcao || arm.porcao <= 0) return null
    const sacos = Math.ceil(qtd / arm.porcao)
    const porCaixa = cap.capacidade > 0 ? Math.floor(cap.capacidade / arm.porcao) : 0
    const enchimentos = porCaixa > 0 ? Math.ceil(sacos / porCaixa) : 0
    return { sacos, porCaixa, enchimentos }
  }

  const emPacotes = () => {
    const tam = arm?.embalagem && arm.embalagem > 0 ? arm.embalagem : cap.capacidade
    if (!tam || tam <= 0) return null
    return { pacotes: Math.ceil(qtd / tam), tam }
  }

  if (modo === 'embalagem_fornecedor') {
    const p = emPacotes()
    if (!p || p.pacotes <= 1) return null
    return {
      nome: cap.nome,
      titulo: 'Vai precisar de mais de um pacote',
      detalhe: `${cap.nome}: o dia pede ${fmt(qtd, 2)} ${un} = ${p.pacotes} pacotes `
             + `de ${fmt(p.tam, 2)} ${un}. Confira se há esse tanto no estoque central.`,
    }
  }

  if (modo === 'porcionado') {
    const s = emSacos()
    if (!s || s.enchimentos <= 1) return null
    return {
      nome: cap.nome,
      titulo: 'A caixa não comporta o dia inteiro',
      detalhe: `${cap.nome}: o dia pede ${fmt(qtd, 2)} ${un} = ${s.sacos} sacos, `
             + `e na caixa cabem ${s.porCaixa} — ${s.enchimentos} enchimentos.`,
    }
  }

  if (modo === 'escolher') {
    const s = emSacos()
    const p = emPacotes()
    const partes: string[] = []
    if (p && p.pacotes > 1) partes.push(`direto, ${p.pacotes} pacotes de ${fmt(p.tam, 2)} ${un}`)
    if (s && s.enchimentos > 1) partes.push(`porcionado, ${s.sacos} sacos = ${s.enchimentos} enchimentos da caixa`)
    if (partes.length === 0) return null
    return {
      nome: cap.nome,
      titulo: 'Depende do destino escolhido',
      detalhe: `${cap.nome}: o dia pede ${fmt(qtd, 2)} ${un} — ${partes.join('; ')}.`,
    }
  }

  if (cap.capacidade <= 0) return null
  const rodadas = Math.ceil(qtd / cap.capacidade)
  if (rodadas <= 1) return null
  return {
    nome: cap.nome,
    titulo: 'Vai precisar de mais de uma rodada de abastecimento',
    detalhe: `${cap.nome}: o dia pede ${fmt(qtd, 2)} ${un} e os recipientes `
           + `comportam ${fmt(cap.capacidade, 2)} — ${rodadas} rodadas.`,
  }
}

function fmt(n: number, casas = 0) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

/**
 * Quantas formas caem na última batelada.
 *
 * Batelada cheia é 4 formas. Uma última batelada de 3 significa menos massa no
 * forno, e menos massa assa mais rápido — o forno precisa ser reprogramado só
 * para ela. Por isso o número aparece na tela: dá para mexer na meta em ±60
 * unidades e fechar redondo antes de a produção começar.
 */
/**
 * Arredonda a meta para o múltiplo de `rendimento` mais próximo.
 *
 * Meia forma não existe: ou a fornada entra no forno, ou não entra. Digitar
 * 6.230 unidades com 60 por forma daria 103,83 formas, que na prática vira 104
 * — e aí a meta na tela mente sobre o que vai ser produzido. Melhor a tela
 * ajustar o número do que carregar uma meta impossível.
 */
function snapUnidades(unidades: number, rendimento: number): number {
  if (rendimento <= 0) return Math.max(0, Math.round(unidades))
  return Math.max(0, Math.round(unidades / rendimento)) * rendimento
}

function formasNaUltimaBatelada(formas: number): number {
  if (formas <= 0) return 0
  const resto = formas % FORMAS_POR_BATELADA
  return resto === 0 ? FORMAS_POR_BATELADA : resto
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
  semanaInicial,
}: {
  /** Leva as formas de um dia para a aba "Dia". */
  onVerAbastecimento?: (formas: Record<string, string>) => void
  /** Semana escolhida na aba Mês. O contador permite reescolher a mesma. */
  semanaInicial?: { iso: string; n: number }
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

  /**
   * Quando ligado, a meta encaixa em bateladas cheias em vez de formas soltas:
   * o passo vira 4 formas e a última batelada nunca sai pela metade. Custa
   * flexibilidade na meta e ganha um forno que não precisa ser reprogramado.
   */
  const [fecharBateladas, setFecharBateladas] = useState(false)

  // Meta da semana — mesmo desenho da tela de Reabastecimento
  const [modo, setModo] = useState<'unidades' | 'percentual'>('unidades')
  const [alvo, setAlvo] = useState<Record<string, string>>({})
  const [totalDigitado, setTotalDigitado] = useState('')
  const [pct, setPct] = useState<Record<string, string>>({})

  // Capacidade dos recipientes e receitas: buscadas uma vez, usadas em toda
  // edição sem ida ao banco
  const [capacidade, setCapacidade] = useState<Record<string, { nome: string; unidade: string; capacidade: number }>>({})
  const [armazenamento, setArmazenamento] = useState<Record<string, Armazenamento>>({})
  const [receitas, setReceitas] = useState<Record<string, { insumo_id: string; quantidade: number }[]>>({})

  const [realizado, setRealizado] = useState<Record<string, Realizado>>({})

  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [salvoEm, setSalvoEm] = useState<string | null>(null)
  // Retrato do plano como está no banco, para saber se há coisa por salvar.
  const [instantaneoSalvo, setInstantaneoSalvo] = useState('')
  const [empresaNome, setEmpresaNome] = useState('')

  // Alvo do botão "editar" da coluna fixa.
  const topoRef = useRef<HTMLDivElement>(null)

  const num = (s: string | undefined) => parseFloat((s ?? '').replace(',', '.')) || 0

  /** Quantas unidades valem um passo: uma forma, ou uma batelada inteira. */
  const passoDe = (rendimento: number) =>
    rendimento * (fecharBateladas ? FORMAS_POR_BATELADA : 1)

  const diasDaSemana = useMemo(
    () => Array.from({ length: 7 }, (_, i) => somarDias(semana, i)),
    [semana],
  )

  // Veio um clique do calendário do mês.
  useEffect(() => {
    if (semanaInicial) setSemana(semanaInicial.iso)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanaInicial?.n])

  // ── Carga inicial ───────────────────────────────────────────
  useEffect(() => {
    if (!profile) return

    async function carregar() {
      const [fichasRes, capRes, empRes, modoRes] = await Promise.all([
        supabase.from('fichas_tecnicas')
          .select('id, codigo, nome, versoes:fichas_tecnicas_versoes!inner(id, rendimento_fornada, ativa)')
          .eq('empresa_id', profile!.empresa_id)
          .eq('ativo', true).eq('tipo', 'produto').order('codigo'),
        supabase.from('v_recipientes_composicao')
          .select('insumo_id, insumo_nome, unidade_medida, capacidade_max')
          .eq('empresa_id', profile!.empresa_id),
        supabase.from('empresas').select('nome').eq('id', profile!.empresa_id).maybeSingle(),
        // Como cada insumo ocupa o EP: a conta de "quantas rodadas" só vale
        // para quem passa por pote da cozinha (ver ARMAZENAMENTO abaixo).
        supabase.from('insumos_armazenamento_config')
          .select('insumo_id, modo_ep, reembalagem_tamanho_porcao, insumo:insumos(unidade_medida, tamanho_embalagem)'),
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

      const modos: Record<string, Armazenamento> = {}
      for (const r of (modoRes.data ?? []) as unknown as {
        insumo_id: string; modo_ep: ModoEp; reembalagem_tamanho_porcao: number | null
        insumo?: { unidade_medida?: string; tamanho_embalagem?: number | null }
          | { unidade_medida?: string; tamanho_embalagem?: number | null }[]
      }[]) {
        const ins = Array.isArray(r.insumo) ? r.insumo[0] : r.insumo
        // A porção é cadastrada em g/ml e o insumo pode ser medido em kg/L.
        const divisor = ins?.unidade_medida === 'kg' || ins?.unidade_medida === 'L' ? 1000 : 1
        modos[r.insumo_id] = {
          modo: r.modo_ep ?? 'recipiente',
          porcao: r.reembalagem_tamanho_porcao ? Number(r.reembalagem_tamanho_porcao) / divisor : null,
          embalagem: ins?.tamanho_embalagem ? Number(ins.tamanho_embalagem) : null,
        }
      }
      setArmazenamento(modos)

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
      setInstantaneoSalvo('')
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
    const diasSalvos = (p.dias_ativos ?? []).map(d => String(d).slice(0, 10))
    setDiasAtivos(diasSalvos)
    setPreenchimento(p.modo_preenchimento ?? 'blocos')
    // Ficha que não estava na ordem salva entra no fim, na ordem do código.
    const ordemSalva = [
      ...(p.ordem_fichas ?? []).filter(id => fichas.some(f => f.id === id)),
      ...fichas.map(f => f.id).filter(id => !(p.ordem_fichas ?? []).includes(id)),
    ]
    setOrdem(ordemSalva)
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

    // O retrato do banco é montado com os mesmos dados que acabaram de entrar
    // no estado — não dá para ler `instantaneo` aqui, que ainda é do plano
    // anterior nesta passagem.
    setInstantaneoSalvo(JSON.stringify({
      grade: Object.entries(g)
        .filter(([k, v]) => v > 0 && diasSalvos.includes(k.split('|')[0]))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      dias: [...diasSalvos].sort(),
      preenchimento: p.modo_preenchimento ?? 'blocos',
      ordem: ordemSalva,
    }))
  }, [profile, semana, fichas])

  useEffect(() => { carregarSemana() }, [carregarSemana])

  // ── Meta ────────────────────────────────────────────────────
  const alvoEfetivo = useMemo<Record<string, number>>(() => {
    if (modo === 'unidades') {
      return Object.fromEntries(fichas.map(f => [f.id, num(alvo[f.id])]))
    }
    // Também no percentual a fatia fecha formas inteiras, senão a divisão por
    // porcentagem reintroduziria a meia forma pela porta dos fundos.
    const total = num(totalDigitado)
    return Object.fromEntries(fichas.map(f => [
      f.id,
      snapUnidades(total * num(pct[f.id]) / 100, passoDe(f.rendimento_fornada ?? 0)),
    ]))
  }, [modo, fichas, alvo, totalDigitado, pct, fecharBateladas])

  /**
   * Passo do campo de produção total: uma forma, quando todos os produtos
   * rendem igual. Rendimentos diferentes não têm passo comum — aí usa o menor,
   * que é o que garante formas inteiras para todo mundo.
   */
  const passoTotal = useMemo(() => {
    const rends = fichas.map(f => f.rendimento_fornada ?? 0).filter(r => r > 0)
    if (rends.length === 0) return 1
    return rends.every(r => r === rends[0]) ? rends[0] : Math.min(...rends)
  }, [fichas])

  const passoTotalEfetivo = passoTotal * (fecharBateladas ? FORMAS_POR_BATELADA : 1)

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

  /** Os produtos que entram na semana, na ordem de prioridade. */
  const ordemVisivel = metas.map(m => m.ficha)

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

  /**
   * Uma forma para cima ou para baixo.
   *
   * Lê o valor de dentro do próprio setState porque isto roda em repetição
   * quando o botão fica pressionado — ler `alvo` de fora congelaria o número
   * no valor de quando o dedo desceu.
   */
  function passoFormas(f: FichaOption, delta: -1 | 1) {
    const passo = passoDe(f.rendimento_fornada ?? 0)
    if (passo <= 0) return
    setAlvo(s => {
      const atual = parseFloat((s[f.id] ?? '').replace(',', '.')) || 0
      const n = Math.max(0, Math.round(atual / passo) + delta)
      return { ...s, [f.id]: n > 0 ? String(n * passo) : '' }
    })
    setAjustado(false)
  }

  /**
   * Ao sair do campo, encaixa o número digitado em formas inteiras.
   *
   * O ajuste acontece só na saída, e não a cada tecla — corrigir enquanto se
   * digita faria o campo brigar com o usuário no meio do número.
   */
  function encaixarFormas(f: FichaOption) {
    const passo = passoDe(f.rendimento_fornada ?? 0)
    const atual = num(alvo[f.id])
    if (passo <= 0 || atual <= 0) return
    const encaixado = snapUnidades(atual, passo)
    if (encaixado !== atual) {
      setAlvo(s => ({ ...s, [f.id]: String(encaixado) }))
      setAjustado(false)
    }
  }

  /**
   * Sobe ou desce um produto na prioridade da semana.
   *
   * Opera sobre a lista visível — só os produtos que têm meta. Ordenar quem
   * não vai ser produzido não muda nada e só ocupa a tela. Os demais voltam
   * ao fim da ordem gravada.
   */
  function moverFicha(indice: number, direcao: -1 | 1) {
    const ids = ordemVisivel.map(f => f.id)
    const destino = indice + direcao
    if (destino < 0 || destino >= ids.length) return
    ;[ids[indice], ids[destino]] = [ids[destino], ids[indice]]
    setOrdem([...ids, ...fichas.map(f => f.id).filter(id => !ids.includes(id))])
    setAjustado(false)   // ordem nova pede distribuição nova
  }

  /**
   * Esvazia a distribuição pelos dias — não o plano gravado.
   *
   * A meta continua onde está e o banco não é tocado: só depois de salvar é
   * que a semana some de verdade. Serve para redistribuir do zero à mão.
   */
  function zerarSemana() {
    setAjustado(true)
    setGrade({})
  }

  /** Tira toda a produção de um dia. Redistribuir a mão pede um ponto zero. */
  function zerarDia(dia: string) {
    setAjustado(true)
    setGrade(g => {
      const novo = { ...g }
      for (const f of fichas) delete novo[chave(dia, f.id)]
      return novo
    })
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
      // Batelada não mistura produtos: conta-se por ficha e soma. Dividir o
      // total do dia por 4 daria um número menor e falso quando há dois
      // produtos com resto — cada um tem a sua última batelada parcial.
      const bateladas = itens.reduce(
        (s, i) => s + Math.ceil(i.formas / FORMAS_POR_BATELADA), 0)
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
        .map(([insumoId, qtd]) => avisoDeAbastecimento(
          qtd, capacidade[insumoId], armazenamento[insumoId]))
        .filter(Boolean) as Aviso[]

      return { dia, itens, formas, bateladas, formasReais, emAndamento, foraDoPlano, unidades, apertados }
    })
  }, [diasAtivos, diasDaSemana, fichas, grade, receitas, capacidade, realizado])

  /**
   * Retrato do que seria gravado agora. Comparado com o do banco, diz se há
   * alteração pendente — inclui os dias marcados, o modo e a ordem, e não só
   * as formas: mudar de "uma ficha por dia" para "mix igual" também é mudança.
   */
  const instantaneo = useMemo(() => JSON.stringify({
    grade: Object.entries(grade)
      .filter(([k, v]) => v > 0 && diasAtivos.includes(k.split('|')[0]))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
    dias: [...diasAtivos].sort(),
    preenchimento,
    ordem,
  }), [grade, diasAtivos, preenchimento, ordem])

  const temAlteracao = instantaneo !== instantaneoSalvo

  const totalFormas = porDia.reduce((s, d) => s + d.formas, 0)
  const totalBateladas = porDia.reduce((s, d) => s + d.bateladas, 0)
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
    setInstantaneoSalvo(instantaneo)
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
    <div className="space-y-5" ref={topoRef}>
      <style>{printStyles}</style>

      {/* ── Página em duas colunas ─────────────────────────────
          A coluna da direita acompanha desde o topo, e não só a partir dos
          cards de dia: quem está mexendo na meta também quer ver o saldo e o
          botão de salvar. As três áreas são posicionadas explicitamente para
          que, no celular (uma coluna só), a ordem continue sendo configuração
          → acompanhamento → dias. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5 lg:col-start-1 lg:row-start-1">
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
              <p className={`text-xs ${temAlteracao && salvoEm
                ? 'text-amber-700'
                : 'text-gray-500 dark:text-unno-muted'}`}>
                {!salvoEm ? 'não salvo ainda'
                  : temAlteracao ? 'alterações não salvas'
                  : 'plano salvo'}
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

            {/* Tudo num grid só — total e produtos.
                Cada linha era um bloco independente, então nada compartilhava as
                mesmas colunas: as caixas de número acabavam em posições
                diferentes e as barras tinham comprimentos diferentes. Num grid
                único a coluna da direita é dimensionada pelo controle mais largo
                e todas as linhas terminam no mesmo lugar. */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
              {modo === 'percentual' && (
                <>
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                    Produção total da semana
                  </p>
                  <CampoNumerico
                    valor={totalDigitado}
                    onDigitar={v => { setTotalDigitado(v); setAjustado(false) }}
                    onPasso={d => {
                      setTotalDigitado(v => {
                        const atual = parseFloat((v ?? '').replace(',', '.')) || 0
                        const n = Math.max(0, Math.round(atual / passoTotalEfetivo) + d) * passoTotalEfetivo
                        return n > 0 ? String(n) : ''
                      })
                      setAjustado(false)
                    }}
                    passo={passoTotalEfetivo}
                    sufixo="unidades"
                  />
                  {/* separador entre o total e os produtos */}
                  <div className="col-span-2 h-px bg-gray-100 dark:bg-white/[.06] my-1" />
                </>
              )}

              {fichas.map(f => {
                const m = metas.find(x => x.ficha.id === f.id)
                const unidades = alvoEfetivo[f.id] ?? 0
                const part = totalUnidadesMeta > 0 ? (100 * unidades) / totalUnidadesMeta : 0
                const ultima = m ? formasNaUltimaBatelada(m.formas) : 0
                // Escada de quatro degraus: quanto menos massa sobra na última
                // batelada, mais o forno precisa ser reprogramado. Uma forma
                // sozinha é o pior caso.
                // O limão vai como valor direto e não pelo token do tema
                // (`unno.lime`): cor nova no tailwind.config só aparece depois de
                // reiniciar o servidor, e escrita assim funciona na hora.
                const cor = { 1: 'bg-red-500', 2: 'bg-unno-amber',
                              3: 'bg-[#8cbf3f]', 4: 'bg-brand-500' }[ultima] ?? 'bg-brand-500'
                const corTexto = { 1: 'text-red-600', 2: 'text-amber-700',
                                   3: 'text-lime-700',
                                   4: 'text-gray-500 dark:text-unno-muted' }[ultima]
                  ?? 'text-gray-500 dark:text-unno-muted'

                return (
                  <Fragment key={f.id}>
                    <p className="text-sm font-medium text-gray-900 dark:text-unno-text truncate">
                      {f.codigo} — {f.nome}
                    </p>

                    {modo === 'unidades' ? (
                      <CampoNumerico
                        valor={alvo[f.id] ?? ''}
                        onDigitar={v => { setAlvo(s => ({ ...s, [f.id]: v })); setAjustado(false) }}
                        onPasso={d => passoFormas(f, d)}
                        onSair={() => encaixarFormas(f)}
                        passo={passoDe(f.rendimento_fornada ?? 0) || 1}
                        sufixo="unidades"
                        desabilitado={!f.rendimento_fornada}
                      />
                    ) : (
                      <CampoNumerico
                        valor={pct[f.id] ?? ''}
                        onDigitar={v => { setPct(s => ({ ...s, [f.id]: v })); setAjustado(false) }}
                        onPasso={d => {
                          setPct(s => {
                            const atual = parseFloat((s[f.id] ?? '').replace(',', '.')) || 0
                            const n = Math.min(100, Math.max(0, Math.round(atual) + d))
                            return { ...s, [f.id]: n > 0 ? String(n) : '' }
                          })
                          setAjustado(false)
                        }}
                        passo={1}
                        max={100}
                        sufixo="%"
                      />
                    )}

                    {/* Participação na produção total */}
                    {unidades > 0 && (
                      <>
                        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-white/[.06] overflow-hidden">
                          <div className="h-full bg-brand-500 rounded-full"
                               style={{ width: `${Math.min(part, 100)}%` }} />
                        </div>
                        {/* No percentual quem foi digitado é o %, então o número
                            que falta ver é quantas unidades a fatia virou. */}
                        <span className="text-xs text-gray-500 dark:text-unno-muted tabular-nums whitespace-nowrap text-right">
                          {modo === 'percentual' && `${fmt(unidades)} un · `}
                          {m ? `${m.formas} formas · ${m.bateladas} bat` : ''}
                          {modo === 'unidades' && ` · ${fmt(part, 1)}%`}
                        </span>
                      </>
                    )}

                    {/* A última batelada, em quatro divisões */}
                    {m && m.formas > 0 && (
                      <>
                        <div className="flex gap-0.5">
                          {Array.from({ length: FORMAS_POR_BATELADA }, (_, i) => (
                            <div
                              key={i}
                              className={`h-1.5 flex-1 rounded-[2px] ${
                                i < ultima ? cor : 'bg-gray-100 dark:bg-white/[.06]'
                              }`}
                            />
                          ))}
                        </div>
                        <span className={`text-xs tabular-nums whitespace-nowrap text-right ${corTexto}`}>
                          última batelada: {ultima} de {FORMAS_POR_BATELADA} formas
                        </span>
                      </>
                    )}

                    {unidades > 0 && !f.rendimento_fornada && (
                      <p className="col-span-2 text-xs text-red-600">
                        Sem rendimento cadastrado — Configurações → Produção.
                      </p>
                    )}

                    {/* respiro entre produtos, sem quebrar as colunas */}
                    <div className="col-span-2 h-1" />
                  </Fragment>
                )
              })}
            </div>

            {/* Encaixar em bateladas cheias: o passo vira 4 formas e a última
                batelada nunca sai pela metade. Fica como escolha, e não como
                regra fixa — às vezes a meta importa mais que o forno. */}
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={fecharBateladas}
                onChange={e => {
                  setFecharBateladas(e.target.checked)
                  if (e.target.checked) {
                    // Encaixa o que já está digitado, senão a opção só valeria
                    // para os próximos números.
                    setAlvo(s => Object.fromEntries(fichas.map(f => {
                      const passo = (f.rendimento_fornada ?? 0) * FORMAS_POR_BATELADA
                      const atual = parseFloat((s[f.id] ?? '').replace(',', '.')) || 0
                      const n = passo > 0 ? snapUnidades(atual, passo) : atual
                      return [f.id, n > 0 ? String(n) : '']
                    })))
                  }
                  setAjustado(false)
                }}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-600
                           focus:ring-brand-500/30 dark:border-white/[.15]"
              />
              <span className="text-sm text-gray-700 dark:text-unno-text">
                Fechar bateladas cheias
                <span className="block text-xs text-gray-500 dark:text-unno-muted">
                  A meta anda de {FORMAS_POR_BATELADA} em {FORMAS_POR_BATELADA} formas
                  e a última batelada nunca sai pela metade — o forno não precisa
                  ser reprogramado no fim.
                </span>
              </span>
            </label>

            {/* O total acompanha a digitação. Antes só existia no rodapé da
                página, longe de onde os números são mexidos. */}
            {metas.length > 0 && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1
                              bg-gray-50 dark:bg-white/[.03] rounded-lg px-3 py-2">
                <span className="text-sm font-medium text-gray-900 dark:text-unno-text">
                  {fmt(totalUnidadesMeta)} unidades na semana
                </span>
                <span className="text-xs text-gray-600 dark:text-unno-muted tabular-nums">
                  {metas.reduce((s, m) => s + m.formas, 0)} formas ·{' '}
                  {metas.reduce((s, m) => s + m.bateladas, 0)} bateladas
                  {diasAtivos.length > 0 && (
                    <> · {fmt(
                      Math.round(metas.reduce((s, m) => s + m.formas, 0) / diasAtivos.length),
                    )} formas/dia em média</>
                  )}
                </span>
              </div>
            )}

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
                  ['blocos', 'Uma ficha por dia'],
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
                  ? 'Cada dia com uma ficha técnica só; a lavagem acontece na troca.'
                  : preenchimento === 'igual'
                    ? 'Todo dia produz os dois, na mesma proporção da meta.'
                    : 'O sistema não distribui — você preenche os dias como quiser.'}
              </p>
            </div>

            {/* Prioridade: só muda o resultado no modo blocos */}
            {preenchimento === 'blocos' && ordemVisivel.length > 1 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted mb-1.5">
                  Ordem na semana
                </p>
                <div className="space-y-1">
                  {ordemVisivel.map((f, i) => (
                    <div key={f.id} className="flex items-center gap-2">
                      <span className="w-5 text-xs text-gray-400 tabular-nums">{i + 1}º</span>
                      <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-unno-text truncate">
                        <span className="text-gray-400 mr-1.5">{f.codigo}</span>{f.nome}
                      </p>

                      {/* Com dois produtos, seta para baixo e seta para cima
                          são a mesma ação: trocar os dois. E como o botão
                          pertence à linha e não ao produto, clicar duas vezes
                          no mesmo lugar fazia e desfazia. Aí o certo é chamar
                          a ação pelo nome. */}
                      {ordemVisivel.length === 2 ? (
                        i === 0 && (
                          <button
                            type="button"
                            onClick={() => moverFicha(0, 1)}
                            className="px-2 py-1 rounded border border-gray-200 text-xs text-gray-600
                                       hover:bg-gray-50 dark:border-white/[.08] dark:text-unno-muted"
                          >
                            Inverter ordem
                          </button>
                        )
                      ) : (
                        <>
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
                            disabled={i === ordemVisivel.length - 1}
                            onClick={() => moverFicha(i, 1)}
                            className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-xs
                                       disabled:opacity-30 hover:bg-gray-50 dark:border-white/[.08]"
                            title="Descer"
                          >
                            ↓
                          </button>
                        </>
                      )}
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

        </div>

        {/* `self-start` é o que deixa a coluna grudar: sem ele o item de grid
            estica até o fim das duas linhas e não sobra folga para rolar. */}
        <aside className="space-y-3 self-start lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-4">
          {/* Resumo do que ficou lá em cima, para não precisar voltar */}
          {metas.length > 0 && (
            <Card>
              <CardBody className="py-3 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                    Meta da semana
                  </p>
                  <button
                    type="button"
                    // Quem rola é o <main> do Layout, não a janela — window.scrollTo
                    // não moveria nada aqui.
                    onClick={() => topoRef.current?.scrollIntoView({
                      behavior: 'smooth', block: 'start',
                    })}
                    className="text-xs text-brand-700 dark:text-brand-400 hover:underline"
                  >
                    editar
                  </button>
                </div>
                <p className="text-sm font-semibold text-gray-900 dark:text-unno-text">
                  {fmt(totalUnidadesMeta)} unidades
                </p>
                <p className="text-xs text-gray-500 dark:text-unno-muted tabular-nums">
                  {metas.reduce((s, m) => s + m.formas, 0)} formas ·{' '}
                  {metas.reduce((s, m) => s + m.bateladas, 0)} bateladas
                </p>
                <p className="text-xs text-gray-500 dark:text-unno-muted">
                  {diasAtivos.length} dia(s) ·{' '}
                  {preenchimento === 'blocos' ? 'uma ficha por dia'
                    : preenchimento === 'igual' ? 'mix igual todo dia'
                    : 'você distribui'}
                </p>
              </CardBody>
            </Card>
          )}

          {/* Falta distribuir */}
          {balanco.length > 0 && (
            <Card>
              <CardBody className="py-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                  Falta distribuir
                </p>
                {balanco.map(b => {
                  const fracao = b.distribuido / (b.meta || 1)
                  // Passar do alvo não é "mais progresso": é erro. Fica listrado
                  // para não se confundir com a barra cheia de quem acertou.
                  const excedeu = b.falta < 0
                  const cor = corProgresso(fracao)
                  return (
                  <div key={b.ficha.id} className="space-y-1">
                    <p className="text-sm text-gray-700 dark:text-unno-text truncate">
                      <span className="text-gray-400 mr-1.5">{b.ficha.codigo}</span>{b.ficha.nome}
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/[.06] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-[width,background-color] duration-200"
                          style={{
                            width: `${Math.min(100, fracao * 100)}%`,
                            backgroundColor: excedeu ? '#ef4444' : cor,
                            backgroundImage: excedeu
                              ? 'repeating-linear-gradient(45deg, rgba(255,255,255,.45) 0 3px, transparent 3px 6px)'
                              : undefined,
                          }}
                        />
                      </div>
                      <span
                        className="text-xs tabular-nums whitespace-nowrap"
                        style={{ color: excedeu ? '#dc2626' : cor }}
                      >
                        {b.falta === 0
                          ? 'completo'
                          : b.falta > 0 ? `faltam ${b.falta}`
                          : `${-b.falta} a mais`}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 tabular-nums">
                      {b.distribuido} de {b.meta} formas
                    </p>
                  </div>
                  )
                })}
                {!faltaDistribuir && (
                  <p className="text-xs text-emerald-700">
                    A semana toda está distribuída.
                  </p>
                )}

                {/* Fica aqui, ao lado do saldo: é olhando o quanto falta que se
                    decide refazer a divisão. No modo manual não aparece — ali o
                    sistema não distribui, por definição. */}
                {/* Os dois mexem só na distribuição pelos dias — a meta e o
                    plano salvo ficam onde estão. Nada aqui toca o banco. */}
                <div className="flex gap-2">
                  {preenchimento !== 'manual' && (
                    <Button
                      size="sm" variant="secondary"
                      className="flex-1 whitespace-normal leading-tight"
                      disabled={!ajustado}
                      onClick={() => { setAjustado(false); setGrade(distribuir()) }}
                      title={ajustado
                        ? 'Refaz a divisão pelos dias e descarta os ajustes manuais'
                        : 'A semana já está como o sistema distribuiu'}
                    >
                      Auto distribuir
                    </Button>
                  )}
                  <Button
                    size="sm" variant="ghost"
                    className="flex-1 whitespace-normal leading-tight"
                    disabled={totalFormas === 0}
                    onClick={zerarSemana}
                    title="Esvazia os dias da semana. O plano gravado só muda quando você salvar."
                  >
                    Zerar distribuição
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}

          {/* Salvar perto de onde se trabalha, e não no fim da página */}
          {totalFormas > 0 && (
            <Card>
              <CardBody className="py-3 space-y-2">
                <p className="text-xs text-gray-600 dark:text-unno-muted tabular-nums">
                  Distribuído: <strong className="text-gray-900 dark:text-unno-text">
                    {totalFormas} formas
                  </strong> · {totalBateladas} bateladas · {fmt(totalUnidades)} un
                </p>
                <Button
                  fullWidth size="sm"
                  loading={salvando}
                  disabled={!temAlteracao}
                  onClick={salvar}
                  title={temAlteracao ? '' : 'Não há nada por salvar'}
                >
                  {temAlteracao ? 'Salvar plano' : 'Salvo'}
                </Button>
                <Button fullWidth variant="secondary" size="sm" onClick={() => window.print()}>
                  Imprimir / PDF
                </Button>
                {temAlteracao && salvoEm && (
                  <div className="text-center space-y-1">
                    <p className="text-xs text-amber-700">há alterações não salvas</p>
                    {/* Recarregar do banco é o descarte mais honesto: volta
                        exatamente o que está gravado, sem tentar desfazer
                        passo a passo o que foi mexido. */}
                    <button
                      type="button"
                      onClick={carregarSemana}
                      className="text-xs text-gray-500 underline hover:text-gray-700 dark:text-unno-muted"
                    >
                      Descartar alterações
                    </button>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </aside>

        <div className="space-y-3 lg:col-start-1 lg:row-start-2">
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
                    {d.formas} formas · {d.bateladas} bateladas ·{' '}
                    {fmt(d.unidades)} un
                  </p>
                </div>

                {fichasOrdenadas.map(f => {
                  const v = grade[chave(d.dia, f.id)] ?? 0
                  const r = realizado[chave(d.dia, f.id)]
                  // No modo manual todas as linhas ficam abertas: é você quem
                  // distribui, e sumir com a linha vizinha ao digitar é o
                  // atrito que se quer evitar.
                  //
                  // Nos modos automáticos a linha de quem não produz naquele
                  // dia fica escondida — e não há como acrescentar à mão. O
                  // modo é uma promessa sobre o formato da semana; quem quiser
                  // dois produtos num dia troca para "Eu distribuo".
                  if (preenchimento !== 'manual' && v === 0 && r?.formas == null
                      && d.itens.length > 0) return null
                  return (
                    <div key={f.id}>
                      <div className="flex items-center gap-3">
                        <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-unno-text truncate">
                          <span className="text-gray-400 mr-1.5">{f.codigo}</span>{f.nome}
                        </p>
                        {/* Aqui o campo é em FORMAS, não em unidades: o passo
                            é uma forma, ou uma batelada com a opção ligada. */}
                        <CampoNumerico
                          valor={v ? String(v) : ''}
                          onDigitar={valor => editarDia(d.dia, f.id, valor)}
                          onPasso={delta => {
                            const passo = fecharBateladas ? FORMAS_POR_BATELADA : 1
                            const atual = grade[chave(d.dia, f.id)] ?? 0
                            editarDia(d.dia, f.id,
                              String(Math.max(0, Math.round(atual / passo) + delta) * passo))
                          }}
                          passo={fecharBateladas ? FORMAS_POR_BATELADA : 1}
                          largura="w-20"
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

                {/* Dia que não cabe nos recipientes: é estrutural, não depende
                    do estoque de hoje. */}
                {d.apertados.length > 0 && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 space-y-2">
                    {/* Um bloco por insumo: o título muda com o modo de
                        armazenamento, porque "rodada" não quer dizer a mesma
                        coisa para um pote e para um balde do fornecedor. */}
                    {d.apertados.map(a => (
                      <div key={a.nome}>
                        <p className="font-medium">{a.titulo}</p>
                        <p className="mt-0.5">{a.detalhe}</p>
                      </div>
                    ))}
                  </div>
                )}

                {d.itens.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {onVerAbastecimento && (
                      <Button size="sm" variant="secondary"
                              onClick={() => onVerAbastecimento(formasDoDia(d.dia))}>
                        Planejar recipientes
                      </Button>
                    )}
                    <Button size="sm" variant="ghost"
                            onClick={() => navigate('/producao/abrir', { state: { formas: formasDoDia(d.dia) } })}>
                      Abrir sessão
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => zerarDia(d.dia)}>
                      Zerar dia
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      </div>
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

      {/* Salvar e imprimir moraram aqui; foram para a coluna fixa. */}

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
              <td className="num">{totalBateladas}</td>
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

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'

/**
 * Planejador de Recipientes — substitui a planilha "Planejador de Recipientes
 * por Produção".
 *
 * Você informa quantas formas de cada ficha entram na sessão e a tela diz
 * quantos potes/baldes precisam estar CHEIOS antes de a produção começar,
 * para não haver parada no meio para reabastecer.
 *
 * O cálculo mora na RPC `planejar_recipientes` (migration 029). O ponto que
 * mais se erra: a demanda é somada entre as fichas antes de dividir pela
 * capacidade, porque os recipientes são um pool único — o açúcar do
 * Tradicional e o do Doce de Leite vão nos mesmos potes.
 */

const FORMAS_POR_BATELADA = 4

interface FichaOption {
  id: string
  codigo: string
  nome: string
  rendimento_fornada: number | null
}

/**
 * Quais lotes levar — RPC sugerir_lotes_transferencia (migration 040).
 * Esgota o lote já aberto antes de qualquer outro; depois lotes inteiros em
 * ordem FEFO; só o último é aberto parcialmente. Garante no máximo um lote
 * aberto por insumo no estoque central.
 */
interface LoteSugerido {
  insumo_id: string
  insumo_codigo: string
  insumo_nome: string
  unidade: string
  alvo: number
  // Nulos quando o insumo precisa ser abastecido mas não há lote no estoque
  // central — o caso que mais importa aparecer.
  lote_id: string | null
  lote_codigo: string | null
  validade: string | null
  dias_para_vencer: number | null
  saldo_do_lote: number | null
  ja_estava_aberto: boolean | null
  levar: number | null
  volta_aberto: number | null
}

/**
 * Em quais recipientes colocar — RPC planejar_abastecimento (migration 040).
 *
 * Só vem insumo cujos recipientes NÃO cobrem a produção planejada. Quando vem,
 * o alvo é encher até a capacidade, não até a demanda: o excedente é legítimo
 * porque veio de lote que já foi aberto. Daí as colunas separadas.
 *
 * Os campos de insumo se repetem em cada linha de recipiente (é uma tabela
 * plana vinda do banco); a tela agrupa.
 */
interface LinhaAbastecimento {
  insumo_id: string
  insumo_codigo: string
  insumo_nome: string
  unidade: string
  demanda: number
  conteudo_atual: number
  capacidade_total: number
  alvo: number
  para_producao: number
  excedente: number
  saldo_apos_abastecer: number
  sobra_apos_producao: number
  ordem: number
  local_id: string
  local_nome: string
  qr_code_fixo: string | null
  ja_tem: number
  capacidade: number | null
  colocar: number
}

interface LinhaPlano {
  insumo_id: string
  codigo: string
  nome: string
  unidade: string
  recipiente_modelo: string | null
  capacidade: number | null
  demanda: number
  demanda_com_folga: number
  recipientes_atuais: number
  recipientes_necessarios: number | null
  faltam: number | null
}

function fmt(n: number, casas = 3) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

/**
 * CSS de impressão, mesmo padrão de ImpressaoLotesPage: esconde a tela toda e
 * mostra só o alvo de impressão. Em A4 retrato, sempre em claro — a folha é
 * branca, independentemente do tema em uso.
 */
const printStyles = `
  .planejador-print-target { display: none; }

  @page { size: A4 portrait; margin: 14mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }

    body > * { visibility: hidden; }

    .planejador-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0; left: 0; right: 0;
      color: #111;
      font-size: 11pt;
    }
    .planejador-print-target * { visibility: visible !important; color: #111 !important; }
    .planejador-print-target table { width: 100%; border-collapse: collapse; }
    .planejador-print-target th, .planejador-print-target td {
      border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left;
    }
    .planejador-print-target th { border-bottom: 1.5px solid #333; font-size: 9pt; text-transform: uppercase; }
    .planejador-print-target .num { text-align: right; font-variant-numeric: tabular-nums; }
    .planejador-print-target thead { display: table-header-group; }  /* repete o cabeçalho a cada página */
    .planejador-print-target tr { page-break-inside: avoid; }

    /* Cada insumo é um <tbody>, e o bloco inteiro anda junto: se não couber no
       que resta da página, começa na próxima. Antes o "avoid" estava só no
       <tr>, então o bloco partia entre ENCHER e PEGAR NO ESTOQUE — as duas
       metades da mesma tarefa em páginas diferentes. Sobrar espaço no pé da
       folha é mais barato que ler metade da tarefa e virar a página. */
    .planejador-print-target tbody {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* Números nunca quebram linha — foi o que embolou a primeira versão */
    .planejador-print-target .num { white-space: nowrap; }
    .planejador-print-target .mono { font-family: 'Courier New', monospace; font-size: 8.5pt; }
    .planejador-print-target .small { font-size: 8pt; color: #666 !important; }
    .planejador-print-target .caixa { letter-spacing: 2px; }

    /* Cabeçalho do bloco: o insumo, em negrito, sem borda até o fim do bloco */
    .planejador-print-target .linha-insumo td {
      border-bottom: none;
      padding-top: 9px;
      font-weight: 700;
    }
    /* Nota da conta (produção + excedente), em itálico miúdo */
    .planejador-print-target .linha-nota td {
      border-bottom: none;
      padding: 0 6px 2px;
      font-size: 8pt;
      font-style: italic;
      color: #666 !important;
    }
    /* "Encher" / "Pegar no estoque" — separa as duas tarefas do operador */
    .planejador-print-target .linha-grupo td {
      border-bottom: none;
      padding: 3px 6px 1px;
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #888 !important;
    }
    .planejador-print-target .linha-item td {
      border-bottom: none;
      padding-top: 1px; padding-bottom: 1px;
      font-size: 9pt;
    }
    /* a última linha de cada bloco fecha com o divisor */
    .planejador-print-target tbody tr:last-child td { border-bottom: 1px solid #ccc; }

    /* insumo e cabeçalhos de grupo não ficam órfãos no fim da página */
    .planejador-print-target .linha-insumo,
    .planejador-print-target .linha-nota,
    .planejador-print-target .linha-grupo { page-break-after: avoid; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

/**
 * Vive dentro do PlanejadorPage, como a aba "Dia". A aba "Semana" manda para
 * cá as formas de um dia — daí `formasIniciais` chegar por prop em vez de por
 * navegação: as duas abas são a mesma página.
 */
export function PlanejadorRecipientesPage({
  formasIniciais,
}: { formasIniciais?: Record<string, string> } = {}) {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [formas, setFormas] = useState<Record<string, string>>(formasIniciais ?? {})

  // Veio de um dia da semana: substitui o que estava digitado. O objeto é
  // recriado a cada clique lá, então a identidade serve de gatilho.
  //
  // Aqui o cálculo sai sozinho: quem clicou em "planejar recipientes" já pediu
  // o resultado, e obrigar a clicar de novo seria pedir duas vezes a mesma
  // coisa. Digitar à mão continua exigindo o botão.
  const [gerarAoChegar, setGerarAoChegar] = useState(false)

  useEffect(() => {
    if (formasIniciais) {
      setFormas(formasIniciais)
      setGerarAoChegar(true)
    }
  }, [formasIniciais])
  const [linhas, setLinhas] = useState<LinhaPlano[]>([])
  const [lotes, setLotes] = useState<LoteSugerido[]>([])
  const [abastecimento, setAbastecimento] = useState<LinhaAbastecimento[]>([])
  const [loading, setLoading] = useState(true)
  const [calculando, setCalculando] = useState(false)
  // O plano que gerou o resultado na tela, para saber quando ele envelheceu.
  const [planoGerado, setPlanoGerado] = useState('')
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('fichas_tecnicas')
      .select('id, codigo, nome, versoes:fichas_tecnicas_versoes!inner(rendimento_fornada, ativa)')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .eq('tipo', 'produto')
      .order('codigo')
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as {
          id: string; codigo: string; nome: string
          versoes: { rendimento_fornada: number | null; ativa: boolean }[]
        }[]
        setFichas(
          rows.map(f => ({
            id: f.id,
            codigo: f.codigo,
            nome: f.nome,
            rendimento_fornada: f.versoes.find(v => v.ativa)?.rendimento_fornada ?? null,
          })),
        )
        setLoading(false)
      })
  }, [profile])

  const plano = useMemo(
    () =>
      fichas
        .map(f => ({ ficha_id: f.id, formas: parseFloat(formas[f.id] ?? '') || 0 }))
        .filter(p => p.formas > 0),
    [fichas, formas],
  )

  const totalFormas = plano.reduce((s, p) => s + p.formas, 0)
  const bateladas = totalFormas / FORMAS_POR_BATELADA

  // Unidades previstas: cada ficha tem seu próprio rendimento por forma
  const totalUnidades = plano.reduce((s, p) => {
    const f = fichas.find(x => x.id === p.ficha_id)
    return s + p.formas * (f?.rendimento_fornada ?? 0)
  }, 0)

  /**
   * O cálculo acontece no botão, não a cada tecla.
   *
   * Antes rodava sozinho com 300ms de espera: as tabelas apareciam e se
   * refaziam enquanto o número ainda estava sendo digitado, e três consultas
   * saíam a cada pausa. Agora é uma decisão explícita — e o resultado que está
   * na tela sempre corresponde a um plano que alguém mandou calcular.
   */
  async function gerar() {
    if (!profile || plano.length === 0) return
    setCalculando(true)
    const args = { p_empresa_id: profile.empresa_id, p_plano: plano }
    const [plan, fefo, abast] = await Promise.all([
      supabase.rpc('planejar_recipientes', args),
      supabase.rpc('sugerir_lotes_transferencia', args),
      supabase.rpc('planejar_abastecimento', args),
    ])
    const err = plan.error ?? fefo.error ?? abast.error
    if (err) {
      setErro(err.message)
    } else {
      setErro('')
      setLinhas((plan.data ?? []) as LinhaPlano[])
      setLotes((fefo.data ?? []) as LoteSugerido[])
      setAbastecimento((abast.data ?? []) as LinhaAbastecimento[])
      setPlanoGerado(JSON.stringify(plano))
    }
    setCalculando(false)
  }

  useEffect(() => {
    if (gerarAoChegar && plano.length > 0) {
      setGerarAoChegar(false)
      gerar()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gerarAoChegar, plano])

  // Zerar as formas apaga o resultado: manter tabela de um plano que não
  // existe mais é pior do que não mostrar nada.
  useEffect(() => {
    if (plano.length === 0) {
      setLinhas([])
      setLotes([])
      setAbastecimento([])
      setPlanoGerado('')
    }
  }, [plano])

  // Lotes sugeridos agrupados por insumo, preservando a ordem FEFO que veio do banco
  const lotesPorInsumo = useMemo(() => {
    const mapa = new Map<string, LoteSugerido[]>()
    for (const l of lotes) {
      const atual = mapa.get(l.insumo_id) ?? []
      atual.push(l)
      mapa.set(l.insumo_id, atual)
    }
    return [...mapa.values()]
  }, [lotes])

  // Insumos que precisam de transferência mas não têm lote no estoque central.
  // Vêm do banco com lote_id nulo — não dá para deduzir pela ausência na lista,
  // porque isso também aconteceria com quem já está coberto pelo recipiente.
  const semLote = useMemo(() => lotes.filter(l => l.lote_id === null), [lotes])

  /**
   * A folha impressa é uma lista de tarefas, não um relatório.
   *
   * Quem está com ela na mão quer os insumos que exigem trabalho primeiro, na
   * ordem dos códigos — que é a ordem em que ele anda pela prateleira. Os que
   * já estão cobertos não somem (serve conferir que não foram esquecidos), mas
   * vão para o fim, também em ordem de código.
   *
   * Ter tarefa é ter pote para encher OU lote para pegar. As duas listas vêm de
   * RPCs diferentes e nem sempre andam juntas: há insumo que precisa ser
   * abastecido e não tem lote no estoque central — esse é o caso que mais
   * precisa aparecer no topo.
   */
  const { comTarefa, cobertos, ordenadas } = useMemo(() => {
    const temTarefa = (l: LinhaPlano) =>
      abastecimento.some(a => a.insumo_id === l.insumo_id) ||
      lotes.some(x => x.insumo_id === l.insumo_id)
    const com = linhas.filter(temTarefa)
    const sem = linhas.filter(l => !temTarefa(l))
    return { comTarefa: com, cobertos: sem, ordenadas: [...com, ...sem] }
  }, [linhas, abastecimento, lotes])

  const potesParaEncher = abastecimento.length
  const lotesParaPegar = lotes.filter(l => l.lote_id !== null).length

  const faltamTotal = linhas.reduce((s, l) => s + (l.faltam ?? 0), 0)
  const semRecipiente = linhas.filter(l => l.capacidade == null)
  const coberto = linhas.length > 0 && faltamTotal === 0

  // As formas mudaram depois de gerar: o que está na tela é de outro plano.
  const desatualizado = linhas.length > 0 && JSON.stringify(plano) !== planoGerado

  if (loading) return <p className="p-6 text-sm text-gray-500">Carregando fichas…</p>

  return (
    <div className="space-y-5">
      {/* ── Duas colunas ───────────────────────────────────────
          A entrada e o resultado do dia disputavam a mesma faixa horizontal:
          para conferir uma tabela era preciso rolar para longe dos números que
          a geraram. Agora a entrada vira coluna fixa, como no planejador
          semanal, e as tabelas ocupam a largura que precisam. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <aside className="space-y-3 self-start lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4">
        {/* ── Entrada: formas por ficha ─────────────────────── */}
        <Card>
          <CardHeader
            title="Abastecimento necessário"
            subtitle="Quantas formas de cada ficha entram no dia. Pode misturar fichas."
          />
          <CardBody className="space-y-3">
            {fichas.length === 0 && (
              <p className="text-sm text-gray-500">
                Nenhuma ficha técnica ativa com rendimento definido.
              </p>
            )}

            {fichas.map(f => (
              <div key={f.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {f.codigo} — {f.nome}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-unno-dim">
                    {f.rendimento_fornada ?? '—'} unidades por forma
                  </p>
                </div>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={formas[f.id] ?? ''}
                  onChange={e => setFormas(s => ({ ...s, [f.id]: e.target.value }))}
                  placeholder="0"
                  className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                             focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                             dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                />
                <span className="text-xs text-gray-400 w-12">formas</span>
              </div>
            ))}

            {totalFormas > 0 && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-3 border-t border-gray-100 dark:border-white/[.08] text-sm">
                <span className="text-gray-500 dark:text-unno-muted">
                  Total: <strong className="text-gray-900 dark:text-unno-text">{fmt(totalFormas, 0)}</strong> formas
                </span>
                <span className="text-gray-500 dark:text-unno-muted">
                  Bateladas: <strong className="text-gray-900 dark:text-unno-text">{fmt(bateladas, 2)}</strong>
                </span>
                <span className="text-gray-500 dark:text-unno-muted">
                  Unidades: <strong className="text-gray-900 dark:text-unno-text">{fmt(totalUnidades, 0)}</strong>
                </span>
              </div>
            )}
          </CardBody>
        </Card>

          {/* Gerar é uma decisão, não um efeito colateral de digitar.
              O botão também é o indicador: "Gerado" e apagado significa que as
              tabelas ao lado correspondem exatamente ao que está nos campos. */}
          <Button
            fullWidth
            loading={calculando}
            disabled={plano.length === 0 || (linhas.length > 0 && !desatualizado)}
            onClick={gerar}
            title={linhas.length > 0 && !desatualizado
              ? 'As tabelas já correspondem a estas formas'
              : ''}
          >
            {linhas.length > 0
              ? (desatualizado ? 'Gerar' : 'Gerado')
              : 'Gerar planejamento'}
          </Button>

          {desatualizado && (
            <p className="text-xs text-amber-700">
              As formas mudaram — as tabelas ainda são do cálculo anterior.
            </p>
          )}

          {/* Situação e ações, na mesma coluna de quem acabou de gerar */}
          {linhas.length > 0 && (
            <Card
              className={coberto
                ? 'bg-brand-500/10 border-brand-500/25'
                : 'bg-unno-amber/10 border-unno-amber/30'}
            >
              <CardBody className="py-3 space-y-2">
                <p className="font-display font-semibold text-sm text-gray-900 dark:text-unno-text">
                  {coberto ? '✔ Produção coberta' : `⚠ Faltam ${faltamTotal} recipiente(s)`}
                </p>
                <p className="text-xs text-gray-600 dark:text-unno-muted">
                  {coberto
                    ? 'Todos os insumos têm recipientes suficientes para esta sessão.'
                    : 'Abasteça ou providencie os recipientes marcados ao lado antes de começar.'}
                </p>
                <Button fullWidth size="sm" variant="secondary" onClick={() => window.print()}>
                  Imprimir / PDF
                </Button>
                <Button fullWidth size="sm"
                        onClick={() => navigate('/producao/abrir', { state: { formas } })}>
                  Abrir sessão
                </Button>
              </CardBody>
            </Card>
          )}
        </aside>

        <div className="space-y-5 lg:col-start-1 lg:row-start-1">
          {linhas.length === 0 && !calculando && (
            <Card>
              <CardBody className="text-center py-12">
                <p className="text-sm text-gray-500 dark:text-unno-muted">
                  {plano.length === 0
                    ? 'Informe quantas formas de cada ficha entram no dia.'
                    : 'Clique em "Gerar planejamento" para ver os recipientes e os lotes.'}
                </p>
              </CardBody>
            </Card>
          )}

        {erro && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700
                          dark:bg-unno-danger/10 dark:border-unno-danger/30 dark:text-unno-danger">
            {erro}
          </div>
        )}

        {/* ── Resultado ─────────────────────────────────────── */}
        {linhas.length > 0 && (
          <>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-unno-bg">
                    <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-unno-dim">
                      <th className="px-4 py-3 font-semibold">Insumo</th>
                      <th className="px-4 py-3 font-semibold">Recipiente</th>
                      <th className="px-4 py-3 font-semibold text-right">Demanda</th>
                      <th className="px-4 py-3 font-semibold text-right">Cap.</th>
                      <th className="px-4 py-3 font-semibold text-right">Tem</th>
                      <th className="px-4 py-3 font-semibold text-right">Precisa</th>
                      <th className="px-4 py-3 font-semibold text-right">Faltam</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-white/[.06]">
                    {linhas.map(l => (
                      <tr key={l.insumo_id} className="hover:bg-gray-50 dark:hover:bg-white/[.02]">
                        <td className="px-4 py-2.5">
                          <span className="text-gray-400 dark:text-unno-dim text-xs mr-2">{l.codigo}</span>
                          <span className="text-gray-900 dark:text-unno-text">{l.nome}</span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-unno-muted">
                          {l.recipiente_modelo ?? (
                            <span className="text-unno-amber">a definir</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-900 dark:text-unno-text">
                          {fmt(l.demanda)} <span className="text-gray-400 text-xs">{l.unidade}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-unno-muted">
                          {l.capacidade != null ? fmt(l.capacidade) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-unno-muted">
                          {l.recipientes_atuais}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-900 dark:text-unno-text">
                          {l.recipientes_necessarios ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {l.faltam == null ? (
                            <Badge variant="warning">sem recip.</Badge>
                          ) : l.faltam > 0 ? (
                            <Badge variant="danger">{l.faltam}</Badge>
                          ) : (
                            <Badge variant="success">ok</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* ── Abastecimento: em quais potes colocar ─────── */}
            {abastecimento.length > 0 && (
              <Card>
                <CardHeader
                  title="Abastecer nesta ordem"
                  subtitle="Completa os potes já em uso antes de abrir pote novo — o espaço é o que falta."
                />
                <CardBody className="space-y-4">
                  {[...new Set(abastecimento.map(a => a.insumo_id))].map(insId => {
                    const linhas = abastecimento.filter(a => a.insumo_id === insId)
                    const primeiro = linhas[0]
                    return (
                      <div key={insId}>
                        <div className="mb-2">
                          <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                            <span className="text-gray-400 dark:text-unno-dim text-xs mr-2">
                              {primeiro.insumo_codigo}
                            </span>
                            {primeiro.insumo_nome}
                          </p>

                          {/* A conta aberta: quanto entra, quanto é da produção,
                              quanto é excedente, e como o pote fica depois. */}
                          <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
                            <span className="text-gray-500 dark:text-unno-muted">
                              Abastecer{' '}
                              <strong className="text-gray-900 dark:text-unno-text">
                                {fmt(primeiro.alvo)} {primeiro.unidade}
                              </strong>
                            </span>
                            <span className="text-gray-500 dark:text-unno-muted">
                              Produção {fmt(primeiro.para_producao)}
                            </span>
                            <span className="text-unno-amber">
                              Excedente {fmt(primeiro.excedente)}
                            </span>
                            <span className="text-gray-500 dark:text-unno-muted">
                              Sobra depois{' '}
                              <strong className="text-gray-900 dark:text-unno-text">
                                {fmt(primeiro.sobra_apos_producao)}
                              </strong>
                            </span>
                          </div>

                          {primeiro.conteudo_atual > 0 && (
                            <p className="text-[0.7rem] text-gray-400 dark:text-unno-dim mt-1">
                              Já tem {fmt(primeiro.conteudo_atual)} nos recipientes · capacidade
                              total {fmt(primeiro.capacidade_total)} {primeiro.unidade}
                            </p>
                          )}
                        </div>

                        <div className="space-y-1">
                          {linhas.map(a => (
                            <div
                              key={a.local_id}
                              className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/[.08]
                                         bg-gray-50 dark:bg-white/[.02] px-3 py-2"
                            >
                              <span className="w-5 text-xs font-bold text-brand-600 dark:text-brand-400">
                                {a.ordem}º
                              </span>
                              <span className="text-xs text-gray-900 dark:text-unno-text flex-1 truncate">
                                {a.local_nome}
                              </span>
                              {a.ja_tem > 0 && (
                                <span className="text-[0.65rem] text-gray-500 dark:text-unno-muted whitespace-nowrap">
                                  tem {fmt(a.ja_tem)}
                                </span>
                              )}
                              <span className="text-xs tabular-nums font-semibold text-gray-900 dark:text-unno-text whitespace-nowrap">
                                + {fmt(a.colocar)} {a.unidade}
                              </span>
                              <span className="text-[0.65rem] text-gray-400 dark:text-unno-dim whitespace-nowrap">
                                de {a.capacidade != null ? fmt(a.capacidade) : '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  <p className="text-xs text-gray-500 dark:text-unno-muted pt-1 border-t border-gray-100 dark:border-white/[.08]">
                    <strong>sobra</strong> = quantidade muito pequena para justificar um pote
                    só para ela. Se couber nos anteriores, melhor não abrir mais um.
                  </p>
                </CardBody>
              </Card>
            )}

            {/* ── Lotes a transferir (FEFO) ─────────────────── */}
            <Card>
              <CardHeader
                title="Lotes a transferir"
                subtitle="Ordem FEFO — vence antes, sai antes. Pode transferir parcial."
              />
              <CardBody className="space-y-4">
                {lotesPorInsumo.length === 0 && semLote.length === 0 && (
                  <p className="text-sm text-gray-500 dark:text-unno-muted">
                    Os recipientes já têm o suficiente para esta sessão — nada a transferir.
                  </p>
                )}

                {lotesPorInsumo.map(grupo => {
                  const primeiro = grupo[0]
                  return (
                    <div key={primeiro.insumo_id}>
                      <div className="flex items-baseline justify-between gap-3 mb-1.5">
                        <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                          <span className="text-gray-400 dark:text-unno-dim text-xs mr-2">
                            {primeiro.insumo_codigo}
                          </span>
                          {primeiro.insumo_nome}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-unno-muted whitespace-nowrap">
                          levar {fmt(primeiro.alvo)} {primeiro.unidade}
                        </p>
                      </div>

                      <div className="space-y-1">
                        {grupo.map(l =>
                          l.lote_id === null ? (
                            <div
                              key={`sem-${l.insumo_id}`}
                              className="rounded-lg border border-unno-amber/30 bg-unno-amber/10 px-3 py-2
                                         text-xs text-gray-700 dark:text-unno-amber"
                            >
                              Sem lote no estoque central — confira o recebimento antes da produção.
                            </div>
                          ) : (
                            <div
                              key={l.lote_id}
                              className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-white/[.08]
                                         bg-gray-50 dark:bg-white/[.02] px-3 py-2"
                            >
                              <span className="font-mono text-xs text-gray-900 dark:text-unno-text flex-1 truncate">
                                {l.lote_codigo}
                              </span>
                              {/* O que já estava aberto tem que sair primeiro —
                                  é a regra do "um lote aberto só". */}
                              {l.ja_estava_aberto && <Badge variant="info">aberto</Badge>}
                              {l.dias_para_vencer != null && l.dias_para_vencer <= 7 && (
                                <Badge variant={l.dias_para_vencer <= 0 ? 'danger' : 'warning'}>
                                  {l.dias_para_vencer <= 0 ? 'vencido' : `${l.dias_para_vencer}d`}
                                </Badge>
                              )}
                              <span className="text-xs tabular-nums font-semibold text-gray-900 dark:text-unno-text whitespace-nowrap">
                                levar {fmt(l.levar ?? 0)} {l.unidade}
                              </span>
                              {(l.volta_aberto ?? 0) > 0 && (
                                <span className="text-[0.65rem] text-unno-amber whitespace-nowrap">
                                  volta {fmt(l.volta_aberto!)} aberto
                                </span>
                              )}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )
                })}

                {semLote.length > 0 && (
                  <p className="text-xs text-gray-500 dark:text-unno-muted pt-1 border-t border-gray-100 dark:border-white/[.08]">
                    {semLote.length} insumo(s) sem lote no estoque central:{' '}
                    {semLote.map(l => l.insumo_nome).join(', ')}.
                  </p>
                )}
              </CardBody>
            </Card>

            {semRecipiente.length > 0 && (
              <p className="text-xs text-gray-500 dark:text-unno-muted">
                {semRecipiente.map(l => l.nome).join(' e ')}{' '}
                {semRecipiente.length > 1 ? 'ainda não têm' : 'ainda não tem'} recipiente definido —
                a demanda é calculada, mas não dá para dizer quantos potes são necessários.{' '}
                <button
                  onClick={() => navigate('/insumos')}
                  className="text-brand-600 dark:text-brand-400 underline"
                >
                  Definir agora
                </button>
              </p>
            )}
          </>
        )}

        {calculando && <p className="text-xs text-gray-400">Calculando…</p>}

        </div>
      </div>

      {/* ── Versão impressa (A4) ──────────────────────────── */}
      <style>{printStyles}</style>
      {linhas.length > 0 && (
        <div className="planejador-print-target">
          <div style={{ marginBottom: '10mm' }}>
            <h1 style={{ fontSize: '16pt', fontWeight: 700, margin: 0 }}>
              Planejamento de Recipientes
            </h1>
            <p style={{ fontSize: '10pt', margin: '2mm 0 0' }}>
              {plano
                .map(p => {
                  const f = fichas.find(x => x.id === p.ficha_id)
                  return `${fmt(p.formas, 0)} formas de ${f?.nome ?? '—'}`
                })
                .join('  ·  ')}
            </p>
            <p style={{ fontSize: '10pt', margin: '1mm 0 0' }}>
              Total: {fmt(totalFormas, 0)} formas · {fmt(bateladas, 2)} bateladas ·{' '}
              {fmt(totalUnidades, 0)} unidades
            </p>
            <p style={{ fontSize: '10pt', margin: '3mm 0 0', fontWeight: 600 }}>
              {coberto ? 'Producao coberta' : `Faltam ${faltamTotal} recipiente(s)`}
              {'   ·   '}
              {new Date().toLocaleDateString('pt-BR')}
            </p>
          </div>

          {/* Resumo do serviço: o que precisa ser feito, antes da lista de como
              fazer. Quem pega a folha decide primeiro se dá tempo hoje. */}
          <div style={{ border: '1.5px solid #333', padding: '3mm 4mm', marginBottom: '6mm' }}>
            <p style={{ fontSize: '9pt', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>
              O que fazer
            </p>
            <p style={{ fontSize: '12pt', margin: '1.5mm 0 0', fontWeight: 700 }}>
              {comTarefa.length} insumo{comTarefa.length === 1 ? '' : 's'} a reabastecer
              {potesParaEncher > 0 &&
                ` · ${potesParaEncher} recipiente${potesParaEncher === 1 ? '' : 's'} para encher`}
              {lotesParaPegar > 0 &&
                ` · ${lotesParaPegar} lote${lotesParaPegar === 1 ? '' : 's'} para pegar no estoque`}
            </p>
            {(semLote.length > 0 || faltamTotal > 0) && (
              <p style={{ fontSize: '9.5pt', margin: '2mm 0 0', fontWeight: 600 }}>
                Atenção:
                {semLote.length > 0 &&
                  ` ${semLote.length} insumo${semLote.length === 1 ? '' : 's'} sem lote no estoque central`}
                {semLote.length > 0 && faltamTotal > 0 && ' ·'}
                {faltamTotal > 0 &&
                  ` faltam ${faltamTotal} recipiente${faltamTotal === 1 ? '' : 's'} para caber tudo`}
              </p>
            )}
            {cobertos.length > 0 && (
              <p style={{ fontSize: '8.5pt', margin: '2mm 0 0', fontStyle: 'italic' }}>
                {cobertos.length} insumo{cobertos.length === 1 ? '' : 's'} já
                {cobertos.length === 1 ? ' está coberto' : ' estão cobertos'} e
                {cobertos.length === 1 ? ' aparece' : ' aparecem'} no fim da lista, só para conferência.
              </p>
            )}
          </div>

          <table>
            {/* Larguras fixas: sem isso os números quebram em duas linhas e a
                folha vira mingau. A coluna larga é a descrição, que absorve
                nomes de pote e códigos de lote. */}
            <colgroup>
              <col style={{ width: '13%' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '6%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Cód.</th>
                <th>Insumo</th>
                <th className="num">Demanda</th>
                <th className="num">Abastecer</th>
                <th className="num">Sobra</th>
                <th className="num">✓</th>
              </tr>
            </thead>
            {/* Um <tbody> por insumo: é o que mantém o bloco inteiro na mesma
                página (ver a regra de impressão lá em cima). */}
            {ordenadas.map((l, i) => {
                const seusLotes = lotes.filter(x => x.insumo_id === l.insumo_id)
                const potesDoInsumo = abastecimento.filter(a => a.insumo_id === l.insumo_id)
                const ab = potesDoInsumo[0]
                return (
                  <tbody key={l.insumo_id}>
                    {/* Fronteira entre o que dá trabalho e o que só se confere */}
                    {i === comTarefa.length && (
                      <tr className="linha-grupo">
                        <td />
                        <td colSpan={5} style={{ paddingTop: '5mm' }}>
                          Já cobertos — nada a fazer
                        </td>
                      </tr>
                    )}
                    <tr className="linha-insumo">
                      <td>{l.codigo}</td>
                      <td>{l.nome}</td>
                      <td className="num">
                        {fmt(l.demanda)} {l.unidade}
                      </td>
                      <td className="num">{ab ? fmt(ab.alvo) : '—'}</td>
                      <td className="num">{ab ? fmt(ab.sobra_apos_producao) : '—'}</td>
                      <td />
                    </tr>

                    {/* A conta do abastecimento, em letra miúda sob o insumo */}
                    {ab && ab.excedente > 0 && (
                      <tr className="linha-nota">
                        <td />
                        <td colSpan={5}>
                          {fmt(ab.para_producao)} para a produção + {fmt(ab.excedente)} de
                          excedente
                          {ab.conteudo_atual > 0 &&
                            ` · já tem ${fmt(ab.conteudo_atual)} nos recipientes`}
                        </td>
                      </tr>
                    )}

                    {/* ENCHER — em quais potes colocar, na ordem de trabalho */}
                    {potesDoInsumo.length > 0 && (
                      <tr className="linha-grupo">
                        <td />
                        <td colSpan={5}>Encher</td>
                      </tr>
                    )}
                    {potesDoInsumo.map(a => (
                      <tr key={`ab-${a.local_id}`} className="linha-item">
                        <td />
                        <td>
                          {a.ordem}º {a.local_nome}
                        </td>
                        <td className="num small">
                          {a.ja_tem > 0 ? `tem ${fmt(a.ja_tem)}` : ''}
                        </td>
                        <td className="num">
                          {fmt(a.colocar)} {a.unidade}
                        </td>
                        <td className="num small">
                          de {a.capacidade != null ? fmt(a.capacidade) : '—'}
                        </td>
                        <td className="num caixa">□</td>
                      </tr>
                    ))}

                    {/* PEGAR — quais lotes tirar do estoque central */}
                    {seusLotes.length > 0 && (
                      <tr className="linha-grupo">
                        <td />
                        <td colSpan={5}>Pegar no estoque</td>
                      </tr>
                    )}
                    {seusLotes.map(x =>
                      x.lote_id === null ? (
                        <tr key={`sem-${l.insumo_id}`} className="linha-item">
                          <td />
                          <td colSpan={5} style={{ fontStyle: 'italic' }}>
                            sem lote no estoque central
                          </td>
                        </tr>
                      ) : (
                        <tr key={x.lote_id} className="linha-item">
                          <td />
                          <td className="mono">
                            {x.lote_codigo}
                            {x.ja_estava_aberto && ' · ABERTO'}
                          </td>
                          <td className="num small">
                            vence {new Date(x.validade + 'T00:00:00').toLocaleDateString('pt-BR')}
                          </td>
                          <td className="num">
                            {fmt(x.levar ?? 0)} {x.unidade}
                          </td>
                          <td className="num small">
                            {(x.volta_aberto ?? 0) > 0
                              ? `volta ${fmt(x.volta_aberto!)}`
                              : ''}
                          </td>
                          <td className="num caixa">□</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                )
              })}
          </table>

          <p style={{ fontSize: '8pt', marginTop: '6mm' }}>
            A demanda de cada insumo soma todas as fichas da sessão — os recipientes são
            compartilhados entre as receitas. Lotes em ordem FEFO: vence antes, sai antes;
            o lote vai inteiro. Mischa's Bakery · Porto Alegre/RS
          </p>
        </div>
      )}
    </div>
  )
}

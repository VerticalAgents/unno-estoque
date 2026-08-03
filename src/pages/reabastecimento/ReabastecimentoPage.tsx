import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
// A mesma regra de qual semana é "esta": no fim de semana, a que vem.
import { semanaDeTrabalho } from '../../lib/utils'

/**
 * Planejamento de Reabastecimento — substitui a aba "Projeção de Produção"
 * da planilha.
 *
 * O caminho é o mesmo que a fábrica usa para pensar:
 *
 *   meta de unidades → fornadas → insumo necessário → o que comprar
 *
 * A meta é a entrada porque é o que se sabe (o pedido do cliente, a meta do
 * mês). Quantas fornadas isso dá é consequência — e arredonda para cima,
 * porque não existe meia fornada.
 *
 * Contas em `v_projecao_formas` e `v_reabastecimento` (migration 048). O
 * estoque soma o central e o que está dentro dos recipientes: o açúcar que
 * está no pote é açúcar que a fábrica tem.
 */

interface FichaOption {
  id: string
  codigo: string
  nome: string
  /** Quantas unidades saem de uma forma. Vem da versão ativa da ficha
   *  (`fichas_tecnicas_versoes.rendimento_fornada`), editável em
   *  Configurações → Produção. */
  rendimento_fornada: number | null
}

/** A conversão meta → fornadas, calculada na hora em que se digita. */
interface Conversao {
  ficha: FichaOption
  unidades: number
  formas: number
  bateladas: number
  unidades_produzidas: number
}

const FORMAS_POR_BATELADA = 4

interface LinhaReabastecimento {
  insumo_id: string
  insumo_codigo: string
  insumo_nome: string
  unidade: string
  margem_pct: number
  consumo_bruto: number
  necessario: number
  estoque_ec: number
  estoque_ep: number
  estoque_total: number
  comprar: number
  tamanho_embalagem: number | null
  embalagens: number | null
  cobertura_pct: number | null
}

function fmt(n: number | null, casas = 3) {
  if (n == null) return '—'
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

/** Mesmo padrão do Planejador: esconde a tela e imprime só a folha. */
const printStyles = `
  .pedido-print-target { display: none; }

  @page { size: A4 portrait; margin: 14mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }

    body > * { visibility: hidden; }

    .pedido-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0; left: 0; right: 0;
      color: #111;
      font-size: 11pt;
    }
    .pedido-print-target * { visibility: visible !important; color: #111 !important; }
    .pedido-print-target table { width: 100%; border-collapse: collapse; }
    .pedido-print-target th, .pedido-print-target td {
      border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left;
    }
    .pedido-print-target th {
      border-bottom: 1.5px solid #333; font-size: 9pt; text-transform: uppercase;
    }
    .pedido-print-target .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .pedido-print-target .mono { font-family: 'Courier New', monospace; font-size: 9pt; }
    .pedido-print-target thead { display: table-header-group; }
    .pedido-print-target tr { page-break-inside: avoid; }
    .pedido-print-target .small { font-size: 8pt; color: #666 !important; }
    .pedido-print-target .caixa { letter-spacing: 2px; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

export function ReabastecimentoPage() {
  const { profile } = useAuth()

  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [alvo, setAlvo] = useState<Record<string, string>>({})
  // O que está gravado hoje. Serve só para avisar quando a tela mostra número
  // digitado e lista de compras ainda calculada com o número antigo.
  const [alvoSalvo, setAlvoSalvo] = useState<Record<string, string>>({})
  const [margem, setMargem] = useState('15')
  const [margemSalva, setMargemSalva] = useState('15')
  // Dois jeitos de chegar no mesmo lugar. Em 'unidades' você digita a meta de
  // cada produto; em 'percentual', digita o total e como ele se reparte.
  // O que vai para o banco é sempre unidades por ficha.
  const [modo, setModo] = useState<'unidades' | 'percentual'>('unidades')
  const [totalDigitado, setTotalDigitado] = useState('')
  const [pct, setPct] = useState<Record<string, string>>({})
  const [linhas, setLinhas] = useState<LinhaReabastecimento[]>([])
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [empresaNome, setEmpresaNome] = useState('')

  const recalcular = useCallback(async () => {
    if (!profile) return
    const { data, error } = await supabase.from('v_reabastecimento').select('*')
      .eq('empresa_id', profile.empresa_id).order('insumo_codigo')
    if (error) { setErro(error.message); return }
    setLinhas((data ?? []) as unknown as LinhaReabastecimento[])
  }, [profile])

  useEffect(() => {
    if (!profile) return

    async function carregar() {
      const [fichasRes, projRes, cfgRes, empRes] = await Promise.all([
        supabase.from('fichas_tecnicas')
          .select('id, codigo, nome, versoes:fichas_tecnicas_versoes!inner(rendimento_fornada, ativa)')
          .eq('empresa_id', profile!.empresa_id)
          .eq('ativo', true).eq('tipo', 'produto').order('codigo'),
        supabase.from('projecao_producao')
          .select('ficha_id, unidades_alvo')
          .eq('empresa_id', profile!.empresa_id),
        supabase.from('configuracoes_sistema')
          .select('reabastecimento_margem_pct')
          .eq('empresa_id', profile!.empresa_id).maybeSingle(),
        supabase.from('empresas')
          .select('nome').eq('id', profile!.empresa_id).maybeSingle(),
      ])

      const rows = (fichasRes.data ?? []) as unknown as {
        id: string; codigo: string; nome: string
        versoes: { rendimento_fornada: number | null; ativa: boolean }[]
      }[]
      setFichas(rows.map(f => ({
        id: f.id, codigo: f.codigo, nome: f.nome,
        rendimento_fornada: f.versoes.find(v => v.ativa)?.rendimento_fornada ?? null,
      })))

      const salvos = Object.fromEntries(
        (projRes.data ?? []).map(p => [p.ficha_id, String(Number(p.unidades_alvo))]),
      )
      setAlvo(salvos)
      setAlvoSalvo(salvos)
      if (cfgRes.data) {
        const m = String(Number(cfgRes.data.reabastecimento_margem_pct))
        setMargem(m)
        setMargemSalva(m)
      }
      setEmpresaNome(empRes.data?.nome ?? '')
      await recalcular()
      setLoading(false)
    }

    carregar()
  }, [profile, recalcular])

  async function salvar() {
    if (!profile) return
    setSalvando(true)
    setErro('')

    const { error: cfgErr } = await supabase
      .from('configuracoes_sistema')
      .update({ reabastecimento_margem_pct: parseFloat(margem.replace(',', '.')) || 0 })
      .eq('empresa_id', profile.empresa_id)

    const { data, error } = await supabase.rpc('salvar_projecao', {
      p_empresa_id: profile.empresa_id,
      p_projecao: fichas.map(f => ({
        ficha_id: f.id,
        unidades_alvo: alvoEfetivo[f.id] ?? 0,
      })),
    })

    setSalvando(false)

    if (cfgErr || error || !(data as { ok?: boolean })?.ok) {
      setErro(cfgErr?.message ?? error?.message ?? 'Não foi possível salvar.')
      return
    }
    setAlvoSalvo(Object.fromEntries(
      Object.entries(alvoEfetivo).map(([k, v]) => [k, String(v)]),
    ))
    setMargemSalva(margem)
    await recalcular()
  }

  const num = (s: string | undefined) => parseFloat((s ?? '').replace(',', '.')) || 0

  const totalPct = useMemo(
    () => fichas.reduce((s, f) => s + num(pct[f.id]), 0),
    [fichas, pct],
  )

  /**
   * A meta de cada ficha, venha ela de onde vier.
   *
   * No modo percentual as unidades saem da divisão do total; arredondam para
   * inteiro, então a soma pode ficar uma ou duas unidades longe do total
   * digitado. A tela mostra a soma real em vez de esconder a diferença.
   */
  const alvoEfetivo = useMemo<Record<string, number>>(() => {
    if (modo === 'unidades') {
      return Object.fromEntries(fichas.map(f => [f.id, num(alvo[f.id])]))
    }
    const total = num(totalDigitado)
    return Object.fromEntries(
      fichas.map(f => [f.id, Math.round(total * num(pct[f.id]) / 100)]),
    )
  }, [modo, fichas, alvo, totalDigitado, pct])

  /**
   * A conversão acontece na tela, enquanto se digita. Antes ela vinha do banco
   * e só mudava depois de salvar — o que fazia a tela somar unidades novas com
   * formas antigas.
   */
  const conversoes = useMemo<Conversao[]>(
    () => fichas
      .map(f => {
        const unidades = alvoEfetivo[f.id] ?? 0
        const rend = f.rendimento_fornada ?? 0
        const formas = rend > 0 ? Math.ceil(unidades / rend) : 0
        return {
          ficha: f,
          unidades,
          formas,
          bateladas: Math.ceil(formas / FORMAS_POR_BATELADA),
          unidades_produzidas: formas * rend,
        }
      })
      .filter(c => c.unidades > 0),
    [fichas, alvoEfetivo],
  )

  const totalUnidades = conversoes.reduce((s, c) => s + c.unidades, 0)
  const totalFormas = conversoes.reduce((s, c) => s + c.formas, 0)

  /**
   * Puxa a meta do plano da semana atual.
   *
   * As duas telas seguem independentes de propósito — às vezes se compra para
   * mais de uma semana. Por isso é um botão, e não uma leitura automática.
   */
  async function puxarDoPlano() {
    if (!profile) return
    setErro('')
    const { data, error } = await supabase
      .from('planos_semana')
      .select('itens:planos_semana_itens(ficha_id, formas)')
      .eq('empresa_id', profile.empresa_id)
      .eq('semana_inicio', semanaDeTrabalho())
      .maybeSingle()

    if (error) { setErro(error.message); return }
    if (!data) {
      setErro('Não há plano salvo para esta semana. Monte a semana no Planejador → aba Semana.')
      return
    }

    const itens = (data as unknown as { itens: { ficha_id: string; formas: number }[] }).itens ?? []
    const novo: Record<string, string> = {}
    for (const f of fichas) {
      const formas = itens.filter(i => i.ficha_id === f.id).reduce((s, i) => s + i.formas, 0)
      const un = formas * (f.rendimento_fornada ?? 0)
      if (un > 0) novo[f.id] = String(un)
    }

    if (Object.keys(novo).length === 0) {
      setErro('O plano desta semana está sem produção lançada.')
      return
    }
    setModo('unidades')
    setAlvo(novo)
  }

  /** Quanto cada ficha representa da produção total. */
  const participacao = (unidades: number) =>
    totalUnidades > 0 ? (100 * unidades) / totalUnidades : 0

  /**
   * Trocar de modo não pode zerar o que já foi digitado: cada modo entra
   * mostrando a mesma distribuição que o outro estava mostrando.
   */
  function trocarModo(novo: 'unidades' | 'percentual') {
    if (novo === modo) return
    if (novo === 'percentual') {
      setTotalDigitado(totalUnidades > 0 ? String(totalUnidades) : '')
      setPct(Object.fromEntries(fichas.map(f => {
        const p = participacao(alvoEfetivo[f.id] ?? 0)
        return [f.id, p > 0 ? String(Math.round(p * 10) / 10) : '']
      })))
    } else {
      setAlvo(Object.fromEntries(fichas.map(f => {
        const u = alvoEfetivo[f.id] ?? 0
        return [f.id, u > 0 ? String(u) : '']
      })))
    }
    setModo(novo)
  }

  // Digitou e ainda não salvou: a lista de compras abaixo é a antiga.
  const naoSalvo = useMemo(() => {
    if (margem !== margemSalva) return true
    const ids = new Set([...Object.keys(alvoEfetivo), ...Object.keys(alvoSalvo)])
    for (const id of ids) {
      if ((alvoEfetivo[id] ?? 0) !== num(alvoSalvo[id])) return true
    }
    return false
  }, [alvoEfetivo, alvoSalvo, margem, margemSalva])

  const semRendimento = fichas.filter(
    f => !f.rendimento_fornada && (alvoEfetivo[f.id] ?? 0) > 0,
  )

  const aComprar = linhas.filter(l => l.comprar > 0)
  const semEmbalagem = aComprar.filter(l => l.embalagens == null)
  const hoje = new Date().toLocaleDateString('pt-BR')

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <style>{printStyles}</style>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">
          Planejamento de Reabastecimento
        </h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          Diga a meta de produção; o sistema diz quanto comprar de cada insumo
        </p>
      </div>

      {/* ── Meta de produção ────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Meta de produção"
          subtitle={modo === 'unidades'
            ? 'Quantas unidades de cada produto você quer produzir'
            : 'Quanto no total e como isso se reparte entre os produtos'}
          action={
            <Button variant="ghost" size="sm" onClick={puxarDoPlano}
                    title="Preenche com o plano de produção desta semana">
              Usar o plano da semana
            </Button>
          }
        />
        <CardBody className="space-y-3">
          {/* Dois caminhos para a mesma coisa: às vezes se sabe a meta de cada
              produto, às vezes se sabe o total e a divisão. */}
          <div className="flex gap-1 p-1 bg-gray-100 dark:bg-white/[.04] rounded-lg">
            {([
              ['unidades', 'Por produto'],
              ['percentual', 'Total e %'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => trocarModo(key)}
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
            <div className="flex items-center gap-3 pb-1">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                  Produção total
                </p>
              </div>
              <input
                type="number" min={0} step={100} inputMode="numeric"
                value={totalDigitado}
                onChange={e => setTotalDigitado(e.target.value)}
                placeholder="0"
                className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right font-semibold
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
              <span className="text-xs text-gray-400 w-14">unidades</span>
            </div>
          )}

          {fichas.map(f => {
            const c = conversoes.find(x => x.ficha.id === f.id)
            const unidades = alvoEfetivo[f.id] ?? 0
            return (
              <div key={f.id}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-unno-text truncate">
                      {f.codigo} — {f.nome}
                    </p>
                  </div>
                  {modo === 'unidades' ? (
                    <input
                      type="number"
                      min={0}
                      step={60}
                      inputMode="numeric"
                      value={alvo[f.id] ?? ''}
                      onChange={e => setAlvo(s => ({ ...s, [f.id]: e.target.value }))}
                      placeholder="0"
                      className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                                 focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                                 dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                    />
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step="0.5"
                      inputMode="decimal"
                      value={pct[f.id] ?? ''}
                      onChange={e => setPct(s => ({ ...s, [f.id]: e.target.value }))}
                      placeholder="0"
                      className="w-32 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                                 focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                                 dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                    />
                  )}
                  <span className="text-xs text-gray-400 w-14">
                    {modo === 'unidades' ? 'unidades' : '%'}
                  </span>
                </div>

                {/* A distribuição, sempre visível: no modo por produto é o que
                    o sistema calculou; no modo percentual, as unidades que
                    saíram da divisão. */}
                {unidades > 0 && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/[.06] overflow-hidden">
                      <div
                        className="h-full bg-brand-500 rounded-full"
                        style={{ width: `${Math.min(participacao(unidades), 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 dark:text-unno-muted tabular-nums whitespace-nowrap">
                      {modo === 'unidades'
                        ? `${fmt(participacao(unidades), 1)}% do total`
                        : `${fmt(unidades, 0)} un · ${fmt(participacao(unidades), 1)}%`}
                    </span>
                  </div>
                )}
                {/* A conversão, para conferência. Muda enquanto se digita. */}
                {c && c.ficha.rendimento_fornada && (
                  <p className="text-xs text-gray-500 dark:text-unno-dim mt-1 ml-0.5">
                    {fmt(c.unidades, 0)} ÷ {c.ficha.rendimento_fornada} un/forma ={' '}
                    <strong>{c.formas} formas</strong> · {c.bateladas} bateladas
                    {c.unidades_produzidas > c.unidades && (
                      <> · saem {fmt(c.unidades_produzidas, 0)} un, a última forma vai inteira</>
                    )}
                  </p>
                )}
                {c && !c.ficha.rendimento_fornada && (
                  <p className="text-xs text-red-600 mt-1 ml-0.5">
                    Sem rendimento cadastrado — o sistema não sabe quantas unidades
                    saem de uma forma. Configurações → Produção.
                  </p>
                )}
              </div>
            )
          })}

          <div className="pt-3 border-t border-gray-100 dark:border-white/[.06]">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
              Margem de segurança (%)
            </label>
            <input
              type="number" inputMode="decimal" min={0} step={1} value={margem}
              onChange={e => setMargem(e.target.value)}
              className="mt-1 w-full sm:w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                         dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
            />
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Sobra sobre o consumo calculado. Cobre perda de processo e produção
              acima da meta.
            </p>
          </div>

          {/* Os percentuais têm que fechar em 100 — se não fecham, parte da
              produção ficou de fora e o pedido sairia menor do que deveria. */}
          {modo === 'percentual' && totalPct > 0 && Math.abs(totalPct - 100) > 0.05 && (
            <div className={`p-3 rounded-lg text-sm ${
              totalPct > 100
                ? 'bg-red-50 border border-red-200 text-red-700'
                : 'bg-amber-50 border border-amber-200 text-amber-800'
            }`}>
              Os percentuais somam <strong>{fmt(totalPct, 1)}%</strong>.
              {totalPct > 100
                ? ' Passa de 100% — a soma das metas vai ficar maior que o total.'
                : ` Faltam ${fmt(100 - totalPct, 1)}% para fechar 100%.`}
            </div>
          )}

          {totalUnidades > 0 && (
            <div className="bg-gray-50 dark:bg-white/[.03] rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-unno-muted">
              {fmt(totalUnidades, 0)} unidades no total —{' '}
              <strong>{totalFormas} formas</strong>
              {' '}· {Math.ceil(totalFormas / FORMAS_POR_BATELADA)} bateladas
              {/* Arredondamento da divisão: mostrar em vez de esconder */}
              {modo === 'percentual' && num(totalDigitado) > 0
                && totalUnidades !== num(totalDigitado) && (
                <> · a divisão arredondada deu {totalUnidades > num(totalDigitado) ? '+' : ''}
                  {fmt(totalUnidades - num(totalDigitado), 0)} un sobre o total digitado</>
              )}
            </div>
          )}

          {semRendimento.length > 0 && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {semRendimento.map(f => f.codigo).join(', ')} sem rendimento cadastrado.
              O insumo dessas fichas não entra na conta.
            </div>
          )}

          {/* O botão também é o indicador: apagado e escrito "Salvo" quer
              dizer que a lista de compras abaixo corresponde a estes números. */}
          <Button
            onClick={salvar}
            loading={salvando}
            fullWidth
            // Só o "não mudou nada" desativa. Zerar tudo é uma alteração
            // legítima — é assim que se limpa a projeção.
            disabled={!naoSalvo}
            title={naoSalvo ? '' : 'A lista já corresponde a estes números'}
          >
            {naoSalvo ? 'Salvar e recalcular' : 'Salvo'}
          </Button>

          {erro && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {erro}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Lista do pedido ─────────────────────────────────── */}
      {linhas.length === 0 ? (
        <Card>
          <CardBody className="text-center py-10">
            <p className="text-gray-500 dark:text-unno-muted">
              Informe a meta de unidades e salve para ver o pedido.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="O que comprar"
            subtitle={naoSalvo
              ? 'Calculado com os números anteriores — salve para atualizar'
              : `${aComprar.length} insumo(s) · margem de ${margemSalva}% já embutida`}
            action={
              // Imprimir com a tela desatualizada geraria um pedido que não
              // corresponde a nada. Salvar primeiro.
              <Button
                variant="secondary"
                size="sm"
                disabled={naoSalvo}
                title={naoSalvo ? 'Salve antes de imprimir' : ''}
                onClick={() => window.print()}
              >
                Imprimir
              </Button>
            }
          />
          <CardBody className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 dark:text-unno-muted border-b border-gray-200 dark:border-white/[.06]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Insumo</th>
                  <th className="text-right px-3 py-2 font-medium">Produção pede</th>
                  <th className="text-right px-3 py-2 font-medium">Com margem</th>
                  <th className="text-right px-3 py-2 font-medium">Tem</th>
                  <th className="text-right px-4 py-2 font-medium">Comprar</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map(l => (
                  <tr
                    key={l.insumo_id}
                    className="border-b border-gray-100 dark:border-white/[.04] last:border-0"
                  >
                    <td className="px-4 py-2">
                      <span className="text-gray-400 text-xs mr-1.5">{l.insumo_codigo}</span>
                      <span className="text-gray-900 dark:text-unno-text">{l.insumo_nome}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                      {fmt(l.consumo_bruto, 2)} {l.unidade}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                      {fmt(l.necessario, 2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                      {fmt(l.estoque_total, 2)}
                      {l.cobertura_pct != null && (
                        <span className="block text-xs text-gray-400">{l.cobertura_pct}%</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {l.comprar > 0 ? (
                        <>
                          <span className="font-semibold text-gray-900 dark:text-unno-text tabular-nums">
                            {fmt(l.comprar, 2)} {l.unidade}
                          </span>
                          {l.embalagens != null && (
                            <span className="block text-xs text-gray-500 dark:text-unno-dim">
                              {l.embalagens} × {fmt(l.tamanho_embalagem, 2)} {l.unidade}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-gray-400">tem o suficiente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Falta o tamanho da embalagem de compra: dá para pedir em kg, mas não
          dá para dizer quantos sacos. É cadastro, não conta. */}
      {semEmbalagem.length > 0 && (
        <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <p className="font-medium">
            {semEmbalagem.length} insumo(s) sem tamanho de embalagem cadastrado
          </p>
          <p className="text-xs mt-1">
            O pedido sai em peso, mas o sistema não sabe dizer quantos sacos ou caixas
            são. Preencha em Insumos → tamanho da embalagem:{' '}
            {semEmbalagem.map(l => l.insumo_codigo).join(', ')}.
          </p>
        </div>
      )}

      {/* ── Folha A4 ────────────────────────────────────────── */}
      <div className="pedido-print-target">
        <div style={{ marginBottom: '10px' }}>
          <h1 style={{ fontSize: '15pt', fontWeight: 700, margin: 0 }}>
            Pedido de Insumos
          </h1>
          <p className="small" style={{ margin: '3px 0 0' }}>
            {empresaNome && <>{empresaNome} · </>}
            Emitido em {hoje} · Margem de segurança de {margemSalva}%
          </p>
        </div>

        {conversoes.length > 0 && (
          <table style={{ marginBottom: '12px' }}>
            <thead>
              <tr>
                <th>Produto</th>
                <th className="num">Meta (un)</th>
                <th className="num">% do total</th>
                <th className="num">Formas</th>
                <th className="num">Bateladas</th>
              </tr>
            </thead>
            <tbody>
              {conversoes.map(c => (
                <tr key={c.ficha.id}>
                  <td><span className="mono">{c.ficha.codigo}</span> {c.ficha.nome}</td>
                  <td className="num">{fmt(c.unidades, 0)}</td>
                  <td className="num">{fmt(participacao(c.unidades), 1)}%</td>
                  <td className="num">{c.formas}</td>
                  <td className="num">{c.bateladas}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{fmt(totalUnidades, 0)}</strong></td>
                <td className="num">100%</td>
                <td className="num"><strong>{totalFormas}</strong></td>
                <td className="num">{Math.ceil(totalFormas / FORMAS_POR_BATELADA)}</td>
              </tr>
            </tbody>
          </table>
        )}

        <table>
          <colgroup>
            <col style={{ width: '9%' }} />
            <col style={{ width: '37%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Cód.</th>
              <th>Insumo</th>
              <th className="num">Precisa</th>
              <th className="num">Tem</th>
              <th className="num">Comprar</th>
            </tr>
          </thead>
          <tbody>
            {aComprar.map(l => (
              <tr key={l.insumo_id}>
                <td className="mono">{l.insumo_codigo}</td>
                <td>{l.insumo_nome}</td>
                <td className="num">{fmt(l.necessario, 2)} {l.unidade}</td>
                <td className="num">{fmt(l.estoque_total, 2)}</td>
                <td className="num">
                  <strong>{fmt(l.comprar, 2)} {l.unidade}</strong>
                  {l.embalagens != null && (
                    <div className="small">
                      {l.embalagens} × {fmt(l.tamanho_embalagem, 2)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="small" style={{ marginTop: '10px' }}>
          "Precisa" já inclui a margem. "Tem" soma o estoque central e o que está
          dentro dos recipientes da produção.
          {semEmbalagem.length > 0 && (
            <> Insumos sem número de embalagens ainda não têm o tamanho cadastrado.</>
          )}
        </p>

        <div style={{ marginTop: '22px', fontSize: '9pt' }}>
          <p className="caixa">Conferido por: ______________________________</p>
          <p className="caixa" style={{ marginTop: '12px' }}>
            Pedido enviado em: ____ / ____ / ________
          </p>
        </div>
      </div>
    </div>
  )
}

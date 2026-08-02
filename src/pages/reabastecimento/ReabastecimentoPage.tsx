import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'

/**
 * Planejamento de Reabastecimento — substitui a aba "Projeção de Produção
 * Mensal" da planilha.
 *
 * Responde a uma pergunta só: quanto pedir de cada insumo para aguentar até a
 * próxima entrega. A conta mora na view `v_reabastecimento` (migration 046):
 *
 *   consumo/dia = soma das fichas × formas por dia
 *   precisa     = consumo/dia × dias do período × (1 + margem)
 *   tem em casa = estoque central + o que está dentro dos recipientes
 *   comprar     = precisa − tem em casa
 *
 * O estoque soma os dois porque o açúcar que está no pote da produção é açúcar
 * que a padaria tem. Ignorá-lo encheria o depósito de coisa repetida.
 */

interface FichaOption {
  id: string
  codigo: string
  nome: string
}

interface LinhaReabastecimento {
  insumo_id: string
  insumo_codigo: string
  insumo_nome: string
  unidade: string
  dias_periodo: number
  margem_pct: number
  consumo_dia: number
  consumo_mes: number
  necessario_periodo: number
  estoque_ec: number
  estoque_ep: number
  estoque_total: number
  comprar: number
  tamanho_embalagem: number | null
  embalagens: number | null
  cobertura_dias: number | null
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
  const [formasDia, setFormasDia] = useState<Record<string, string>>({})
  const [dias, setDias] = useState('7')
  const [margem, setMargem] = useState('15')
  const [linhas, setLinhas] = useState<LinhaReabastecimento[]>([])
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [empresaNome, setEmpresaNome] = useState('')

  const carregarLinhas = useCallback(async () => {
    if (!profile) return
    const { data, error } = await supabase
      .from('v_reabastecimento')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .order('insumo_codigo')
    if (error) { setErro(error.message); return }
    setLinhas((data ?? []) as unknown as LinhaReabastecimento[])
  }, [profile])

  useEffect(() => {
    if (!profile) return

    async function carregar() {
      const [fichasRes, projRes, cfgRes, empRes] = await Promise.all([
        supabase
          .from('fichas_tecnicas')
          .select('id, codigo, nome')
          .eq('empresa_id', profile!.empresa_id)
          .eq('ativo', true)
          .eq('tipo', 'produto')
          .order('codigo'),
        supabase
          .from('projecao_producao')
          .select('ficha_id, formas_por_dia')
          .eq('empresa_id', profile!.empresa_id),
        supabase
          .from('configuracoes_sistema')
          .select('reabastecimento_dias, reabastecimento_margem_pct')
          .eq('empresa_id', profile!.empresa_id)
          .maybeSingle(),
        supabase
          .from('empresas')
          .select('nome')
          .eq('id', profile!.empresa_id)
          .maybeSingle(),
      ])

      setFichas((fichasRes.data ?? []) as FichaOption[])
      setFormasDia(Object.fromEntries(
        (projRes.data ?? []).map(p => [p.ficha_id, String(Number(p.formas_por_dia))]),
      ))
      if (cfgRes.data) {
        setDias(String(cfgRes.data.reabastecimento_dias))
        setMargem(String(Number(cfgRes.data.reabastecimento_margem_pct)))
      }
      setEmpresaNome(empRes.data?.nome ?? '')
      await carregarLinhas()
      setLoading(false)
    }

    carregar()
  }, [profile, carregarLinhas])

  /** Grava projeção e parâmetros, depois recarrega a lista do pedido. */
  async function salvar() {
    if (!profile) return
    setSalvando(true)
    setErro('')

    const { error: cfgErr } = await supabase
      .from('configuracoes_sistema')
      .update({
        reabastecimento_dias: parseInt(dias) || 7,
        reabastecimento_margem_pct: parseFloat(margem.replace(',', '.')) || 0,
      })
      .eq('empresa_id', profile.empresa_id)

    const { data, error } = await supabase.rpc('salvar_projecao', {
      p_empresa_id: profile.empresa_id,
      p_projecao: fichas.map(f => ({
        ficha_id: f.id,
        formas_por_dia: parseFloat((formasDia[f.id] ?? '').replace(',', '.')) || 0,
      })),
    })

    setSalvando(false)

    if (cfgErr || error || !(data as { ok?: boolean })?.ok) {
      setErro(cfgErr?.message ?? error?.message ?? 'Não foi possível salvar.')
      return
    }
    await carregarLinhas()
  }

  const totalFormasDia = useMemo(
    () => fichas.reduce(
      (s, f) => s + (parseFloat((formasDia[f.id] ?? '').replace(',', '.')) || 0), 0),
    [fichas, formasDia],
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
          Quanto pedir de cada insumo para cobrir o período até a próxima entrega
        </p>
      </div>

      {/* ── Projeção diária ─────────────────────────────────── */}
      <Card className="mb-4">
        <CardHeader
          title="Produção por dia"
          subtitle="Quantas formas de cada produto a padaria faz num dia normal"
        />
        <CardBody className="space-y-3">
          {fichas.map(f => (
            <div key={f.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-unno-text truncate">
                  {f.codigo} — {f.nome}
                </p>
              </div>
              <input
                type="number"
                min={0}
                step="0.5"
                inputMode="decimal"
                value={formasDia[f.id] ?? ''}
                onChange={e => setFormasDia(s => ({ ...s, [f.id]: e.target.value }))}
                placeholder="0"
                className="w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
              <span className="text-xs text-gray-400 w-14">formas</span>
            </div>
          ))}

          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-100 dark:border-white/[.06]">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                Entrega a cada (dias)
              </label>
              <input
                type="number" min={1} step={1} value={dias}
                onChange={e => setDias(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                Margem de segurança (%)
              </label>
              <input
                type="number" min={0} step={1} value={margem}
                onChange={e => setMargem(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
            </div>
          </div>

          {totalFormasDia > 0 && (
            <p className="text-xs text-gray-500 dark:text-unno-muted">
              {fmt(totalFormasDia, 1)} formas/dia no total
            </p>
          )}

          <Button onClick={salvar} loading={salvando} fullWidth>
            Salvar e recalcular
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
              Informe quantas formas por dia e salve para ver o pedido.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={`Pedido para ${dias} dias`}
            subtitle={`${aComprar.length} insumo(s) a comprar · margem de ${margem}%`}
            action={
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                Imprimir
              </Button>
            }
          />
          <CardBody className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 dark:text-unno-muted border-b border-gray-200 dark:border-white/[.06]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Insumo</th>
                  <th className="text-right px-3 py-2 font-medium">Por dia</th>
                  <th className="text-right px-3 py-2 font-medium">Precisa</th>
                  <th className="text-right px-3 py-2 font-medium">Tem</th>
                  <th className="text-right px-3 py-2 font-medium">Dura</th>
                  <th className="text-right px-4 py-2 font-medium">Comprar</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map(l => {
                  const urgente = (l.cobertura_dias ?? 0) < l.dias_periodo
                  return (
                    <tr
                      key={l.insumo_id}
                      className="border-b border-gray-100 dark:border-white/[.04] last:border-0"
                    >
                      <td className="px-4 py-2">
                        <span className="text-gray-400 text-xs mr-1.5">{l.insumo_codigo}</span>
                        <span className="text-gray-900 dark:text-unno-text">{l.insumo_nome}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                        {fmt(l.consumo_dia, 3)} {l.unidade}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                        {fmt(l.necessario_periodo, 2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted whitespace-nowrap">
                        {fmt(l.estoque_total, 2)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                        urgente ? 'text-red-600 font-medium' : 'text-gray-500'
                      }`}>
                        {l.cobertura_dias == null ? '—' : `${fmt(l.cobertura_dias, 1)} d`}
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
                  )
                })}
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
            O pedido sai em {linhas[0]?.unidade ?? 'kg'}, mas o sistema não sabe dizer
            quantos sacos ou caixas são. Preencha em Insumos → tamanho da embalagem:{' '}
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
            Emitido em {hoje} · Cobre {dias} dias com {margem}% de margem ·
            {' '}{fmt(totalFormasDia, 1)} formas/dia
          </p>
        </div>

        <table>
          <colgroup>
            <col style={{ width: '9%' }} />
            <col style={{ width: '35%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Cód.</th>
              <th>Insumo</th>
              <th className="num">Precisa</th>
              <th className="num">Tem</th>
              <th className="num">Comprar</th>
              <th className="num">Embalagens</th>
            </tr>
          </thead>
          <tbody>
            {aComprar.map(l => (
              <tr key={l.insumo_id}>
                <td className="mono">{l.insumo_codigo}</td>
                <td>{l.insumo_nome}</td>
                <td className="num">{fmt(l.necessario_periodo, 2)} {l.unidade}</td>
                <td className="num">{fmt(l.estoque_total, 2)}</td>
                <td className="num"><strong>{fmt(l.comprar, 2)} {l.unidade}</strong></td>
                <td className="num">
                  {l.embalagens != null
                    ? `${l.embalagens} × ${fmt(l.tamanho_embalagem, 2)}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="small" style={{ marginTop: '10px' }}>
          "Tem" soma o estoque central e o que está dentro dos recipientes da produção.
          {semEmbalagem.length > 0 && (
            <> Insumos com "—" em Embalagens ainda não têm o tamanho da embalagem cadastrado.</>
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

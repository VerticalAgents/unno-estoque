import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { formatDate } from '../../lib/utils'

interface SessaoRow {
  id: string
  codigo: string
  data_producao: string
  fator_perda_insumos: number | null
  fator_perda_produto: number | null
  skus: {
    quantidade_planejada: number
    quantidade_produzida: number | null
    quantidade_perdida: number | null
    quantidade_descartada_gramatura: number | null
    multiplicador: number | null
    ficha_tecnica: { nome: string; codigo: string }
  }[]
}

interface WeekBucket {
  label: string
  produzido: number
  perdaProduto: number
  count: number
}

export function HistoricoProducaoPage() {
  const { profile } = useAuth()
  const [sessoes, setSessoes] = useState<SessaoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [periodo, setPeriodo] = useState(90)
  const [filtroProduto, setFiltroProduto] = useState('')
  useEffect(() => {
    if (!profile) return
    setLoading(true)
    const desde = new Date()
    desde.setDate(desde.getDate() - periodo)

    supabase
      .from('sessoes_producao')
      .select(`
        id, codigo, data_producao, fator_perda_insumos, fator_perda_produto,
        skus:sessoes_producao_skus(
          quantidade_planejada, quantidade_produzida, quantidade_perdida,
          quantidade_descartada_gramatura, multiplicador,
          ficha_tecnica:fichas_tecnicas(nome, codigo)
        )
      `)
      .eq('empresa_id', profile.empresa_id)
      .eq('status', 'fechada')
      .gte('data_producao', desde.toISOString().split('T')[0])
      .order('data_producao', { ascending: false })
      .then(({ data }) => {
        setSessoes((data ?? []) as unknown as SessaoRow[])
        setLoading(false)
      })
  }, [profile, periodo])

  const produtosUnicos = [...new Set(sessoes.flatMap((s) => s.skus.map((sk) => sk.ficha_tecnica?.nome)).filter(Boolean))]

  const filtered = sessoes.filter((s) => {
    if (!filtroProduto) return true
    return s.skus.some((sk) => sk.ficha_tecnica?.nome === filtroProduto)
  })

  const totalProduzido = filtered.reduce((acc, s) => acc + s.skus.reduce((a, sk) => a + (sk.quantidade_produzida ?? 0), 0), 0)
  const sessoesComPerdaProd = filtered.filter((s) => s.fator_perda_produto != null)
  const mediaProduto = sessoesComPerdaProd.length > 0 ? sessoesComPerdaProd.reduce((a, s) => a + (s.fator_perda_produto ?? 0), 0) / sessoesComPerdaProd.length : 0

  // Build weekly production chart data
  const weekBuckets: WeekBucket[] = []
  if (filtered.length > 0) {
    const sortedByDate = [...filtered].sort((a, b) => a.data_producao.localeCompare(b.data_producao))
    const firstDate = new Date(sortedByDate[0].data_producao)
    const today = new Date()
    const weekStart = new Date(firstDate)
    weekStart.setDate(weekStart.getDate() - weekStart.getDay())

    while (weekStart <= today) {
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 6)
      const label = `${weekStart.getDate().toString().padStart(2, '0')}/${(weekStart.getMonth() + 1).toString().padStart(2, '0')}`
      const sessoesSemana = filtered.filter((s) => {
        const d = new Date(s.data_producao)
        return d >= weekStart && d <= weekEnd
      })
      const produzido = sessoesSemana.reduce((a, s) => a + s.skus.reduce((a2, sk) => a2 + (sk.quantidade_produzida ?? 0), 0), 0)
      const pp = sessoesSemana.filter((s) => s.fator_perda_produto != null)
      weekBuckets.push({
        label,
        produzido,
        perdaProduto: pp.length > 0 ? pp.reduce((a, s) => a + (s.fator_perda_produto ?? 0), 0) / pp.length : 0,
        count: sessoesSemana.length,
      })
      weekStart.setDate(weekStart.getDate() + 7)
    }
  }

  const maxProduzido = Math.max(...weekBuckets.map((w) => w.produzido), 1)

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Histórico de Produção</h1>
        <p className="text-sm text-gray-500 mt-0.5">Análise de produção e perdas ao longo do tempo</p>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <select value={periodo} onChange={(e) => setPeriodo(Number(e.target.value))} className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={180}>Últimos 6 meses</option>
          <option value={365}>Último ano</option>
        </select>
        <select value={filtroProduto} onChange={(e) => setFiltroProduto(e.target.value)} className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value="">Todos os produtos</option>
          {produtosUnicos.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Cards resumo */}
      {/* A perda de insumo saiu daqui: o fechamento passou a dar baixa pelo
          teórico (migration 063) e ela é apurada na auditoria de estoque. Ver
          Perdas. Manter o card mostrando 0% seria mentira confortável. */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Card className="p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total produzido</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalProduzido.toLocaleString()} un</p>
          <p className="text-xs text-gray-400">{filtered.length} sessões</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Perda média produto</p>
          <p className={`text-2xl font-bold mt-1 ${mediaProduto <= 3 ? 'text-emerald-600' : mediaProduto <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
            {mediaProduto.toFixed(1)}%
          </p>
        </Card>
      </div>

      {/* Gráfico de barras semanal */}
      {weekBuckets.length > 0 && (
        <Card className="p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">Produção por semana</h2>
          <div className="flex items-end gap-1 h-40">
            {weekBuckets.map((w, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <span className="text-xs text-gray-500 font-medium">{w.produzido > 0 ? w.produzido : ''}</span>
                <div
                  className={`w-full rounded-t transition-all ${w.produzido > 0 ? 'bg-brand-500' : 'bg-gray-100'}`}
                  style={{ height: `${Math.max((w.produzido / maxProduzido) * 100, 2)}%` }}
                  title={`${w.label}: ${w.produzido} un (${w.count} sessões)`}
                />
                <span className="text-xs text-gray-400 truncate w-full text-center">{w.label}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Tabela de sessões */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Sessão</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Produto</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Fornadas</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Planejado</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Produzido</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Perda prod.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((s) => {
                  const sku = s.skus[0]
                  const pp = s.fator_perda_produto
                  return (
                    <tr key={s.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-600">
                        {formatDate(s.data_producao)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{s.codigo}</td>
                      <td className="px-4 py-3 text-gray-800">{sku?.ficha_tecnica?.nome ?? '—'}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{sku?.multiplicador ?? 1}×</td>
                      <td className="px-4 py-3 text-right text-gray-600">{sku?.quantidade_planejada ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{sku?.quantidade_produzida ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        {pp != null ? (
                          <span className={`font-semibold ${pp <= 3 ? 'text-emerald-600' : pp <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
                            {pp.toFixed(1)}%
                          </span>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-400">Nenhuma sessão fechada neste período.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

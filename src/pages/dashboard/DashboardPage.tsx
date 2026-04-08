import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { EstoqueConsolidado, LoteVencendo, CategoriaInsumo } from '../../types/database.types'
import { Card, StatCard } from '../../components/ui/Card'
import { formatQty, daysUntil } from '../../lib/utils'

export function DashboardPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [estoque, setEstoque] = useState<EstoqueConsolidado[]>([])
  const [vencendo, setVencendo] = useState<LoteVencendo[]>([])
  const [categorias, setCategorias] = useState<CategoriaInsumo[]>([])
  const [producaoResumo, setProducaoResumo] = useState({ sessoes: 0, unidades: 0 })
  const [lotesSemEtiqueta, setLotesSemEtiqueta] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    const eid = profile.empresa_id

    Promise.all([
      supabase.from('v_estoque_consolidado').select('*').eq('empresa_id', eid),
      supabase.from('v_lotes_vencendo').select('*').eq('empresa_id', eid),
      supabase.from('categorias_insumo').select('*').eq('empresa_id', eid),
      supabase.from('sessoes_producao')
        .select('id, sessoes_producao_skus(quantidade_produzida)')
        .eq('empresa_id', eid)
        .eq('status', 'fechada')
        .gte('data_producao', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]),
      supabase.from('lotes')
        .select('id', { count: 'exact', head: true })
        .eq('empresa_id', eid)
        .eq('status', 'ativo')
        .eq('etiqueta_impressa', false),
    ]).then(([e, v, c, s, etq]) => {
      setEstoque((e.data ?? []) as EstoqueConsolidado[])
      setVencendo((v.data ?? []) as LoteVencendo[])
      setCategorias((c.data ?? []) as CategoriaInsumo[])
      const sess = s.data ?? []
      const unidades = sess.flatMap((ss: { sessoes_producao_skus: { quantidade_produzida: number | null }[] }) =>
        ss.sessoes_producao_skus.map((sk) => sk.quantidade_produzida ?? 0)
      ).reduce((a: number, b: number) => a + b, 0)
      setProducaoResumo({ sessoes: sess.length, unidades })
      setLotesSemEtiqueta(etq.count ?? 0)
      setLoading(false)
    })
  }, [profile])

  const catMap = Object.fromEntries(categorias.map((c) => [c.id, c]))
  const alertaReposicao = estoque.filter((e) => e.alerta_reposicao)
  const vencendo3 = vencendo.filter((v) => daysUntil(v.validade_pos_abertura) <= 3)
  const vencendo7 = vencendo.filter((v) => daysUntil(v.validade_pos_abertura) > 3)

  if (loading) return (
    <div className="flex justify-center py-16">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Visão geral do estoque e produção</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Insumos ativos" value={estoque.length} />
        <StatCard label="Alertas validade" value={vencendo.length} color={vencendo.length > 0 ? 'red' : 'green'} />
        <StatCard label="Alertas reposição" value={alertaReposicao.length} color={alertaReposicao.length > 0 ? 'yellow' : 'green'} />
        <StatCard label="Unid. prod. (30d)" value={producaoResumo.unidades} sub={`${producaoResumo.sessoes} sessões`} color="blue" />
      </div>

      {/* Etiquetas pendentes */}
      {lotesSemEtiqueta > 0 && (
        <button
          onClick={() => navigate('/recebimento')}
          className="w-full flex items-center justify-between gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {lotesSemEtiqueta} lote{lotesSemEtiqueta > 1 ? 's' : ''} sem etiqueta impressa
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Imprima as etiquetas para habilitar transferências e produção
              </p>
            </div>
          </div>
          <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      )}

      {/* Validade alerts */}
      {vencendo.length > 0 && (
        <Card>
          <div className="px-5 pt-4 pb-2 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">⚠️ Alertas de Validade (próximos 7 dias)</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {[...vencendo3, ...vencendo7].map((v) => {
              const days = daysUntil(v.validade_pos_abertura)
              return (
                <div key={v.lote_id} className="px-5 py-3 flex items-center justify-between text-sm">
                  <div>
                    <p className="font-medium text-gray-900">{v.insumo_nome}</p>
                    <p className="text-xs text-gray-400 font-mono">{v.lote_codigo} · {formatQty(v.quantidade_disponivel, v.unidade)}</p>
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${days <= 3 ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {days <= 0 ? 'Vencido' : `${days}d`}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Reposição alerts */}
      {alertaReposicao.length > 0 && (
        <Card>
          <div className="px-5 pt-4 pb-2 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">📦 Alertas de Reposição</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {alertaReposicao.map((e) => (
              <div key={e.insumo_id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-gray-900">{e.insumo_nome}</p>
                  <p className="text-xs text-gray-400">Mínimo: {formatQty(e.estoque_minimo ?? 0, e.unidade_medida)}</p>
                </div>
                <span className="text-xs font-bold text-yellow-700 bg-yellow-50 px-2 py-1 rounded-full">
                  {formatQty(e.qtd_total, e.unidade_medida)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Stock by category */}
      <Card>
        <div className="px-5 pt-4 pb-2 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Estoque Atual (EC + EP)</h2>
        </div>
        <div className="divide-y divide-gray-50">
          {estoque.map((e) => {
            const cat = catMap[e.insumo_id] ?? categorias.find((c) => c.nome)
            const catColor = cat?.cor_hex
            return (
              <div key={e.insumo_id} className="px-5 py-3 flex items-center gap-3 text-sm" style={{ borderLeft: catColor ? `3px solid ${catColor}` : undefined }}>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{e.insumo_nome}</p>
                  <p className="text-xs text-gray-400">
                    EC: {formatQty(e.qtd_estoque_central, e.unidade_medida)} · EP: {formatQty(e.qtd_estoque_produtivo, e.unidade_medida)}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-bold text-sm ${e.alerta_reposicao ? 'text-yellow-600' : 'text-gray-900'}`}>
                    {formatQty(e.qtd_total, e.unidade_medida)}
                  </p>
                </div>
              </div>
            )
          })}
          {estoque.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-gray-400">
              Nenhum insumo em estoque. Registre o primeiro recebimento.
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

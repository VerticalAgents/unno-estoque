import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { formatDate, formatDateTime, formatQty, daysUntil } from '../../lib/utils'
import type { UnidadeMedida, MotivoPerdaEnum } from '../../types/database.types'

type Tab = 'vencendo' | 'perdas' | 'perdasProducao' | 'expedicao' | 'rastreabilidade' | 'movimentacoes'

// ── Types ─────────────────────────────────────────────────────

interface LoteVencendo {
  lote_id: string
  lote_codigo: string
  insumo_nome: string
  validade_pos_abertura: string
  dias_para_vencer: number
  quantidade_disponivel: number
  unidade: UnidadeMedida
  status: string
}

interface PerdaRow {
  id: string
  codigo: string
  data: string
  quantidade: number
  unidade: UnidadeMedida
  motivo: MotivoPerdaEnum
  descricao: string | null
  insumo: { nome: string }
  lote: { codigo: string }
}

interface RastrRow {
  data_producao: string
  sessao_codigo: string
  produto_final: string
  quantidade_produzida: number | null
  quantidade_perdida: number | null
  fator_perda_pct: number | null
  insumo: string
  lote_codigo: string
  consumo_real: number | null
  consumo_teorico: number | null
  desvio: number | null
  recipiente_ep: string
}

interface MovRow {
  id: string
  codigo: string
  tipo: string
  data_hora: string
  observacoes: string | null
  responsavel: { nome: string }
}

const MOTIVO_LABELS: Record<MotivoPerdaEnum, string> = {
  vencimento: 'Vencimento',
  embalagem_danificada: 'Embalagem danif.',
  contaminacao: 'Contaminação',
  queda_acidente: 'Queda/Acidente',
  qualidade_reprovada: 'Qualidade',
  outro: 'Outro',
}

const TIPO_MOV_LABEL: Record<string, string> = {
  entrada: 'Entrada',
  transferencia: 'Transferência',
  reembalagem: 'Reembalagem',
  consumo_producao: 'Consumo Produção',
  perda_insumo: 'Perda',
  ajuste_inventario: 'Ajuste',
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

// ── Tab: Lotes Vencendo ───────────────────────────────────────

function LotesVencendoTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<LoteVencendo[]>([])
  const [loading, setLoading] = useState(true)
  const [dias, setDias] = useState(30)

  useEffect(() => {
    if (!profile) return
    setLoading(true)
    supabase
      .from('lotes')
      .select('id, codigo, insumo:insumos(nome), validade_pos_abertura, quantidade_disponivel, unidade, status')
      .eq('empresa_id', profile.empresa_id)
      .eq('status', 'ativo')
      .order('validade_pos_abertura')
      .then(({ data }) => {
        const hoje = new Date()
        hoje.setHours(0, 0, 0, 0)
        const limite = new Date(hoje)
        limite.setDate(limite.getDate() + dias)

        const mapeado = ((data ?? []) as unknown as { id: string; codigo: string; insumo: { nome: string }; validade_pos_abertura: string; quantidade_disponivel: number; unidade: UnidadeMedida; status: string }[])
          .map((l) => ({
            lote_id: l.id,
            lote_codigo: l.codigo,
            insumo_nome: l.insumo?.nome ?? '',
            validade_pos_abertura: l.validade_pos_abertura,
            dias_para_vencer: daysUntil(l.validade_pos_abertura),
            quantidade_disponivel: l.quantidade_disponivel,
            unidade: l.unidade,
            status: l.status,
          }))
          .filter((l) => l.dias_para_vencer <= dias)

        setRows(mapeado)
        setLoading(false)
      })
  }, [profile, dias])

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-gray-600">Exibir lotes que vencem em até</label>
        <select
          value={dias}
          onChange={(e) => setDias(Number(e.target.value))}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value={7}>7 dias</option>
          <option value={14}>14 dias</option>
          <option value={30}>30 dias</option>
          <option value={60}>60 dias</option>
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Insumo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lote</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Validade</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Dias</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd disp.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const vencido = r.dias_para_vencer < 0
                  const urgente = r.dias_para_vencer <= 3
                  const alerta = r.dias_para_vencer <= 7
                  return (
                    <tr key={r.lote_id} className={vencido ? 'bg-red-50' : urgente ? 'bg-orange-50' : alerta ? 'bg-yellow-50' : 'hover:bg-gray-50'}>
                      <td className="px-4 py-3 font-medium text-gray-900">{r.insumo_nome}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.lote_codigo}</td>
                      <td className="px-4 py-3 text-gray-700">{formatDate(r.validade_pos_abertura)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`font-bold text-sm ${vencido ? 'text-red-700' : urgente ? 'text-orange-700' : alerta ? 'text-yellow-700' : 'text-gray-600'}`}>
                          {vencido ? 'VENCIDO' : r.dias_para_vencer === 0 ? 'HOJE' : `${r.dias_para_vencer}d`}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{formatQty(r.quantidade_disponivel, r.unidade)}</td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Nenhum lote a vencer neste período.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Tab: Histórico de Perdas ──────────────────────────────────

function PerdasTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<PerdaRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filtroMotivo, setFiltroMotivo] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('perdas_insumo')
      .select('*, insumo:insumos(nome), lote:lotes(codigo)')
      .eq('empresa_id', profile.empresa_id)
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as PerdaRow[])
        setLoading(false)
      })
  }, [profile])

  const filtered = rows.filter((r) => !filtroMotivo || r.motivo === filtroMotivo)

  const totalPorMotivo = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.motivo] = (acc[r.motivo] ?? 0) + 1
    return acc
  }, {})

  return (
    <div>
      {/* Summary cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          {Object.entries(totalPorMotivo).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([motivo, count]) => (
            <div key={motivo} className="bg-white border border-gray-200 rounded-lg p-3">
              <p className="text-xs text-gray-500">{MOTIVO_LABELS[motivo as MotivoPerdaEnum]}</p>
              <p className="text-xl font-bold text-gray-900">{count}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4">
        <select
          value={filtroMotivo}
          onChange={(e) => setFiltroMotivo(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm"
        >
          <option value="">Todos os motivos</option>
          {Object.entries(MOTIVO_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Insumo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lote</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Motivo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Descrição</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{formatDate(r.data)}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.insumo?.nome}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.lote?.codigo}</td>
                    <td className="px-4 py-3 text-right font-semibold text-red-700">
                      -{formatQty(r.quantidade, r.unidade)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700">
                        {MOTIVO_LABELS[r.motivo]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.descricao ?? '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Nenhuma perda registrada.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Tab: Perdas de Produção ───────────────────────────────────

interface PerdasProducaoRow {
  id: string
  codigo: string
  data_producao: string
  fator_perda_insumos: number | null
  fator_perda_produto: number | null
  skus: { quantidade_planejada: number; quantidade_produzida: number | null; ficha_tecnica: { nome: string } }[]
}

function PerdasProducaoTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<PerdasProducaoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [periodo, setPeriodo] = useState(30)

  useEffect(() => {
    if (!profile) return
    setLoading(true)
    const desde = new Date()
    desde.setDate(desde.getDate() - periodo)
    supabase
      .from('sessoes_producao')
      .select('id, codigo, data_producao, fator_perda_insumos, fator_perda_produto, skus:sessoes_producao_skus(quantidade_planejada, quantidade_produzida, ficha_tecnica:fichas_tecnicas(nome))')
      .eq('empresa_id', profile.empresa_id)
      .eq('status', 'fechada')
      .gte('data_producao', desde.toISOString().split('T')[0])
      .order('data_producao', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as PerdasProducaoRow[])
        setLoading(false)
      })
  }, [profile, periodo])

  const mediaPerdaInsumos = rows.filter((r) => r.fator_perda_insumos != null).reduce((acc, r, _, arr) => acc + (r.fator_perda_insumos! / arr.length), 0)
  const mediaPerdaProduto = rows.filter((r) => r.fator_perda_produto != null).reduce((acc, r, _, arr) => acc + (r.fator_perda_produto! / arr.length), 0)
  const comDados = rows.filter((r) => r.fator_perda_insumos != null).length

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-gray-600">Período</label>
        <select
          value={periodo}
          onChange={(e) => setPeriodo(Number(e.target.value))}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={365}>Último ano</option>
        </select>
      </div>

      {comDados > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <p className="text-xs text-gray-500">Média perda insumos</p>
            <p className={`text-2xl font-bold ${mediaPerdaInsumos <= 3 ? 'text-emerald-600' : mediaPerdaInsumos <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
              {mediaPerdaInsumos.toFixed(1)}%
            </p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <p className="text-xs text-gray-500">Média perda produto</p>
            <p className={`text-2xl font-bold ${mediaPerdaProduto <= 3 ? 'text-emerald-600' : mediaPerdaProduto <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
              {mediaPerdaProduto.toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Sessão</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Produto</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Produzido</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Perda insumos</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Perda produto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const produzido = (r.skus ?? []).reduce((acc, s) => acc + (s.quantidade_produzida ?? 0), 0)
                  const produto = (r.skus ?? []).map((s) => s.ficha_tecnica?.nome).filter(Boolean).join(', ')
                  const pi = r.fator_perda_insumos
                  const pp = r.fator_perda_produto
                  return (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-600">{formatDate(r.data_producao)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.codigo}</td>
                      <td className="px-4 py-3 text-gray-800">{produto}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{produzido > 0 ? `${produzido} un` : '—'}</td>
                      <td className="px-4 py-3 text-right">
                        {pi != null ? (
                          <span className={`font-semibold ${pi <= 3 ? 'text-emerald-600' : pi <= 8 ? 'text-yellow-600' : 'text-red-600'}`}>
                            {pi.toFixed(1)}%
                          </span>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
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
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Nenhuma sessão fechada neste período.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Tab: Expedição ───────────────────────────────────────────

interface ExpRelRow {
  id: string
  codigo: string
  data_expedicao: string
  destinatario: string | null
  itens: { quantidade: number; produto: { nome: string }; lote_produto: { data_producao: string; codigo: string } }[]
}

function ExpedicaoTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<ExpRelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [periodo, setPeriodo] = useState(30)

  useEffect(() => {
    if (!profile) return
    setLoading(true)
    const desde = new Date()
    desde.setDate(desde.getDate() - periodo)
    supabase
      .from('expedicoes')
      .select('id, codigo, data_expedicao, destinatario, itens:expedicoes_itens(quantidade, produto:produtos(nome), lote_produto:lotes_produto(data_producao, codigo))')
      .eq('empresa_id', profile.empresa_id)
      .eq('status', 'expedida')
      .gte('data_expedicao', desde.toISOString().split('T')[0])
      .order('data_expedicao', { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as unknown as ExpRelRow[])
        setLoading(false)
      })
  }, [profile, periodo])

  const totalExpedido = rows.reduce((a, r) => a + r.itens.reduce((a2, it) => a2 + it.quantidade, 0), 0)
  const diasDesdeProducao: number[] = []
  for (const r of rows) {
    for (const it of r.itens) {
      if (it.lote_produto?.data_producao) {
        const diff = Math.floor((new Date(r.data_expedicao).getTime() - new Date(it.lote_produto.data_producao).getTime()) / 86400000)
        diasDesdeProducao.push(diff)
      }
    }
  }
  const tempoMedio = diasDesdeProducao.length > 0 ? diasDesdeProducao.reduce((a, b) => a + b, 0) / diasDesdeProducao.length : null

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-gray-600">Período</label>
        <select value={periodo} onChange={(e) => setPeriodo(Number(e.target.value))} className="px-2 py-1 rounded border border-gray-300 text-sm">
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
          <option value={365}>Último ano</option>
        </select>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white border border-gray-200 rounded-lg p-3">
          <p className="text-xs text-gray-500">Total expedido</p>
          <p className="text-2xl font-bold text-gray-900">{totalExpedido.toLocaleString()} un</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3">
          <p className="text-xs text-gray-500">Expedições</p>
          <p className="text-2xl font-bold text-gray-900">{rows.length}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3">
          <p className="text-xs text-gray-500">Tempo médio prod.→exp.</p>
          <p className="text-2xl font-bold text-gray-900">{tempoMedio !== null ? `${tempoMedio.toFixed(1)}d` : '—'}</p>
        </div>
      </div>

      {loading ? <Spinner /> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Código</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Destinatário</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Produto</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Dias desde prod.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => r.itens.map((it, i) => {
                  const diasProd = it.lote_produto?.data_producao
                    ? Math.floor((new Date(r.data_expedicao).getTime() - new Date(it.lote_produto.data_producao).getTime()) / 86400000)
                    : null
                  return (
                    <tr key={`${r.id}-${i}`} className="hover:bg-gray-50">
                      {i === 0 && (
                        <>
                          <td className="px-4 py-3 text-gray-600" rowSpan={r.itens.length}>{formatDate(r.data_expedicao)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500" rowSpan={r.itens.length}>{r.codigo}</td>
                          <td className="px-4 py-3 text-gray-700" rowSpan={r.itens.length}>{r.destinatario ?? '—'}</td>
                        </>
                      )}
                      <td className="px-4 py-3 text-gray-800">{it.produto?.nome ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{it.quantidade} un</td>
                      <td className="px-4 py-3 text-right text-gray-600">{diasProd !== null ? `${diasProd}d` : '—'}</td>
                    </tr>
                  )
                })).flat()}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Nenhuma expedição neste período.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Tab: Rastreabilidade de Produção ─────────────────────────

function RastreabilidadeTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<RastrRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('v_rastreabilidade_producao')
      .select('*')
      .order('data_producao', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setRows((data ?? []) as unknown as RastrRow[])
        setLoading(false)
      })
  }, [profile])

  // Group by sessao_codigo
  const grouped = rows.reduce<Record<string, RastrRow[]>>((acc, r) => {
    if (!acc[r.sessao_codigo]) acc[r.sessao_codigo] = []
    acc[r.sessao_codigo].push(r)
    return acc
  }, {})

  return (
    <div>
      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <div className="px-4 py-8 text-center text-gray-400">
            Nenhuma sessão fechada encontrada.
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([sessao, linhas]) => {
            const primeiraLinha = linhas[0]
            const produtos = [...new Set(linhas.map((l) => l.produto_final))]
            return (
              <Card key={sessao}>
                <div className="px-4 py-3 border-b border-gray-100">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-gray-900">{sessao}</p>
                      <p className="text-xs text-gray-400">{formatDate(primeiraLinha.data_producao)} · {produtos.join(', ')}</p>
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left bg-gray-50">
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ingrediente</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lote</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Teórico</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Real</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Desvio</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Recipiente</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {linhas.map((l, i) => {
                        const desvio = l.desvio ?? 0
                        const desvioClass = Math.abs(desvio) <= 0 ? 'text-gray-400' : desvio > 0 ? 'text-red-600' : 'text-emerald-600'
                        return (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-4 py-2.5 font-medium text-gray-900">{l.insumo}</td>
                            <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{l.lote_codigo}</td>
                            <td className="px-4 py-2.5 text-right text-gray-600">{l.consumo_teorico?.toFixed(3) ?? '—'}</td>
                            <td className="px-4 py-2.5 text-right text-gray-800 font-medium">{l.consumo_real?.toFixed(3) ?? '—'}</td>
                            <td className={`px-4 py-2.5 text-right font-medium ${desvioClass}`}>
                              {l.desvio != null ? (desvio >= 0 ? '+' : '') + desvio.toFixed(3) : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-500">{l.recipiente_ep}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Tab: Movimentações ────────────────────────────────────────

function MovimentacoesTab() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<MovRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filtroTipo, setFiltroTipo] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('movimentacoes')
      .select('id, codigo, tipo, data_hora, observacoes, responsavel:usuarios(nome)')
      .eq('empresa_id', profile.empresa_id)
      .order('data_hora', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setRows((data ?? []) as unknown as MovRow[])
        setLoading(false)
      })
  }, [profile])

  const filtered = rows.filter((r) => !filtroTipo || r.tipo === filtroTipo)

  const tipoBadgeClass: Record<string, string> = {
    entrada: 'bg-emerald-50 text-emerald-700',
    transferencia: 'bg-blue-50 text-blue-700',
    reembalagem: 'bg-purple-50 text-purple-700',
    consumo_producao: 'bg-orange-50 text-orange-700',
    perda_insumo: 'bg-red-50 text-red-700',
    ajuste_inventario: 'bg-gray-100 text-gray-600',
  }

  return (
    <div>
      <div className="mb-4">
        <select
          value={filtroTipo}
          onChange={(e) => setFiltroTipo(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm"
        >
          <option value="">Todos os tipos</option>
          {Object.entries(TIPO_MOV_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data/Hora</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Código</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tipo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Responsável</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Obs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600 text-xs">{formatDateTime(r.data_hora)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.codigo}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${tipoBadgeClass[r.tipo] ?? 'bg-gray-100 text-gray-600'}`}>
                        {TIPO_MOV_LABEL[r.tipo] ?? r.tipo}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.responsavel?.nome ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{r.observacoes ?? '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Nenhuma movimentação encontrada.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'vencendo', label: 'Lotes Vencendo' },
  { id: 'perdas', label: 'Perdas de Insumos' },
  { id: 'perdasProducao', label: 'Perdas de Produção' },
  { id: 'expedicao', label: 'Expedição' },
  { id: 'rastreabilidade', label: 'Rastreabilidade' },
  { id: 'movimentacoes', label: 'Movimentações' },
]

export function RelatoriosPage() {
  const [activeTab, setActiveTab] = useState<Tab>('vencendo')

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Relatórios</h1>
        <p className="text-sm text-gray-500 mt-0.5">Rastreabilidade, perdas e movimentações</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex-shrink-0 px-4 py-2 rounded-md text-sm font-medium transition-colors',
              activeTab === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'vencendo' && <LotesVencendoTab />}
      {activeTab === 'perdas' && <PerdasTab />}
      {activeTab === 'perdasProducao' && <PerdasProducaoTab />}
      {activeTab === 'expedicao' && <ExpedicaoTab />}
      {activeTab === 'rastreabilidade' && <RastreabilidadeTab />}
      {activeTab === 'movimentacoes' && <MovimentacoesTab />}
    </div>
  )
}

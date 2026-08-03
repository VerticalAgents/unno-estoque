import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate, formatQty } from '../../lib/utils'
import type { MotivoPerdaEnum, UnidadeMedida } from '../../types/database.types'

/**
 * A fábrica perde de três jeitos, e antes esta página mostrava só um.
 *
 *   1. Insumo que some entre duas auditorias — merma de processo, sobra que
 *      ninguém raspou, pesagem imprecisa. É o número que pesa no custo.
 *   2. Insumo descartado por um motivo conhecido — venceu, caiu, contaminou.
 *   3. Produto descartado na pós-produção — quebrado, cru, fora de gramatura.
 *
 * São origens diferentes e não se somam: um está em quilos de insumo, outro em
 * unidades de brownie. Ficam lado a lado, cada um com a sua unidade.
 */

// ── Tipos ────────────────────────────────────────────────────

/** `v_perda_auditoria` (migration 066). */
interface PerdaAuditoria {
  contagem_id: string
  tipo: 'ec' | 'ep'
  data: string
  insumo_codigo: string
  insumo_nome: string
  unidade_medida: UnidadeMedida
  categoria: string | null
  categoria_cor: string | null
  teorico: number
  fisico: number
  perda: number
  perda_pct: number | null
}

interface PerdaRow {
  id: string
  codigo: string
  data: string
  quantidade: number
  unidade: UnidadeMedida
  motivo: MotivoPerdaEnum
  descricao: string | null
  insumo: { nome: string; codigo: string }
  lote: { codigo: string }
  local: { nome: string } | null
}

interface DescarteProduto {
  quantidade: number
  motivo: { nome: string } | null
  pos: { data: string } | null
}

const MOTIVO_LABELS: Record<MotivoPerdaEnum, string> = {
  vencimento: 'Vencimento',
  embalagem_danificada: 'Embalagem danificada',
  contaminacao: 'Contaminação',
  queda_acidente: 'Queda / Acidente',
  qualidade_reprovada: 'Qualidade reprovada',
  outro: 'Outro',
}

const TIPO_LABEL: Record<'ec' | 'ep', string> = {
  ep: 'Estoque produtivo (produção)',
  ec: 'Estoque central (armazém)',
}

/** Mesma escala do resto do sistema. */
function corPct(pct: number): string {
  return pct <= 3 ? 'text-emerald-600' : pct <= 8 ? 'text-yellow-600' : 'text-red-600'
}

// ── Página ───────────────────────────────────────────────────

export function PerdaListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [auditoria, setAuditoria] = useState<PerdaAuditoria[]>([])
  const [perdas, setPerdas] = useState<PerdaRow[]>([])
  const [produto, setProduto] = useState<DescarteProduto[]>([])
  const [loading, setLoading] = useState(true)
  const [filtroMotivo, setFiltroMotivo] = useState('')
  const [tipoAuditoria, setTipoAuditoria] = useState<'ep' | 'ec'>('ep')

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase.from('v_perda_auditoria').select('*').order('data', { ascending: false }),
      supabase.from('perdas_insumo')
        .select('*, insumo:insumos(nome, codigo), lote:lotes(codigo), local:locais(nome)')
        .eq('empresa_id', profile.empresa_id)
        .order('data', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('pos_producao_descartes')
        .select('quantidade, motivo:motivos_descarte(nome), pos:pos_producao(data)'),
    ]).then(([a, p, d]) => {
      setAuditoria((a.data ?? []) as unknown as PerdaAuditoria[])
      setPerdas((p.data ?? []) as unknown as PerdaRow[])
      setProduto((d.data ?? []) as unknown as DescarteProduto[])
      setLoading(false)
    })
  }, [profile])

  // ── Auditoria: uma linha por insumo, uma coluna por auditoria ──
  const doTipo = auditoria.filter(a => a.tipo === tipoAuditoria)
  const datas = [...new Set(doTipo.map(a => a.data))].sort().reverse().slice(0, 6)
  const porInsumo = new Map<string, { nome: string; cor: string | null; unidade: string; pct: Map<string, number | null>; perdas: number[] }>()
  for (const a of doTipo) {
    const g = porInsumo.get(a.insumo_codigo) ?? {
      nome: a.insumo_nome, cor: a.categoria_cor, unidade: a.unidade_medida,
      pct: new Map<string, number | null>(), perdas: [] as number[],
    }
    g.pct.set(a.data, a.perda_pct === null ? null : Number(a.perda_pct))
    if (a.perda_pct !== null) g.perdas.push(Number(a.perda_pct))
    porInsumo.set(a.insumo_codigo, g)
  }
  const linhasAuditoria = [...porInsumo.entries()]
    .map(([codigo, g]) => ({
      codigo, ...g,
      media: g.perdas.length > 0 ? g.perdas.reduce((x, y) => x + y, 0) / g.perdas.length : null,
    }))
    // Maior perda primeiro: é o que se quer ver, não a ordem do cadastro.
    .sort((x, y) => (y.media ?? -Infinity) - (x.media ?? -Infinity))

  const filtered = perdas.filter((p) => filtroMotivo === '' || p.motivo === filtroMotivo)

  // ── Produto: agrupado por motivo ──
  const porMotivo = new Map<string, number>()
  for (const d of produto) {
    const nome = d.motivo?.nome ?? 'Sem motivo'
    porMotivo.set(nome, (porMotivo.get(nome) ?? 0) + (d.quantidade ?? 0))
  }
  const linhasProduto = [...porMotivo.entries()].sort((a, b) => b[1] - a[1])
  const totalProduto = linhasProduto.reduce((a, [, q]) => a + q, 0)

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Perdas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Insumo apurado na auditoria, descartes de insumo e descartes de produto
          </p>
        </div>
        <Button onClick={() => navigate('/perdas/nova')}>
          + Registrar Perda
        </Button>
      </div>

      {/* ── 1. Insumo — auditoria ───────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Insumo — auditoria de estoque
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Diferença entre o que o sistema esperava e o que a contagem encontrou
            </p>
          </div>
          {/* EP e EC medem coisas diferentes e não se somam: um é a perda de
              produção, o outro a do armazém. */}
          <select
            value={tipoAuditoria}
            onChange={(e) => setTipoAuditoria(e.target.value as 'ep' | 'ec')}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="ep">{TIPO_LABEL.ep}</option>
            <option value="ec">{TIPO_LABEL.ec}</option>
          </select>
        </div>

        <Card>
          {linhasAuditoria.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              Nenhuma auditoria aplicada ainda. Faça uma contagem em{' '}
              <button onClick={() => navigate('/contagem')} className="text-brand-600 underline">
                Contagem
              </button>{' '}
              e aplique o resultado — é dela que sai este número.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left">
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Insumo</th>
                    {datas.map(d => (
                      <th key={d} className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right whitespace-nowrap">
                        {formatDate(d)}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Média</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {linhasAuditoria.map((l) => (
                    <tr key={l.codigo} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                          style={{ backgroundColor: l.cor ?? '#9ca3af' }}
                        />
                        <span className="text-gray-900">{l.nome}</span>
                        <span className="text-xs text-gray-400 ml-1.5">{l.codigo}</span>
                      </td>
                      {datas.map(d => {
                        const pct = l.pct.get(d)
                        return (
                          <td key={d} className="px-3 py-3 text-right tabular-nums">
                            {pct == null ? <span className="text-gray-300">—</span> : (
                              <span className={corPct(pct)}>
                                {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-4 py-3 text-right tabular-nums">
                        {l.media == null ? <span className="text-gray-300">—</span> : (
                          <span className={`font-semibold ${corPct(l.media)}`}>
                            {l.media > 0 ? '+' : ''}{l.media.toFixed(1)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* ── 2. Insumo — descartes avulsos ───────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Insumo — descartes registrados
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Vencimento, contaminação, queda — com lote identificado
            </p>
          </div>
          <select
            value={filtroMotivo}
            onChange={(e) => setFiltroMotivo(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Todos os motivos</option>
            {Object.entries(MOTIVO_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Código</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Insumo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lote</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Motivo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Local</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-600">{formatDate(p.data)}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">{p.codigo}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{p.insumo?.nome}</p>
                      <p className="text-xs text-gray-400">{p.insumo?.codigo}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{p.lote?.codigo}</td>
                    <td className="px-4 py-3 text-right font-semibold text-red-700">
                      -{formatQty(p.quantidade, p.unidade)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700">
                        {MOTIVO_LABELS[p.motivo]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{p.local?.nome ?? '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                      Nenhum descarte registrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ── 3. Produto — pós-produção ───────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
          Produto — descartes na pós-produção
        </h2>
        <Card>
          {linhasProduto.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              Nenhum descarte de produto registrado ainda.
            </p>
          ) : (
            <div className="p-4 space-y-2">
              {linhasProduto.map(([motivo, qtd]) => (
                <div key={motivo} className="flex items-center gap-3">
                  <span className="text-sm text-gray-700 w-48 shrink-0 truncate">{motivo}</span>
                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-red-400"
                      style={{ width: `${totalProduto > 0 ? (qtd / totalProduto) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-sm tabular-nums text-gray-700 w-24 text-right">
                    {qtd.toLocaleString()} un
                  </span>
                </div>
              ))}
              <p className="text-xs text-gray-500 pt-2 border-t border-gray-100">
                Total descartado: <strong>{totalProduto.toLocaleString()} unidades</strong>
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { EstoqueConsolidado, CategoriaInsumo } from '../../types/database.types'
import { Card } from '../../components/ui/Card'
import { CartaoLista, ListaResponsiva, ListaVazia } from '../../components/ui/ListaResponsiva'
import { formatQty, formatDate, daysUntil } from '../../lib/utils'
import { InsumoDetalhePanel } from './InsumoDetalhePanel'
import { combina } from '../../lib/busca'

/** Selo curto de alerta, do tamanho de caber três lado a lado num cartão. */
function Selo({ cor, children }: { cor: 'amber' | 'blue' | 'purple'; children: React.ReactNode }) {
  const cores = {
    amber: 'bg-amber-100 text-amber-700 dark:bg-unno-amber/15 dark:text-unno-amber',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
    purple: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
  }
  return (
    <span className={`px-1.5 py-0.5 rounded text-[0.65rem] font-medium ${cores[cor]}`}>
      {children}
    </span>
  )
}

// Validade mais próxima do vencimento por insumo
type ValidadeInfo = {
  insumo_id: string
  validade_ec: string | null   // validade_original do lote ativo mais próximo em EC
  validade_ep: string | null   // validade_ep do recipiente EP mais próximo
}

function validadeClass(date: string | null): string {
  if (!date) return 'text-gray-400'
  const days = daysUntil(date)
  if (days < 0) return 'text-red-600 font-semibold'
  if (days <= 30) return 'text-red-600 font-semibold'
  if (days <= 60) return 'text-yellow-600 font-semibold'
  return 'text-gray-700'
}

export function EstoquePage() {
  const { profile } = useAuth()
  const [estoque, setEstoque] = useState<EstoqueConsolidado[]>([])
  const [categorias, setCategorias] = useState<CategoriaInsumo[]>([])
  const [validades, setValidades] = useState<Record<string, ValidadeInfo>>({})
  const [filtroCategoria, setFiltroCategoria] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [insumoSelecionado, setInsumoSelecionado] = useState<EstoqueConsolidado | null>(null)
  const [insumosSemEtiqueta, setInsumosSemEtiqueta] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!profile) return
    const eid = profile.empresa_id
    Promise.all([
      supabase.from('v_estoque_consolidado').select('*').eq('empresa_id', eid),
      supabase.from('categorias_insumo').select('*, insumos(id)').eq('empresa_id', eid),
      // Validade EC: lote ativo com menor validade_original por insumo
      supabase
        .from('lotes')
        .select('insumo_id, validade_original')
        .eq('empresa_id', eid)
        .eq('status', 'ativo')
        .order('validade_original', { ascending: true }),
      // Validade EP: validade_ep de locais_estado_atual (via lote) mais próxima
      supabase
        .from('locais_estado_atual')
        .select('validade_ep, lote:lotes!inner(insumo_id, empresa_id)')
        .eq('lote.empresa_id', eid)
        .not('validade_ep', 'is', null)
        .order('validade_ep', { ascending: true }),
      // Lotes ativos sem etiqueta impressa
      supabase
        .from('lotes')
        .select('insumo_id')
        .eq('empresa_id', eid)
        .eq('status', 'ativo')
        .eq('etiqueta_impressa', false),
    ]).then(([e, c, lotesEc, lotesEp, semEtiqueta]) => {
      setEstoque((e.data ?? []) as EstoqueConsolidado[])
      setCategorias((c.data ?? []) as CategoriaInsumo[])

      // Agrupa validade EC por insumo (a mais próxima)
      const ecMap: Record<string, string> = {}
      for (const l of (lotesEc.data ?? []) as { insumo_id: string; validade_original: string }[]) {
        if (!ecMap[l.insumo_id]) ecMap[l.insumo_id] = l.validade_original
      }

      // Agrupa validade EP por insumo (a mais próxima)
      const epMap: Record<string, string> = {}
      for (const row of (lotesEp.data ?? []) as unknown as { validade_ep: string; lote: { insumo_id: string } }[]) {
        const insumoId = row.lote?.insumo_id
        if (insumoId && !epMap[insumoId]) epMap[insumoId] = row.validade_ep
      }

      const combined: Record<string, ValidadeInfo> = {}
      const allIds = new Set([...Object.keys(ecMap), ...Object.keys(epMap)])
      for (const id of allIds) {
        combined[id] = { insumo_id: id, validade_ec: ecMap[id] ?? null, validade_ep: epMap[id] ?? null }
      }
      setValidades(combined)

      const semEtiquetaSet = new Set(
        ((semEtiqueta.data ?? []) as { insumo_id: string }[]).map(l => l.insumo_id)
      )
      setInsumosSemEtiqueta(semEtiquetaSet)
      setLoading(false)
    })
  }, [profile])

  type InsumoMeta = { id: string; categoria_id: string; estoque_minimo_ec?: number; estoque_maximo_ec?: number; estoque_minimo_ep?: number; estoque_maximo_ep?: number }
  const [insumosMeta, setInsumosMeta] = useState<Record<string, InsumoMeta>>({})
  useEffect(() => {
    if (!profile) return
    supabase.from('insumos').select('id, categoria_id, estoque_minimo_ec, estoque_maximo_ec, estoque_minimo_ep, estoque_maximo_ep').eq('empresa_id', profile.empresa_id)
      .then(({ data }) => {
        const map: Record<string, InsumoMeta> = {}
        ;(data ?? []).forEach((i: InsumoMeta) => { map[i.id] = i })
        setInsumosMeta(map)
      })
  }, [profile])

  const catMap = Object.fromEntries(categorias.map((c) => [c.id, c]))

  const filtered = estoque.filter((e) => {
    const matchSearch = combina(search, e.insumo_nome)
    const cat = insumosMeta[e.insumo_id]?.categoria_id
    const matchCat = filtroCategoria === '' || cat === filtroCategoria
    return matchSearch && matchCat
  })

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Estoque</h1>
        <p className="text-sm text-gray-500 mt-0.5">Posição atual por insumo (EC + EP)</p>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input type="search" placeholder="Buscar insumo..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <select value={filtroCategoria} onChange={(e) => setFiltroCategoria(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">Todas as categorias</option>
          {categorias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </div>

      {/* Legenda de validade */}
      <div className="flex gap-4 mb-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Vence em ≤ 30 dias</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> Vence em ≤ 60 dias</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" /></div>
      ) : (
        <Card>
          <ListaResponsiva
            cartoes={
              filtered.length === 0
                ? <ListaVazia>Nenhum insumo encontrado.</ListaVazia>
                : filtered.map(e => {
                    const meta = insumosMeta[e.insumo_id]
                    const cat = catMap[meta?.categoria_id ?? '']
                    const val = validades[e.insumo_id]
                    const alertaEC = meta?.estoque_minimo_ec != null && e.qtd_estoque_central < meta.estoque_minimo_ec
                    const alertaEP = meta?.estoque_minimo_ep != null && e.qtd_estoque_produtivo < meta.estoque_minimo_ep
                    const alertaEtiqueta = insumosSemEtiqueta.has(e.insumo_id)
                    return (
                      <CartaoLista
                        key={e.insumo_id}
                        onClick={() => setInsumoSelecionado(e)}
                        alerta={alertaEC || alertaEP || e.alerta_reposicao || alertaEtiqueta}
                        titulo={
                          <>
                            {cat?.cor_hex && (
                              <span className="w-2 h-2 mt-1.5 rounded-full shrink-0" style={{ backgroundColor: cat.cor_hex }} />
                            )}
                            <span className="font-medium text-gray-900 dark:text-unno-text">{e.insumo_nome}</span>
                          </>
                        }
                        subtitulo={`${e.insumo_codigo}${cat?.nome ? ` · ${cat.nome}` : ''}`}
                        // O total é o que se procura de relance; o resto é detalhe.
                        destaque={formatQty(e.qtd_total, e.unidade_medida)}
                        marcadores={
                          (alertaEC || e.alerta_reposicao || alertaEP || alertaEtiqueta) ? (
                            <>
                              {(alertaEC || e.alerta_reposicao) && <Selo cor="amber">⚠ comprar</Selo>}
                              {alertaEP && <Selo cor="blue">⚠ transferir</Selo>}
                              {alertaEtiqueta && <Selo cor="purple">⚠ etiquetar</Selo>}
                            </>
                          ) : undefined
                        }
                        campos={[
                          { rotulo: 'EC', valor: formatQty(e.qtd_estoque_central, e.unidade_medida) },
                          { rotulo: 'EP', valor: formatQty(e.qtd_estoque_produtivo, e.unidade_medida) },
                          {
                            rotulo: 'Val. EC',
                            valor: val?.validade_ec
                              ? <span className={validadeClass(val.validade_ec)}>{formatDate(val.validade_ec)}</span>
                              : <span className="text-gray-300">—</span>,
                          },
                          {
                            rotulo: 'Val. EP',
                            valor: val?.validade_ep
                              ? <span className={validadeClass(val.validade_ep)}>{formatDate(val.validade_ep)}</span>
                              : <span className="text-gray-300">—</span>,
                          },
                        ]}
                      />
                    )
                  })
            }
            tabela={
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Insumo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Categoria</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">EC</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Val. EC</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">EP</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Val. EP</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Total</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Mínimo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((e) => {
                  const meta = insumosMeta[e.insumo_id]
                  const cat = catMap[meta?.categoria_id ?? '']
                  const val = validades[e.insumo_id]
                  const alertaEC = meta?.estoque_minimo_ec != null && e.qtd_estoque_central < meta.estoque_minimo_ec
                  const alertaEP = meta?.estoque_minimo_ep != null && e.qtd_estoque_produtivo < meta.estoque_minimo_ep
                  const alertaEtiqueta = insumosSemEtiqueta.has(e.insumo_id)
                  return (
                    <tr key={e.insumo_id} onClick={() => setInsumoSelecionado(e)} className={`cursor-pointer ${(alertaEC || alertaEP || e.alerta_reposicao || alertaEtiqueta) ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-50'}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          {cat?.cor_hex && <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.cor_hex }} />}
                          <span className="font-medium text-gray-900">{e.insumo_nome}</span>
                          {(alertaEC || e.alerta_reposicao) && <span className="text-xs text-amber-600" title="EC abaixo do mínimo — comprar">⚠ comprar</span>}
                          {alertaEP && <span className="text-xs text-blue-600" title="EP abaixo do mínimo — transferir do EC">⚠ transferir</span>}
                          {alertaEtiqueta && <span className="text-xs text-purple-600" title="Há lotes sem etiqueta impressa">⚠ etiquetar</span>}
                        </div>
                        <p className="text-xs text-gray-400 ml-4">{e.insumo_codigo}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{cat?.nome ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{formatQty(e.qtd_estoque_central, e.unidade_medida)}</td>
                      <td className="px-4 py-3 text-center text-xs">
                        {val?.validade_ec
                          ? <span className={validadeClass(val.validade_ec)}>{formatDate(val.validade_ec)}</span>
                          : <span className="text-gray-300">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{formatQty(e.qtd_estoque_produtivo, e.unidade_medida)}</td>
                      <td className="px-4 py-3 text-center text-xs">
                        {val?.validade_ep
                          ? <span className={validadeClass(val.validade_ep)}>{formatDate(val.validade_ep)}</span>
                          : <span className="text-gray-300">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatQty(e.qtd_total, e.unidade_medida)}</td>
                      <td className="px-4 py-3 text-right text-gray-400">{e.estoque_minimo ? formatQty(e.estoque_minimo, e.unidade_medida) : '—'}</td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Nenhum insumo encontrado.</td></tr>
                )}
              </tbody>
            </table>
            }
          />
        </Card>
      )}

      {insumoSelecionado && (
        <InsumoDetalhePanel
          insumo={insumoSelecionado}
          onClose={() => setInsumoSelecionado(null)}
        />
      )}
    </div>
  )
}

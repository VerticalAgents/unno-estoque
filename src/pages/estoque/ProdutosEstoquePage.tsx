import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { CartaoLista, ListaResponsiva, ListaVazia } from '../../components/ui/ListaResponsiva'
import { formatDate, daysUntil } from '../../lib/utils'

interface LoteRow {
  id: string
  codigo: string
  data_producao: string
  validade: string
  quantidade_produzida: number
  quantidade_disponivel: number
  status: string
  produto: { nome: string; codigo: string }
}

function validadeClass(date: string): string {
  const days = daysUntil(date)
  if (days < 0) return 'text-red-600 font-semibold'
  if (days <= 7) return 'text-red-600 font-semibold'
  if (days <= 30) return 'text-yellow-600 font-semibold'
  return 'text-gray-700'
}

function diasLabel(date: string): string {
  const days = daysUntil(date)
  if (days < 0) return 'VENCIDO'
  if (days === 0) return 'HOJE'
  return `${days}d`
}

export function ProdutosEstoquePage() {
  const { profile } = useAuth()
  const [lotes, setLotes] = useState<LoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filtroStatus, setFiltroStatus] = useState('ativo')

  useEffect(() => {
    if (!profile) return
    setLoading(true)
    let query = supabase
      .from('lotes_produto')
      .select('*, produto:produtos(nome, codigo)')
      .eq('empresa_id', profile.empresa_id)
      .order('validade', { ascending: true })

    if (filtroStatus) query = query.eq('status', filtroStatus)

    query.then(({ data }) => {
      setLotes((data ?? []) as unknown as LoteRow[])
      setLoading(false)
    })
  }, [profile, filtroStatus])

  const totalDisponivel = lotes.reduce((acc, l) => acc + l.quantidade_disponivel, 0)
  const produtosDistintos = new Set(lotes.map((l) => l.produto?.codigo)).size
  const proxVencer = lotes.filter((l) => l.status === 'ativo' && daysUntil(l.validade) <= 7).length

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Estoque de Produtos</h1>
        <p className="text-sm text-gray-500 mt-0.5">Lotes de produto acabado disponíveis para expedição</p>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Card className="p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Em estoque</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalDisponivel.toLocaleString()} un</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Produtos</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{produtosDistintos}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Vencem em ≤7d</p>
          <p className={`text-2xl font-bold mt-1 ${proxVencer > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{proxVencer}</p>
        </Card>
      </div>

      <div className="flex gap-3 mb-4">
        <select
          value={filtroStatus}
          onChange={(e) => setFiltroStatus(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm"
        >
          <option value="ativo">Ativos</option>
          <option value="esgotado">Esgotados</option>
          <option value="vencido">Vencidos</option>
          <option value="">Todos</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <ListaResponsiva
              cartoes={
                lotes.length === 0
                  ? (
                    <ListaVazia>
                      Nenhum lote de produto encontrado. Feche sessões de produção com
                      produto cadastrado para gerar lotes.
                    </ListaVazia>
                  )
                  : lotes.map(l => {
                      const dias = daysUntil(l.validade)
                      return (
                        <CartaoLista
                          key={l.id}
                          // Vencido ou vencendo é o que muda a decisão de hoje.
                          alerta={l.status === 'ativo' && dias <= 7}
                          titulo={
                            <span className={`font-medium text-gray-900 dark:text-unno-text ${l.status !== 'ativo' ? 'opacity-60' : ''}`}>
                              {l.produto?.nome}
                            </span>
                          }
                          subtitulo={`${l.produto?.codigo ?? ''} · ${l.codigo}`}
                          destaque={<>{l.quantidade_disponivel.toLocaleString()} un</>}
                          marcadores={
                            <span className={`inline-flex px-2 py-0.5 rounded text-[0.65rem] font-medium ${
                              l.status === 'ativo' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' :
                              l.status === 'vencido' ? 'bg-red-50 text-red-700 dark:bg-unno-danger/15 dark:text-unno-danger' :
                              'bg-gray-100 text-gray-600 dark:bg-white/[.06] dark:text-unno-muted'
                            }`}>
                              {l.status}
                            </span>
                          }
                          campos={[
                            { rotulo: 'Produção', valor: formatDate(l.data_producao) },
                            {
                              rotulo: 'Validade',
                              valor: <span className={validadeClass(l.validade)}>{formatDate(l.validade)}</span>,
                            },
                            {
                              rotulo: 'Dias',
                              valor: <span className={`font-bold ${validadeClass(l.validade)}`}>{diasLabel(l.validade)}</span>,
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
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Produto</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lote</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Produção</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Validade</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Dias</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Disponível</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lotes.map((l) => {
                  const vencido = daysUntil(l.validade) < 0
                  const urgente = daysUntil(l.validade) <= 3
                  const alerta = daysUntil(l.validade) <= 7
                  return (
                    <tr
                      key={l.id}
                      className={
                        l.status !== 'ativo' ? 'opacity-50' :
                        vencido ? 'bg-red-50' : urgente ? 'bg-orange-50' : alerta ? 'bg-yellow-50' : 'hover:bg-gray-50'
                      }
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{l.produto?.nome}</p>
                        <p className="text-xs text-gray-400">{l.produto?.codigo}</p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{l.codigo}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{formatDate(l.data_producao)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={validadeClass(l.validade)}>{formatDate(l.validade)}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`font-bold text-sm ${validadeClass(l.validade)}`}>
                          {diasLabel(l.validade)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {l.quantidade_disponivel.toLocaleString()} un
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                          l.status === 'ativo' ? 'bg-emerald-50 text-emerald-700' :
                          l.status === 'esgotado' ? 'bg-gray-100 text-gray-600' :
                          l.status === 'vencido' ? 'bg-red-50 text-red-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>
                          {l.status}
                        </span>
                      </td>
                    </tr>
                  )
                })}
                {lotes.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                      Nenhum lote de produto encontrado. Feche sessões de produção com produto cadastrado para gerar lotes.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
              }
            />
          </div>
        </Card>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CartaoLista, ListaResponsiva, ListaVazia } from '../../components/ui/ListaResponsiva'
import { formatDate } from '../../lib/utils'
import type { StatusExpedicao } from '../../types/database.types'

interface ExpedicaoRow {
  id: string
  codigo: string
  data_expedicao: string
  destinatario: string | null
  status: StatusExpedicao
  created_at: string
  itens: { quantidade: number }[]
}

const STATUS_BADGE: Record<StatusExpedicao, { bg: string; text: string; label: string }> = {
  preparando: { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'Preparando' },
  expedida:   { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Expedida' },
  cancelada:  { bg: 'bg-gray-100',   text: 'text-gray-500',    label: 'Cancelada' },
}

export function ExpedicaoListPage() {
  const { profile } = useAuth()
  const [expedicoes, setExpedicoes] = useState<ExpedicaoRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('expedicoes')
      .select('*, itens:expedicoes_itens(quantidade)')
      .eq('empresa_id', profile.empresa_id)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setExpedicoes((data ?? []) as unknown as ExpedicaoRow[])
        setLoading(false)
      })
  }, [profile])

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Expedição</h1>
          <p className="text-sm text-gray-500 mt-0.5">Saída de produtos acabados</p>
        </div>
        <Link to="/expedicao/nova">
          <Button>+ Nova expedição</Button>
        </Link>
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
                expedicoes.length === 0
                  ? <ListaVazia>Nenhuma expedição registrada.</ListaVazia>
                  : expedicoes.map(exp => {
                      const badge = STATUS_BADGE[exp.status]
                      return (
                        <CartaoLista
                          key={exp.id}
                          titulo={
                            <span className="font-medium text-gray-900 dark:text-unno-text">
                              {exp.destinatario ?? '—'}
                            </span>
                          }
                          subtitulo={exp.codigo}
                          destaque={<>{exp.itens.reduce((s, i) => s + i.quantidade, 0)} un</>}
                          marcadores={
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-medium ${badge.bg} ${badge.text}`}>
                              {badge.label}
                            </span>
                          }
                          campos={[{ rotulo: 'Data', valor: formatDate(exp.data_expedicao) }]}
                        />
                      )
                    })
              }
              tabela={
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Código</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Destinatário</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd total</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {expedicoes.map((exp) => {
                  const qtdTotal = exp.itens.reduce((sum, i) => sum + i.quantidade, 0)
                  const badge = STATUS_BADGE[exp.status]
                  return (
                    <tr key={exp.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{exp.codigo}</td>
                      <td className="px-4 py-3 text-gray-600">{formatDate(exp.data_expedicao)}</td>
                      <td className="px-4 py-3 text-gray-900">{exp.destinatario ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{qtdTotal}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>
                          {badge.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
                {expedicoes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                      Nenhuma expedição registrada.
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

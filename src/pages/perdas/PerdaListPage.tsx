import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate, formatQty } from '../../lib/utils'
import type { MotivoPerdaEnum, UnidadeMedida } from '../../types/database.types'

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

const MOTIVO_LABELS: Record<MotivoPerdaEnum, string> = {
  vencimento: 'Vencimento',
  embalagem_danificada: 'Embalagem danificada',
  contaminacao: 'Contaminação',
  queda_acidente: 'Queda / Acidente',
  qualidade_reprovada: 'Qualidade reprovada',
  outro: 'Outro',
}

export function PerdaListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [perdas, setPerdas] = useState<PerdaRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filtroMotivo, setFiltroMotivo] = useState('')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('perdas_insumo')
      .select('*, insumo:insumos(nome, codigo), lote:lotes(codigo), local:locais(nome)')
      .eq('empresa_id', profile.empresa_id)
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setPerdas((data ?? []) as unknown as PerdaRow[])
        setLoading(false)
      })
  }, [profile])

  const filtered = perdas.filter((p) =>
    filtroMotivo === '' || p.motivo === filtroMotivo
  )

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Perdas de Insumo</h1>
          <p className="text-sm text-gray-500 mt-0.5">Descartes por acidente, vencimento ou qualidade</p>
        </div>
        <Button onClick={() => navigate('/perdas/nova')}>
          + Registrar Perda
        </Button>
      </div>

      <div className="mb-4">
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
                      Nenhuma perda registrada.
                    </td>
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

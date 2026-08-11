import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate } from '../../lib/utils'
import { combina } from '../../lib/busca'

interface FichaRow {
  id: string
  codigo: string
  nome: string
  descricao: string | null
  versao_atual: number
  tipo: 'produto' | 'insumo'
  insumo_resultado?: { nome: string } | null
  ativo: boolean
  updated_at: string
  versoes: { id: string; ativa: boolean; itens: { id: string }[] }[]
}

export function FichasListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [fichas, setFichas] = useState<FichaRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'produto' | 'insumo'>('produto')

  useEffect(() => {
    if (!profile) return
    supabase
      .from('fichas_tecnicas')
      .select('*, insumo_resultado:insumos!fichas_tecnicas_insumo_resultado_id_fkey(nome), versoes:fichas_tecnicas_versoes(id, ativa, itens:fichas_tecnicas_itens(id))')
      .eq('empresa_id', profile.empresa_id)
      .order('codigo')
      .then(({ data }) => {
        setFichas((data ?? []) as unknown as FichaRow[])
        setLoading(false)
      })
  }, [profile])

  const filtered = fichas.filter(
    (f) =>
      (f.tipo ?? 'produto') === tab &&
      combina(search, f.nome, f.codigo)
  )

  function getIngredientesCount(f: FichaRow): number {
    const versaoAtiva = f.versoes?.find((v) => v.ativa)
    return versaoAtiva?.itens?.length ?? 0
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Fichas Técnicas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Receitas de produtos e insumos de produção própria</p>
        </div>
        <Button onClick={() => navigate('/fichas/nova')}>
          + Nova Ficha
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        <button
          onClick={() => setTab('produto')}
          className={['px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'produto' ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          ].join(' ')}
        >
          Produtos
        </button>
        <button
          onClick={() => setTab('insumo')}
          className={['px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'insumo' ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          ].join(' ')}
        >
          Insumos (Produção Própria)
        </button>
      </div>

      <div className="mb-4">
        <input
          type="search"
          placeholder="Buscar ficha..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-72 px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <Card>
          <div className="divide-y divide-gray-100">
            {filtered.map((f) => (
              <button
                key={f.id}
                onClick={() => navigate(`/fichas/${f.id}`)}
                className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 text-left transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center shrink-0">
                    <span className="text-brand-700 text-xs font-bold">v{f.versao_atual}</span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{f.nome}</p>
                    <p className="text-xs text-gray-400">
                      {f.codigo} · {getIngredientesCount(f)} ingredientes
                      {f.tipo === 'insumo' && f.insumo_resultado && (
                        <span className="ml-1 text-brand-600">· Produz: {(f.insumo_resultado as unknown as { nome: string }).nome}</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {!f.ativo && (
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">Inativa</span>
                  )}
                  <p className="text-xs text-gray-400 hidden sm:block">
                    {f.updated_at ? `Atualizada ${formatDate(f.updated_at)}` : ''}
                  </p>
                  <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-400">
                {fichas.length === 0 ? 'Nenhuma ficha técnica cadastrada.' : 'Nenhuma ficha encontrada.'}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

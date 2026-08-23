import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { UnidadeMedida } from '../../types/database.types'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate } from '../../lib/utils'

interface ItemRow {
  id: string
  quantidade: number
  /** Quanto desta linha vem da embalagem porcionada, quando é o caso. */
  quantidade_porcionada: number | null
  unidade: UnidadeMedida
  observacoes: string | null
  insumo: { nome: string; codigo: string; unidade_medida: UnidadeMedida }
}

interface VersaoRow {
  id: string
  versao: number
  ativa: boolean
  notas_alteracao: string
  created_at: string
  rendimento_fornada: number | null
  peso_medio_g: number | null
  criado_por_usuario: { nome: string } | null
  itens: ItemRow[]
}

interface FichaRow {
  id: string
  codigo: string
  nome: string
  descricao: string | null
  versao_atual: number
  tipo: 'produto' | 'insumo'
  insumo_resultado?: { nome: string; codigo: string } | null
  ativo: boolean
  updated_at: string
  versoes: VersaoRow[]
}

export function FichaDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [ficha, setFicha] = useState<FichaRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAllVersions, setShowAllVersions] = useState(false)

  async function load() {
    if (!id || !profile) return
    const { data } = await supabase
      .from('fichas_tecnicas')
      .select(`
        *,
        insumo_resultado:insumos!fichas_tecnicas_insumo_resultado_id_fkey(nome, codigo),
        versoes:fichas_tecnicas_versoes(
          *,
          itens:fichas_tecnicas_itens(*, insumo:insumos(nome, codigo, unidade_medida))
        )
      `)
      .eq('id', id)
      .eq('empresa_id', profile.empresa_id)
      .single()

    if (data) {
      // Sort versoes descending by versao number
      const f = data as unknown as FichaRow
      f.versoes = (f.versoes ?? []).sort((a, b) => b.versao - a.versao)
      setFicha(f)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [id, profile])

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!ficha) {
    return (
      <div className="p-6 text-center text-gray-400">
        Ficha não encontrada.
      </div>
    )
  }

  const versaoAtiva = ficha.versoes.find((v) => v.ativa)
  const versoesList = showAllVersions ? ficha.versoes : ficha.versoes.slice(0, 3)

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate('/fichas')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Fichas Técnicas
        </button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-gray-900">{ficha.nome}</h1>
              {!ficha.ativo && (
                <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">Inativa</span>
              )}
            </div>
            <p className="text-sm text-gray-500">
              {ficha.codigo} · v{ficha.versao_atual}
              <span className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${(ficha.tipo ?? 'produto') === 'insumo' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                {(ficha.tipo ?? 'produto') === 'insumo' ? 'Insumo' : 'Produto'}
              </span>
            </p>
            {(ficha.tipo ?? 'produto') === 'insumo' && ficha.insumo_resultado && (
              <p className="text-sm text-brand-600 mt-0.5">Produz: {(ficha.insumo_resultado as { nome: string }).nome}</p>
            )}
            {ficha.descricao && <p className="text-sm text-gray-600 mt-1">{ficha.descricao}</p>}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate(`/fichas/${ficha.id}/nutricional`)}
            >
              Nutricional
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate(`/fichas/${ficha.id}/imprimir`)}
              icon={
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
                </svg>
              }
            >
              Imprimir
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate(`/fichas/${ficha.id}/nova-versao`)}
            >
              Nova versão
            </Button>
          </div>
        </div>
      </div>

      {/* Versão ativa — ingredientes */}
      {versaoAtiva && (
        <Card className="mb-4">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Versão {versaoAtiva.versao} — ativa
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">{versaoAtiva.notas_alteracao}</p>
              {versaoAtiva.rendimento_fornada && (
                <p className="text-xs text-brand-600 mt-1 font-medium">
                  Rendimento: {versaoAtiva.rendimento_fornada} un/fornada
                  {versaoAtiva.peso_medio_g ? ` · Peso médio: ${versaoAtiva.peso_medio_g}g` : ''}
                </p>
              )}
            </div>
            <span className="text-xs text-gray-400">{formatDate(versaoAtiva.created_at)}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ingrediente</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Qtd / fornada</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Obs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...(versaoAtiva.itens ?? [])].sort((a, b) => {
                  const toG = (q: number, u: string) => u === 'kg' || u === 'L' ? q * 1000 : q
                  return toG(b.quantidade, b.unidade) - toG(a.quantidade, a.unidade)
                }).map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{item.insumo?.nome}</p>
                      <p className="text-xs text-gray-400">{item.insumo?.codigo}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-gray-900">
                        {item.quantidade} {item.unidade}
                      </span>
                      {/* A linha continua mostrando o total, que é o que quem
                          está na bancada precisa somar. A divisão vem abaixo,
                          em letra menor, para quem precisa saber por onde entra. */}
                      {item.quantidade_porcionada != null && item.quantidade_porcionada > 0 && (
                        <p className="text-xs text-brand-700 dark:text-brand-300 mt-0.5">
                          {item.quantidade_porcionada} {item.unidade} porcionado ·{' '}
                          {Number((item.quantidade - item.quantidade_porcionada).toFixed(3))}{' '}
                          {item.unidade} do pote
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{item.observacoes ?? '—'}</td>
                  </tr>
                ))}
                {(!versaoAtiva.itens || versaoAtiva.itens.length === 0) && (
                  <tr>
                    <td colSpan={3} className="px-4 py-4 text-center text-gray-400">
                      Nenhum ingrediente cadastrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {versaoAtiva.itens && versaoAtiva.itens.length > 0 && (
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                {versaoAtiva.itens.length} ingredientes · quantidades por unidade produzida
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Histórico de versões */}
      {ficha.versoes.length > 1 && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Histórico de versões</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {versoesList.map((v) => (
              <div key={v.id} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                    v.ativa ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    v{v.versao}
                  </div>
                  <div>
                    <p className="text-sm text-gray-700">{v.notas_alteracao}</p>
                    <p className="text-xs text-gray-400">{formatDate(v.created_at)}</p>
                  </div>
                </div>
                {v.ativa && (
                  <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded shrink-0">
                    Ativa
                  </span>
                )}
              </div>
            ))}
          </div>
          {ficha.versoes.length > 3 && (
            <div className="px-4 py-3 border-t border-gray-100">
              <button
                className="text-xs text-brand-600 hover:text-brand-800"
                onClick={() => setShowAllVersions((v) => !v)}
              >
                {showAllVersions
                  ? 'Mostrar menos'
                  : `Ver todas as ${ficha.versoes.length} versões`}
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

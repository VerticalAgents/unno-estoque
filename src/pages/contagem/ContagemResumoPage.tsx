import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import type { Contagem, ContagemInsumo, ContagemEcLote, ContagemEpLocal } from '../../types/contagem'
import { ordemNatural } from '../../lib/utils'

/**
 * Um dos quatro números da linha de contagem.
 *
 * No computador é célula de coluna, e o rótulo vem do cabeçalho da lista.
 * No celular não há cabeçalho — `sm:contents` desmancha a grade e devolve o
 * número para a linha —, então cada um carrega o próprio rótulo.
 */
function NumeroContagem({ rotulo, className, children }: {
  rotulo: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <span className="sm:w-20 sm:text-right sm:px-3 sm:py-2.5 flex flex-col sm:block">
      <span className="text-[0.6rem] uppercase tracking-wide text-gray-400 sm:hidden">{rotulo}</span>
      <span className={className}>{children}</span>
    </span>
  )
}

type InsumoJoined = ContagemInsumo & {
  insumo: { nome: string; codigo: string; unidade_medida: string }
}

export function ContagemResumoPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [contagem, setContagem] = useState<Contagem | null>(null)
  const [itens, setItens] = useState<InsumoJoined[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailsEc, setDetailsEc] = useState<ContagemEcLote[]>([])
  const [detailsEp, setDetailsEp] = useState<ContagemEpLocal[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase.from('contagens').select('*').eq('id', id).single(),
      supabase
        .from('contagem_insumos')
        .select('*, insumo:insumos(nome, codigo, unidade_medida)')
        .eq('contagem_id', id)
        .order('created_at'),
    ]).then(([{ data: c }, { data: items }]) => {
      setContagem(c as unknown as Contagem)
      // Mesma ordem da tela de contagem: conferir o resumo é reler a lista.
      setItens(((items ?? []) as unknown as InsumoJoined[])
        .sort((a, b) => ordemNatural(a.insumo.codigo, b.insumo.codigo)))
      setLoading(false)
    })
  }, [id])

  async function toggleExpand(itemId: string) {
    if (expandedId === itemId) {
      setExpandedId(null)
      return
    }

    setExpandedId(itemId)

    if (contagem?.tipo === 'ec') {
      const { data } = await supabase
        .from('contagem_ec_lotes')
        .select('*')
        .eq('contagem_insumo_id', itemId)
      setDetailsEc(((data ?? []) as ContagemEcLote[])
        .sort((a, b) => ordemNatural(a.lote_codigo, b.lote_codigo)))
    } else {
      const { data } = await supabase
        .from('contagem_ep_locais')
        .select('*')
        .eq('contagem_insumo_id', itemId)
      setDetailsEp(((data ?? []) as ContagemEpLocal[])
        .sort((a, b) => ordemNatural(a.local_nome, b.local_nome)))
    }
  }

  async function aplicar() {
    if (!profile || !id) return
    setApplying(true)

    const { data, error } = await supabase.rpc('aplicar_contagem', {
      p_contagem_id: id,
      p_usuario_id: profile.id,
    })

    const result = data as unknown as { ok: boolean; erro?: string }
    if (error || !result?.ok) {
      alert(result?.erro ?? error?.message ?? 'Erro ao aplicar contagem')
      setApplying(false)
      return
    }

    setContagem(prev => prev ? { ...prev, status: 'aplicada' } : prev)
    setApplying(false)
  }

  /**
   * Desiste da contagem inteira.
   *
   * O status 'cancelada' já existia no banco desde a migration 019, mas não
   * havia como chegar nele pela tela: uma contagem começada por engano ficava
   * para sempre "em andamento" na lista. Nada do estoque é tocado — cancelar é
   * jogar fora a conferência, não alterar saldo.
   */
  async function cancelarContagem() {
    if (!id) return
    const certeza = window.confirm(
      'Cancelar esta contagem? Tudo que foi conferido nela será descartado. '
      + 'O estoque não muda.',
    )
    if (!certeza) return
    await supabase.from('contagens').update({ status: 'cancelada' }).eq('id', id)
    navigate('/contagem')
  }

  async function finalizarSemAplicar() {
    if (!id) return
    await supabase.from('contagens').update({
      status: 'finalizada',
      finalizada_at: new Date().toISOString(),
    }).eq('id', id)
    setContagem(prev => prev ? { ...prev, status: 'finalizada' } : prev)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!contagem) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Contagem não encontrada.</p>
      <Link to="/contagem" className="text-brand-600 text-sm mt-2 inline-block">Voltar</Link>
    </div>
  )

  const comDivergencia = itens.filter(i => i.qtd_fisica != null && i.qtd_fisica !== i.qtd_teorica)
  const totalDiferenca = itens.reduce((sum, i) => sum + ((i.qtd_fisica ?? i.qtd_teorica) - i.qtd_teorica), 0)

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link to="/contagem" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Contagem
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">
            Resumo — {contagem.tipo === 'ec' ? 'Estoque Central' : 'Estoque Produtivo'}
          </h1>
          <Badge variant={contagem.status === 'aplicada' ? 'success' : contagem.status === 'finalizada' ? 'info' : 'warning'}>
            {contagem.status === 'aplicada' ? 'Aplicada' : contagem.status === 'finalizada' ? 'Finalizada' : 'Em andamento'}
          </Badge>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          {new Date(contagem.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      </div>

      {/* Estatísticas */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-3 text-center">
          <p className="text-2xl font-bold text-gray-900">{itens.length}</p>
          <p className="text-xs text-gray-500">Insumos</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3 text-center">
          <p className={`text-2xl font-bold ${comDivergencia.length > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
            {comDivergencia.length}
          </p>
          <p className="text-xs text-gray-500">Com divergência</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3 text-center">
          <p className={`text-2xl font-bold ${totalDiferenca < 0 ? 'text-red-600' : totalDiferenca > 0 ? 'text-emerald-600' : 'text-gray-900'}`}>
            {totalDiferenca > 0 ? '+' : ''}{totalDiferenca.toFixed(1)}
          </p>
          <p className="text-xs text-gray-500">Diferença total</p>
        </div>
      </div>

      {/* Tabela de insumos */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
        {/* Esta lista nunca foi tabela de verdade: a linha sempre foi um
            botão (para expandir), com células fingindo colunas. Então, em vez
            de manter duas versões, a própria linha se reorganiza — números
            lado a lado no computador, em grade de quatro no celular, cada um
            com seu rótulo. */}
        <div className="text-sm">
          {/* Cabeçalho só onde os números ficam alinhados em coluna. */}
          <div className="hidden sm:flex bg-gray-50 border-b border-gray-200 font-medium text-gray-600">
            <span className="flex-1 px-4 py-2.5">Insumo</span>
            <span className="w-20 text-right px-3 py-2.5">Teórico</span>
            <span className="w-20 text-right px-3 py-2.5">Físico</span>
            <span className="w-20 text-right px-3 py-2.5">Dif.</span>
            {/* É esta coluna que vira a taxa de perda do insumo: com o
                fechamento dando baixa pelo teórico (065), a auditoria virou
                a única medição real de perda. */}
            <span className="w-20 text-right px-4 py-2.5">Perda</span>
          </div>

          <div>
            {itens.map(item => {
              const dif = (item.qtd_fisica ?? item.qtd_teorica) - item.qtd_teorica
              // Perda positiva = faltou no estoque. `dif` é o contrário (físico
              // menos teórico), daí o sinal invertido.
              const perdaPct = item.qtd_fisica != null && item.qtd_teorica > 0
                ? (-dif / item.qtd_teorica) * 100
                : null
              const isExpanded = expandedId === item.id
              return (
                <div key={item.id}>
                    <button
                      onClick={() => toggleExpand(item.id)}
                      className="w-full text-left flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-0
                                 border-b border-gray-100 hover:bg-gray-50 transition-colors py-1 sm:py-0"
                    >
                      <span className="px-4 py-1.5 sm:py-2.5 flex-1 min-w-0">
                        <span className="font-medium text-gray-900">{item.insumo.nome}</span>
                        <span className="text-xs text-gray-400 ml-1">{item.insumo.unidade_medida}</span>
                      </span>
                      {/* No celular os quatro números viram grade com rótulo:
                          sem o cabeçalho da tabela, número solto não diz nada. */}
                      <span className="grid grid-cols-4 gap-1 px-4 pb-1 sm:contents">
                        <NumeroContagem rotulo="Teórico" className="text-gray-600">
                          {item.qtd_teorica.toFixed(1)}
                        </NumeroContagem>
                        <NumeroContagem rotulo="Físico" className="text-gray-600">
                          {item.qtd_fisica?.toFixed(1) ?? '—'}
                        </NumeroContagem>
                        <NumeroContagem
                          rotulo="Dif."
                          className={dif < 0 ? 'text-red-600 font-medium' : dif > 0 ? 'text-emerald-600 font-medium' : 'text-gray-400'}
                        >
                          {dif !== 0 ? (dif > 0 ? '+' : '') + dif.toFixed(1) : '—'}
                        </NumeroContagem>
                        <NumeroContagem
                          rotulo="Perda"
                          className={[
                            'font-medium',
                            perdaPct == null ? 'text-gray-300'
                              : perdaPct <= 3 ? 'text-emerald-600'
                              : perdaPct <= 8 ? 'text-yellow-600' : 'text-red-600',
                          ].join(' ')}
                        >
                          {perdaPct == null ? '—' : `${perdaPct > 0 ? '+' : ''}${perdaPct.toFixed(1)}%`}
                        </NumeroContagem>
                      </span>
                    </button>

                    {/* Detalhes expandidos */}
                    {isExpanded && contagem.tipo === 'ec' && (
                      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                        {detailsEc.length === 0 ? (
                          <p className="text-xs text-gray-400 py-1">Carregando...</p>
                        ) : detailsEc.map(lote => (
                          <div key={lote.id} className="flex items-center justify-between py-1 text-xs">
                            <span className={lote.encontrado ? 'text-gray-700' : 'text-red-600 font-medium'}>
                              {lote.lote_codigo}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="text-gray-500">{lote.qtd_lote} {item.insumo.unidade_medida}</span>
                              {lote.encontrado ? (
                                <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                </svg>
                              ) : (
                                <span className="text-red-500 font-medium">FALTANTE</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {isExpanded && contagem.tipo === 'ep' && (
                      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
                        {detailsEp.length === 0 ? (
                          <p className="text-xs text-gray-400 py-1">Carregando...</p>
                        ) : detailsEp.map(local => (
                          <div key={local.id} className="flex items-center justify-between py-1 text-xs">
                            <span className="text-gray-700">{local.local_nome}</span>
                            <span className={[
                              'font-medium',
                              !local.escaneado ? 'text-gray-400'
                                : local.status_fisico === 'cheio' ? 'text-emerald-600'
                                : local.status_fisico === 'vazio' ? 'text-red-600'
                                : 'text-amber-600',
                            ].join(' ')}>
                              {!local.escaneado ? 'Não escaneado'
                                : local.status_fisico === 'cheio' ? 'Cheio'
                                : local.status_fisico === 'vazio' ? 'Vazio'
                                : `Usado (${local.qtd_liquida?.toFixed(0)}g)`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Ações */}
      {contagem.status === 'finalizada' && (
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" onClick={() => navigate('/contagem')}>
            Voltar
          </Button>
          <Button
            size="lg"
            fullWidth
            onClick={aplicar}
            disabled={applying}
          >
            {applying ? 'Aplicando...' : 'Aplicar Contagem ao Estoque'}
          </Button>
        </div>
      )}

      {contagem.status === 'em_andamento' && (
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" onClick={finalizarSemAplicar}>
            Finalizar sem aplicar
          </Button>
          <Button size="lg" fullWidth onClick={() => navigate(`/contagem/${contagem.tipo}/${id}`)}>
            Continuar contagem
          </Button>
        </div>
      )}

      {/* A saída fica longe dos botões de seguir em frente, e discreta: é o
          caminho raro, e clicar nele por engano custa a conferência inteira. */}
      {(contagem.status === 'em_andamento' || contagem.status === 'finalizada') && (
        <div className="mt-6 pt-4 border-t border-gray-200 text-center">
          <button
            onClick={() => void cancelarContagem()}
            className="text-xs text-red-600 hover:underline"
          >
            Cancelar esta contagem
          </button>
          <p className="text-xs text-gray-400 mt-1">
            Descarta o que foi conferido. O estoque não muda.
          </p>
        </div>
      )}

      {contagem.status === 'aplicada' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
          <svg className="w-8 h-8 text-emerald-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium text-emerald-800">Contagem aplicada com sucesso</p>
          <p className="text-xs text-emerald-600 mt-1">O estoque virtual foi atualizado com base na contagem física.</p>
          <Link to="/contagem" className="text-sm text-emerald-700 underline mt-3 inline-block">
            Voltar para contagens
          </Link>
        </div>
      )}
    </div>
  )
}

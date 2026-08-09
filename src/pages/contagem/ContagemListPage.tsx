import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Badge } from '../../components/ui/Badge'
import type { Contagem } from '../../types/contagem'
import { avisoCancelamento, cancelarContagem } from '../../lib/contagem'

const statusVariants: Record<string, 'default' | 'warning' | 'info' | 'success' | 'danger'> = {
  em_andamento: 'warning',
  finalizada: 'info',
  aplicada: 'success',
  cancelada: 'default',
}

const statusLabels: Record<string, string> = {
  em_andamento: 'Em andamento',
  finalizada: 'Finalizada',
  aplicada: 'Aplicada',
  cancelada: 'Cancelada',
}

/** Discreto e embaixo: cancelar não pode competir com "continuar". */
function BotaoCancelar({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full mt-2 text-xs font-medium text-gray-400 hover:text-red-600"
    >
      Cancelar contagem
    </button>
  )
}

export function ContagemListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [contagens, setContagens] = useState<Contagem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('contagens')
      .select('*, usuario:usuarios!contagens_iniciada_por_fkey(nome)')
      .eq('empresa_id', profile.empresa_id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setContagens((data ?? []) as unknown as Contagem[])
        setLoading(false)
      })
  }, [profile])

  const emAndamentoEc = contagens.find(c => c.tipo === 'ec' && c.status === 'em_andamento')
  const emAndamentoEp = contagens.find(c => c.tipo === 'ep' && c.status === 'em_andamento')

  async function iniciar(tipo: 'ec' | 'ep') {
    if (!profile) return
    const { data, error } = await supabase.rpc('iniciar_contagem', {
      p_empresa_id: profile.empresa_id,
      p_tipo: tipo,
      p_usuario_id: profile.id,
    })

    const result = data as unknown as { ok: boolean; contagem_id?: string; erro?: string }
    if (error || !result.ok) {
      alert(result?.erro ?? error?.message ?? 'Erro ao iniciar contagem')
      return
    }

    navigate(`/contagem/${tipo}/${result.contagem_id}`)
  }

  function continuar(c: Contagem) {
    navigate(`/contagem/${c.tipo}/${c.id}`)
  }

  /**
   * Cancelar a contagem em andamento.
   *
   * Enquanto uma existe, o botão de iniciar recusa criar outra — então uma
   * contagem aberta por engano bloqueava a próxima sem oferecer saída.
   */
  async function cancelar(c: Contagem) {
    const { count } = await supabase
      .from('contagem_insumos')
      .select('id', { count: 'exact', head: true })
      .eq('contagem_id', c.id)
      .eq('status', 'finalizado')

    if (!window.confirm(avisoCancelamento(count ?? 0))) return

    const erro = await cancelarContagem(c.id)
    if (erro) { alert(erro); return }
    setContagens(prev => prev.map(x => (x.id === c.id ? { ...x, status: 'cancelada' } : x)))
  }

  function verResumo(c: Contagem) {
    navigate(`/contagem/resumo/${c.id}`)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Contagem de Estoque</h1>
        <p className="text-sm text-gray-500 mt-0.5">Inventário físico do estoque central e produtivo</p>
      </div>

      {/* Botões de ação */}
      <div className="grid grid-cols-2 gap-3 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="font-semibold text-gray-900 text-sm mb-1">Estoque Central</h3>
          <p className="text-xs text-gray-500 mb-3">Escanear etiquetas dos lotes no EC</p>
          {emAndamentoEc ? (
            <>
              <Button size="md" fullWidth onClick={() => continuar(emAndamentoEc)}>
                Continuar contagem EC
              </Button>
              <BotaoCancelar onClick={() => void cancelar(emAndamentoEc)} />
            </>
          ) : (
            <Button size="md" fullWidth onClick={() => iniciar('ec')}>
              Nova contagem EC
            </Button>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="font-semibold text-gray-900 text-sm mb-1">Estoque Produtivo</h3>
          <p className="text-xs text-gray-500 mb-3">Escanear recipientes no EP</p>
          {emAndamentoEp ? (
            <>
              <Button size="md" fullWidth onClick={() => continuar(emAndamentoEp)}>
                Continuar contagem EP
              </Button>
              <BotaoCancelar onClick={() => void cancelar(emAndamentoEp)} />
            </>
          ) : (
            <Button size="md" fullWidth onClick={() => iniciar('ep')}>
              Nova contagem EP
            </Button>
          )}
        </div>
      </div>

      {/* Histórico */}
      {contagens.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Histórico</h2>
          <div className="space-y-2">
            {contagens.map(c => (
              <div
                key={c.id}
                className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => c.status === 'em_andamento' ? continuar(c) : verResumo(c)}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {c.tipo === 'ec' ? 'Estoque Central' : 'Estoque Produtivo'}
                    </span>
                    <Badge variant={statusVariants[c.status] ?? 'default'}>
                      {statusLabels[c.status] ?? c.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {new Date(c.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    {c.usuario && ` · ${(c.usuario as unknown as { nome: string }).nome}`}
                  </p>
                </div>
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </div>
            ))}
          </div>
        </>
      )}

      {contagens.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-gray-400">Nenhuma contagem realizada ainda.</p>
        </div>
      )}
    </div>
  )
}

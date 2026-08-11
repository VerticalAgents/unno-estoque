import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { SessaoProducao } from '../../types/database.types'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { StatusBadge } from '../../components/ui/Badge'
import { formatDate, formatDateTime } from '../../lib/utils'
import { cancelarSessao, avisoCancelamentoSessao } from '../../lib/producao'

type Sessao = SessaoProducao & {
  skus: { quantidade_planejada: number; multiplicador: number | null; ficha_tecnica: { nome: string } }[]
}

export function SessoesListPage() {
  const { profile } = useAuth()
  const [sessoes, setSessoes] = useState<Sessao[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelando, setCancelando] = useState<Sessao | null>(null)
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [recarga, setRecarga] = useState(0)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('sessoes_producao')
      .select('*, skus:sessoes_producao_skus(quantidade_planejada, multiplicador, ficha_tecnica:fichas_tecnicas(nome))')
      .eq('empresa_id', profile.empresa_id)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setSessoes((data ?? []) as unknown as Sessao[])
        setLoading(false)
      })
  }, [profile, recarga])

  const sessaoAberta = sessoes.find((s) => s.status === 'aberta')

  async function confirmarCancelamento() {
    if (!cancelando || !profile) return
    setSalvando(true)
    const { erro: msg } = await cancelarSessao(
      cancelando.id, profile.empresa_id, profile.id, motivo,
    )
    setSalvando(false)

    if (msg) { setErro(msg); return }

    setCancelando(null)
    setMotivo('')
    setErro('')
    setRecarga((n) => n + 1)
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Sessões de Produção</h1>
          <p className="text-sm text-gray-500 mt-0.5">Uma sessão = um dia de produção</p>
        </div>
        <Link to="/producao/abrir">
          <Button disabled={!!sessaoAberta} title={sessaoAberta ? 'Há uma sessão aberta' : ''}>
            Nova sessão
          </Button>
        </Link>
      </div>

      {sessaoAberta && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-800 flex items-center justify-between">
          <span>Sessão <strong>{sessaoAberta.codigo}</strong> em andamento</span>
          <Link to={`/producao/${sessaoAberta.id}/fechar`} className="underline font-medium">
            Fechar sessão →
          </Link>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sessoes.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-gray-500">Nenhuma sessão registrada.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {sessoes.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{s.codigo}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="text-sm text-gray-600 mt-0.5">{formatDate(s.data_producao)}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {(s.skus ?? []).map((sk) => {
                      const nome = sk.ficha_tecnica?.nome
                      if (!nome) return null
                      return sk.multiplicador && sk.multiplicador > 1 ? `${nome} (${sk.multiplicador}× fornadas)` : nome
                    }).filter(Boolean).join(' · ')}
                  </p>
                  {s.data_abertura && (
                    <p className="text-xs text-gray-400">Aberta: {formatDateTime(s.data_abertura)}</p>
                  )}
                </div>
                {s.status === 'aberta' && (
                  <div className="flex gap-2 shrink-0">
                    {/* A decisão de fazer algumas formas a mais ou a menos
                        acontece durante a produção, não antes dela. */}
                    <Link to={`/producao/${s.id}/editar`}>
                      <Button size="sm" variant="ghost">Editar formas</Button>
                    </Link>
                    <Link to={`/producao/${s.id}/fechar`}>
                      <Button size="sm" variant="secondary">Fechar</Button>
                    </Link>
                  </div>
                )}
              </div>

              {/* Cancelar fica embaixo e discreto: é a saída para quem abriu a
                  sessão errada, não uma opção de rotina ao lado de "Fechar". */}
              {s.status === 'aberta' && (
                <button
                  type="button"
                  onClick={() => { setCancelando(s); setMotivo(''); setErro('') }}
                  className="mt-3 text-xs text-red-600 hover:underline"
                >
                  Cancelar esta sessão
                </button>
              )}

              {s.status === 'cancelada' && s.motivo_cancelamento && (
                <p className="mt-2 text-xs text-gray-500 dark:text-unno-muted">
                  Cancelada: {s.motivo_cancelamento}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!cancelando}
        title="Cancelar esta sessão?"
        description={avisoCancelamentoSessao()}
        variant="danger"
        confirmLabel="CANCELAR A SESSÃO"
        cancelLabel="Voltar"
        loading={salvando}
        justificativa={{
          valor: motivo,
          onChange: setMotivo,
          label: 'Por que está cancelando?',
        }}
        summary={
          cancelando ? (
            <div className="space-y-1">
              <p><strong>{cancelando.codigo}</strong> — {formatDate(cancelando.data_producao)}</p>
              {erro && <p className="text-red-600">{erro}</p>}
            </div>
          ) : undefined
        }
        onConfirm={confirmarCancelamento}
        onCancel={() => { setCancelando(null); setMotivo(''); setErro('') }}
      />
    </div>
  )
}

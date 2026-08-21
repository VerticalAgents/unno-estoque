import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { SessaoProducao } from '../../types/database.types'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { StatusBadge } from '../../components/ui/Badge'
import { formatDate, formatDateTime } from '../../lib/utils'
import { cancelarSessao, avisoCancelamentoSessao } from '../../lib/producao'

/**
 * As sessões de produção, em lista ou em calendário.
 *
 * ORDENAÇÃO. A lista ordena por `data_producao`, não por `created_at`. Parece
 * detalhe e não é: a importação de produção anterior ao sistema cria dezenas de
 * sessões no mesmo instante, com datas espalhadas por meses. Ordenada por
 * criação, junho aparecia depois de agosto e a lista parecia embaralhada.
 * `created_at` sobra como desempate — é o que separa duas sessões do mesmo dia.
 *
 * O CALENDÁRIO responde a outra pergunta, que a lista responde mal: "em que
 * dias a fábrica trabalhou?". Numa lista, buraco não se enxerga; num mês
 * desenhado, a semana vazia salta. A grade segue a do Planejador (aba Mês) de
 * propósito — mesma forma, mesma navegação — para não haver dois calendários
 * diferentes no mesmo sistema.
 *
 * A COR diz de onde o número veio. Com metade do histórico digitado de memória
 * e a outra metade medida pelo sistema, essa é a distinção que importa ao
 * bater o olho — mais do que o status da sessão.
 */

type SkuLinha = {
  quantidade_planejada: number | null
  quantidade_produzida: number | null
  multiplicador: number | null
  ficha_tecnica: { nome: string } | null
}

type Sessao = SessaoProducao & { skus: SkuLinha[] }

const SELECT_SESSAO =
  '*, skus:sessoes_producao_skus(quantidade_planejada, quantidade_produzida, multiplicador, ficha_tecnica:fichas_tecnicas(nome))'

const DIAS_CABECALHO = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

// Datas sempre como string YYYY-MM-DD, montadas componente a componente:
// `new Date('2026-08-03')` é meia-noite UTC e no Brasil cai no dia 2.
function paraISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function paraData(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d)
}

/** A segunda-feira da semana em que a data cai. */
function segundaDa(d: Date): Date {
  const copia = new Date(d)
  const dow = copia.getDay()
  copia.setDate(copia.getDate() + (dow === 0 ? -6 : 1 - dow))
  return copia
}

const soData = (v: unknown) => String(v).slice(0, 10)

/** Os produtos da sessão, em texto curto. */
function produtosDa(s: Sessao): string {
  return (s.skus ?? [])
    .map(sk => {
      const nome = sk.ficha_tecnica?.nome
      if (!nome) return null
      return sk.multiplicador && sk.multiplicador > 1
        ? `${nome} (${sk.multiplicador}× fornadas)`
        : nome
    })
    .filter(Boolean)
    .join(' · ')
}

function unidadesDa(s: Sessao): number {
  return (s.skus ?? []).reduce(
    (t, sk) => t + (sk.quantidade_produzida ?? sk.quantidade_planejada ?? 0), 0)
}

export function SessoesListPage() {
  const { profile } = useAuth()
  const hoje = new Date()

  const [vista, setVista] = useState<'lista' | 'calendario'>('lista')
  const [sessoes, setSessoes] = useState<Sessao[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelando, setCancelando] = useState<Sessao | null>(null)
  const [motivo, setMotivo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [recarga, setRecarga] = useState(0)

  const [ano, setAno] = useState(hoje.getFullYear())
  const [mes, setMes] = useState(hoje.getMonth())     // 0 = janeiro
  const [doMes, setDoMes] = useState<Sessao[]>([])
  const [carregandoMes, setCarregandoMes] = useState(false)

  // ── Lista ────────────────────────────────────────────────
  useEffect(() => {
    if (!profile) return
    supabase
      .from('sessoes_producao')
      .select(SELECT_SESSAO)
      .eq('empresa_id', profile.empresa_id)
      .order('data_producao', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setSessoes((data ?? []) as unknown as Sessao[])
        setLoading(false)
      })
  }, [profile, recarga])

  // ── Calendário ───────────────────────────────────────────
  /** As semanas que cobrem o mês, sempre começando na segunda. */
  const semanas = useMemo(() => {
    const primeiro = new Date(ano, mes, 1)
    const ultimo = new Date(ano, mes + 1, 0)
    const cursor = segundaDa(primeiro)
    const out: string[][] = []
    while (cursor <= ultimo || out.length === 0) {
      const semana: string[] = []
      for (let i = 0; i < 7; i++) {
        semana.push(paraISO(cursor))
        cursor.setDate(cursor.getDate() + 1)
      }
      out.push(semana)
      if (out.length >= 6) break
    }
    return out
  }, [ano, mes])

  const primeiroDia = semanas[0]?.[0]
  const ultimoDia = semanas[semanas.length - 1]?.[6]

  const carregarMes = useCallback(async () => {
    if (!profile || vista !== 'calendario' || !primeiroDia || !ultimoDia) return
    setCarregandoMes(true)
    const { data } = await supabase
      .from('sessoes_producao')
      .select(SELECT_SESSAO)
      .eq('empresa_id', profile.empresa_id)
      .gte('data_producao', primeiroDia)
      .lte('data_producao', ultimoDia)
      .order('data_producao')
    setDoMes((data ?? []) as unknown as Sessao[])
    setCarregandoMes(false)
  }, [profile, vista, primeiroDia, ultimoDia, recarga])

  useEffect(() => { carregarMes() }, [carregarMes])

  const porDia = useMemo(() => {
    const mapa = new Map<string, Sessao[]>()
    for (const s of doMes) {
      const dia = soData(s.data_producao)
      mapa.set(dia, [...(mapa.get(dia) ?? []), s])
    }
    return mapa
  }, [doMes])

  /** Só o que cai dentro do mês — as bordas das semanas vazam para os vizinhos. */
  const resumoMes = useMemo(() => {
    const noMes = doMes.filter(
      s => paraData(soData(s.data_producao)).getMonth() === mes && s.status !== 'cancelada')
    return {
      dias: new Set(noMes.map(s => soData(s.data_producao))).size,
      unidades: noMes.reduce((t, s) => t + unidadesDa(s), 0),
      importadas: noMes.filter(s => s.importada).length,
    }
  }, [doMes, mes])

  const sessaoAberta = sessoes.find(s => s.status === 'aberta')
  const hojeISO = paraISO(hoje)

  function mudarMes(delta: -1 | 1) {
    const d = new Date(ano, mes + delta, 1)
    setAno(d.getFullYear())
    setMes(d.getMonth())
  }

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
    setRecarga(n => n + 1)
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Sessões de Produção</h1>
          <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">Uma sessão = um dia de produção</p>
        </div>
        <Link to="/producao/abrir">
          <Button disabled={!!sessaoAberta} title={sessaoAberta ? 'Há uma sessão aberta' : ''}>
            Nova sessão
          </Button>
        </Link>
      </div>

      <div className="inline-flex rounded-lg border border-gray-200 dark:border-white/[.08] p-0.5 mb-4">
        {(['lista', 'calendario'] as const).map(v => (
          <button
            key={v}
            type="button"
            onClick={() => setVista(v)}
            className={[
              'px-3 py-1.5 text-sm rounded-md min-h-[36px]',
              vista === v
                ? 'bg-brand-600 text-white font-medium'
                : 'text-gray-600 dark:text-unno-muted hover:bg-gray-50 dark:hover:bg-white/[.03]',
            ].join(' ')}
          >
            {v === 'lista' ? 'Lista' : 'Calendário'}
          </button>
        ))}
      </div>

      {sessaoAberta && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-800 flex items-center justify-between">
          <span>Sessão <strong>{sessaoAberta.codigo}</strong> em andamento</span>
          <Link to={`/producao/${sessaoAberta.id}/fechar`} className="underline font-medium">
            Fechar sessão →
          </Link>
        </div>
      )}

      {vista === 'calendario' ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex items-center justify-between gap-3 py-3">
              <Button variant="ghost" size="sm" onClick={() => mudarMes(-1)}>‹ Anterior</Button>
              <p className="text-sm font-semibold text-gray-900 dark:text-unno-text capitalize">
                {MESES[mes]} de {ano}
              </p>
              <Button variant="ghost" size="sm" onClick={() => mudarMes(1)}>Próximo ›</Button>
            </CardBody>
          </Card>

          <div className="grid gap-3 grid-cols-3">
            {[
              { r: 'Dias com produção', v: String(resumoMes.dias) },
              { r: 'Unidades', v: resumoMes.unidades.toLocaleString('pt-BR') },
              { r: 'De memória', v: String(resumoMes.importadas) },
            ].map(c => (
              <Card key={c.r}>
                <CardBody className="py-3">
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-unno-muted">{c.r}</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-unno-text mt-0.5 tabular-nums">{c.v}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader
              title="Calendário"
              subtitle={carregandoMes ? 'carregando…' : 'Os dias em que a fábrica produziu'}
            />
            <CardBody className="p-0 overflow-x-auto">
              <div className="min-w-[44rem]">
                <div className="grid grid-cols-7 border-b border-gray-200 dark:border-white/[.06]">
                  {DIAS_CABECALHO.map(d => (
                    <div key={d} className="px-2 py-2 text-xs uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                      {d}
                    </div>
                  ))}
                </div>

                {semanas.map(semana => (
                  <div
                    key={semana[0]}
                    className="grid grid-cols-7 border-b border-gray-100 dark:border-white/[.04] last:border-0"
                  >
                    {semana.map(dia => {
                      const d = paraData(dia)
                      const foraDoMes = d.getMonth() !== mes
                      const itens = porDia.get(dia) ?? []
                      return (
                        <div
                          key={dia}
                          className={[
                            'px-1.5 py-1.5 min-h-[5rem] border-r border-gray-100 dark:border-white/[.04] last:border-r-0',
                            foraDoMes ? 'bg-gray-50/60 dark:bg-white/[.01]' : '',
                            dia === hojeISO ? 'ring-1 ring-inset ring-brand-500/40' : '',
                          ].join(' ')}
                        >
                          <span className={[
                            'text-xs tabular-nums',
                            foraDoMes
                              ? 'text-gray-300 dark:text-unno-dim'
                              : dia === hojeISO
                                ? 'text-brand-700 dark:text-brand-400 font-semibold'
                                : 'text-gray-400',
                          ].join(' ')}>
                            {d.getDate()}
                          </span>

                          <div className="mt-1 space-y-0.5">
                            {itens.map(s => {
                              const cor = s.status === 'cancelada'
                                ? 'bg-gray-100 text-gray-400 line-through dark:bg-white/[.04] dark:text-unno-dim'
                                : s.status === 'aberta'
                                  ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                                  : s.importada
                                    ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                                    : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                              const conteudo = (
                                <>
                                  <span className="block truncate font-medium">{produtosDa(s) || s.codigo}</span>
                                  <span className="block tabular-nums opacity-80">
                                    {unidadesDa(s).toLocaleString('pt-BR')} un
                                  </span>
                                </>
                              )
                              return s.status === 'aberta' ? (
                                <Link
                                  key={s.id}
                                  to={`/producao/${s.id}/fechar`}
                                  className={`block text-[0.7rem] leading-tight rounded px-1 py-0.5 ${cor}`}
                                  title={`${s.codigo} — clique para fechar`}
                                >
                                  {conteudo}
                                </Link>
                              ) : (
                                <div
                                  key={s.id}
                                  className={`text-[0.7rem] leading-tight rounded px-1 py-0.5 ${cor}`}
                                  title={`${s.codigo}${s.importada ? ' — lançada de memória' : ''}`}
                                >
                                  {conteudo}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-unno-muted px-1">
            {[
              ['bg-emerald-100 dark:bg-emerald-500/25', 'medida pelo sistema'],
              ['bg-amber-100 dark:bg-amber-500/25', 'lançada de memória'],
              ['bg-blue-100 dark:bg-blue-500/25', 'em andamento'],
              ['bg-gray-200 dark:bg-white/[.10]', 'cancelada'],
            ].map(([cor, texto]) => (
              <span key={texto} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${cor}`} />
                {texto}
              </span>
            ))}
          </div>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sessoes.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-gray-500 dark:text-unno-muted">Nenhuma sessão registrada.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {sessoes.map(s => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-medium">{s.codigo}</span>
                    <StatusBadge status={s.status} />
                    {s.importada && (
                      <span className="text-[0.65rem] uppercase tracking-wide px-1.5 py-0.5 rounded
                                       bg-amber-50 text-amber-700 border border-amber-200
                                       dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
                        de memória
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-unno-muted mt-0.5">{formatDate(s.data_producao)}</p>
                  <p className="text-xs text-gray-400 mt-1">{produtosDa(s)}</p>
                  {s.data_abertura && !s.importada && (
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

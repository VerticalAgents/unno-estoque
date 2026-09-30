import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'

/**
 * O mês inteiro numa tela.
 *
 * A aba Semana é onde se planeja; esta é onde se enxerga. O calendário mostra
 * as SESSÕES DE PRODUÇÃO — planejadas, abertas e fechadas — lidas direto de
 * `sessoes_producao`. Até 30/09/2026 ele lia só `v_plano_semana`, que parte dos
 * planos semanais: com a meta fixa da Meta Odara ninguém mais salva plano, e
 * setembro inteiro aparecia vazio com 16 sessões feitas.
 *
 * O plano semanal, onde existir, ainda aparece — como chip tracejado, só nos
 * dias em que não virou sessão.
 */

const FORMAS_POR_BATELADA = 4
const DIAS_CABECALHO = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

type Situacao = 'planejada' | 'aberta' | 'fechada' | 'plano'

/** Uma ficha numa sessão (ou numa linha de plano semanal sem sessão). */
interface Chip {
  key: string
  data: string
  ficha_id: string
  ficha_codigo: string
  ficha_nome: string
  situacao: Situacao
  sessao: string | null
  /** Fechada: o que saiu do forno. Senão: o que foi planejado. */
  formas: number
  /** Só nas fechadas. */
  unidades_produzidas: number | null
  /** Planejada e aberta: o que se espera tirar. */
  unidades_previstas: number
}

const COR: Record<Situacao, string> = {
  planejada: 'bg-gray-100 text-gray-700 dark:bg-white/[.06] dark:text-unno-text',
  aberta: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  fechada: 'bg-brand-500/10 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  plano: 'border border-dashed border-gray-300 text-gray-500 dark:border-white/20 dark:text-unno-muted',
}

const LEGENDA: { s: Situacao; rotulo: string; amostra: string }[] = [
  { s: 'planejada', rotulo: 'sessão planejada', amostra: 'bg-gray-100 dark:bg-white/[.06]' },
  { s: 'aberta', rotulo: 'sessão aberta', amostra: 'bg-blue-100 dark:bg-blue-500/30' },
  { s: 'fechada', rotulo: 'sessão fechada', amostra: 'bg-brand-500/20' },
  { s: 'plano', rotulo: 'plano semanal sem sessão', amostra: 'border border-dashed border-gray-400' },
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

function fmt(n: number, casas = 0) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

interface SessaoBanco {
  id: string
  codigo: string
  status: 'planejada' | 'aberta' | 'fechada'
  data_producao: string
  sessoes_producao_skus: {
    id: string
    ficha_tecnica_id: string
    multiplicador: number | null
    formas_assadas: number | null
    quantidade_planejada: number | null
    quantidade_produzida: number | null
    ficha: { codigo: string; nome: string } | null
  }[]
}

export function PlanejadorMesPage({
  onAbrirSemana,
}: {
  /** Leva para a aba Semana já naquela segunda-feira. */
  onAbrirSemana?: (segunda: string) => void
}) {
  const { profile } = useAuth()
  const hoje = new Date()

  const [ano, setAno] = useState(hoje.getFullYear())
  const [mes, setMes] = useState(hoje.getMonth())      // 0 = janeiro
  const [chips, setChips] = useState<Chip[]>([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')

  /** As 6 semanas que cobrem o mês, sempre começando na segunda. */
  const semanas = useMemo(() => {
    const primeiro = new Date(ano, mes, 1)
    const ultimo = new Date(ano, mes + 1, 0)
    const inicio = segundaDa(primeiro)
    const out: string[][] = []
    const cursor = new Date(inicio)
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

  const carregar = useCallback(async () => {
    if (!profile || !primeiroDia || !ultimoDia) return
    setLoading(true)
    const [sess, plano] = await Promise.all([
      supabase
        .from('sessoes_producao')
        .select(`id, codigo, status, data_producao,
          sessoes_producao_skus(id, ficha_tecnica_id, multiplicador, formas_assadas,
            quantidade_planejada, quantidade_produzida,
            ficha:fichas_tecnicas!ficha_tecnica_id(codigo, nome))`)
        .eq('empresa_id', profile.empresa_id)
        .neq('status', 'cancelada')
        .gte('data_producao', primeiroDia)
        .lte('data_producao', ultimoDia),
      supabase
        .from('v_plano_semana')
        .select('data, ficha_id, ficha_codigo, ficha_nome, formas_planejadas, unidades_planejadas')
        .eq('empresa_id', profile.empresa_id)
        .gt('formas_planejadas', 0)
        .gte('data', primeiroDia)
        .lte('data', ultimoDia),
    ])

    const falha = sess.error ?? plano.error
    if (falha) { setErro(falha.message); setLoading(false); return }
    setErro('')

    const out: Chip[] = []
    const comSessao = new Set<string>()
    for (const s of (sess.data ?? []) as unknown as SessaoBanco[]) {
      const data = String(s.data_producao).slice(0, 10)
      for (const k of s.sessoes_producao_skus ?? []) {
        const fechada = s.status === 'fechada'
        comSessao.add(`${data}|${k.ficha_tecnica_id}`)
        out.push({
          key: k.id,
          data,
          ficha_id: k.ficha_tecnica_id,
          ficha_codigo: k.ficha?.codigo ?? '?',
          ficha_nome: k.ficha?.nome ?? '',
          situacao: s.status,
          sessao: s.codigo,
          formas: Number((fechada ? k.formas_assadas ?? k.multiplicador : k.multiplicador) ?? 0),
          unidades_produzidas: fechada ? Number(k.quantidade_produzida ?? 0) : null,
          unidades_previstas: Number(k.quantidade_planejada ?? 0),
        })
      }
    }
    // O banco devolve as somas como texto (são bigint): converter antes de somar.
    for (const r of (plano.data ?? []) as unknown as Record<string, unknown>[]) {
      const data = String(r.data).slice(0, 10)
      const fichaId = String(r.ficha_id)
      if (comSessao.has(`${data}|${fichaId}`)) continue
      out.push({
        key: `plano-${data}-${fichaId}`,
        data,
        ficha_id: fichaId,
        ficha_codigo: String(r.ficha_codigo),
        ficha_nome: String(r.ficha_nome),
        situacao: 'plano',
        sessao: null,
        formas: Number(r.formas_planejadas ?? 0),
        unidades_produzidas: null,
        unidades_previstas: Number(r.unidades_planejadas ?? 0),
      })
    }
    out.sort((a, b) => (a.ficha_codigo < b.ficha_codigo ? -1 : 1))
    setChips(out)
    setLoading(false)
  }, [profile, primeiroDia, ultimoDia])

  useEffect(() => { carregar() }, [carregar])

  const porDia = useMemo(() => {
    const mapa = new Map<string, Chip[]>()
    for (const c of chips) {
      const atual = mapa.get(c.data) ?? []
      atual.push(c)
      mapa.set(c.data, atual)
    }
    return mapa
  }, [chips])

  /** Só sessões, e só o que cai dentro do mês — as bordas das semanas vazam. */
  const doMes = useMemo(
    () => chips.filter(c => c.situacao !== 'plano' && paraData(c.data).getMonth() === mes),
    [chips, mes],
  )

  const totais = useMemo(() => {
    const formas = doMes.reduce((s, c) => s + c.formas, 0)
    // Bateladas por ficha e por sessão: uma batelada não mistura produtos.
    const bateladas = doMes.reduce((s, c) => s + Math.ceil(c.formas / FORMAS_POR_BATELADA), 0)
    const fechadas = doMes.filter(c => c.situacao === 'fechada')
    const produzidas = fechadas.reduce((s, c) => s + (c.unidades_produzidas ?? 0), 0)
    const previstas = doMes
      .filter(c => c.situacao !== 'fechada')
      .reduce((s, c) => s + c.unidades_previstas, 0)
    const formasFechadas = fechadas.reduce((s, c) => s + c.formas, 0)
    const sessoesFechadas = new Set(fechadas.map(c => c.sessao)).size
    const dias = new Set(doMes.map(c => c.data)).size
    return { formas, bateladas, produzidas, previstas, formasFechadas, sessoesFechadas, dias }
  }, [doMes])

  const porFicha = useMemo(() => {
    const mapa = new Map<string, { codigo: string; nome: string; formas: number; fechadas: number }>()
    for (const c of doMes) {
      const atual = mapa.get(c.ficha_id)
        ?? { codigo: c.ficha_codigo, nome: c.ficha_nome, formas: 0, fechadas: 0 }
      atual.formas += c.formas
      if (c.situacao === 'fechada') atual.fechadas += c.formas
      mapa.set(c.ficha_id, atual)
    }
    return [...mapa.values()].sort((a, b) => (a.codigo < b.codigo ? -1 : 1))
  }, [doMes])

  const hojeISO = paraISO(hoje)

  function mudarMes(delta: -1 | 1) {
    const d = new Date(ano, mes + delta, 1)
    setAno(d.getFullYear())
    setMes(d.getMonth())
  }

  return (
    <div className="space-y-5">
      {/* ── Navegação ───────────────────────────────────────── */}
      <Card>
        <CardBody className="flex items-center justify-between gap-3 py-3">
          <Button variant="ghost" size="sm" onClick={() => mudarMes(-1)}>‹ Anterior</Button>
          <p className="text-sm font-semibold text-gray-900 dark:text-unno-text capitalize">
            {MESES[mes]} de {ano}
          </p>
          <Button variant="ghost" size="sm" onClick={() => mudarMes(1)}>Próximo ›</Button>
        </CardBody>
      </Card>

      {erro && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{erro}</div>
      )}

      {/* ── Resumo do mês ───────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { r: 'Formas', v: `${fmt(totais.formas)} formas`, s: `${fmt(totais.bateladas)} bateladas` },
          {
            r: 'Unidades',
            v: fmt(totais.produzidas),
            s: totais.previstas > 0 ? `produzidas · +${fmt(totais.previstas)} previstas` : 'produzidas no mês',
          },
          { r: 'Dias com produção', v: String(totais.dias), s: 'no mês' },
          totais.sessoesFechadas > 0
            ? {
                r: 'Produzido',
                v: `${fmt(totais.formasFechadas)} formas`,
                s: `${totais.sessoesFechadas} ${totais.sessoesFechadas === 1 ? 'sessão fechada' : 'sessões fechadas'}`,
              }
            : { r: 'Produzido', v: '—', s: 'nenhuma sessão fechada' },
        ].map(c => (
          <Card key={c.r}>
            <CardBody className="py-3">
              <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-unno-muted">{c.r}</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-unno-text mt-0.5">{c.v}</p>
              <p className="text-xs text-gray-400">{c.s}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* ── Calendário ──────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Calendário"
          subtitle="Clique numa semana para abrir o planejamento dela"
        />
        <CardBody className="p-0 overflow-x-auto">
          <div className="min-w-[44rem]">
            <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-gray-200 dark:border-white/[.06]">
              <div />
              {DIAS_CABECALHO.map(d => (
                <div key={d} className="px-2 py-2 text-xs uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                  {d}
                </div>
              ))}
            </div>

            {semanas.map(semana => {
              const formasSemana = semana.reduce(
                (s, dia) => s + (porDia.get(dia) ?? [])
                  .filter(c => c.situacao !== 'plano')
                  .reduce((t, c) => t + c.formas, 0), 0)
              return (
                <div
                  key={semana[0]}
                  className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-gray-100 dark:border-white/[.04] last:border-0"
                >
                  {/* Coluna da semana: atalho para a aba de planejamento */}
                  <button
                    type="button"
                    onClick={() => onAbrirSemana?.(semana[0])}
                    className="px-2 py-2 text-left border-r border-gray-100 dark:border-white/[.04]
                               hover:bg-gray-50 dark:hover:bg-white/[.02]"
                    title="Abrir esta semana no planejador"
                  >
                    <span className="block text-xs text-gray-400">semana</span>
                    <span className="block text-xs font-medium text-gray-700 dark:text-unno-text tabular-nums">
                      {formasSemana > 0 ? `${formasSemana}f` : '—'}
                    </span>
                  </button>

                  {semana.map(dia => {
                    const d = paraData(dia)
                    const foraDoMes = d.getMonth() !== mes
                    const itens = porDia.get(dia) ?? []
                    return (
                      <div
                        key={dia}
                        className={[
                          'px-2 py-2 min-h-[4.5rem] border-r border-gray-100 dark:border-white/[.04] last:border-r-0',
                          foraDoMes ? 'bg-gray-50/60 dark:bg-white/[.01]' : '',
                          dia === hojeISO ? 'ring-1 ring-inset ring-brand-500/40' : '',
                        ].join(' ')}
                      >
                        <span className={`text-xs tabular-nums ${
                          foraDoMes ? 'text-gray-300 dark:text-unno-dim'
                            : dia === hojeISO ? 'text-brand-700 font-semibold'
                            : 'text-gray-400'
                        }`}>
                          {d.getDate()}
                        </span>

                        <div className="mt-1 space-y-0.5">
                          {itens.map(c => (
                            <div
                              key={c.key}
                              className={`text-[0.7rem] leading-tight rounded px-1 py-0.5 truncate ${COR[c.situacao]}`}
                              title={[
                                c.sessao ?? 'plano semanal',
                                c.situacao === 'plano' ? null : `sessão ${c.situacao}`,
                                `${c.ficha_codigo} ${c.ficha_nome}`,
                                c.unidades_produzidas != null ? `${fmt(c.unidades_produzidas)} unidades` : null,
                              ].filter(Boolean).join(' · ')}
                            >
                              {c.ficha_codigo.replace('FT-', '')} {c.formas}f
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* Legenda: as cores só ajudam se alguém disser o que significam */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-unno-muted">
          {LEGENDA.filter(l => chips.some(c => c.situacao === l.s)).map(l => (
            <span key={l.s} className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded ${l.amostra}`} /> {l.rotulo}
            </span>
          ))}
        </div>
      )}

      {/* ── Por produto ─────────────────────────────────────── */}
      {porFicha.length > 0 && (
        <Card>
          <CardHeader title="Por produto no mês" />
          <CardBody className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-gray-500 dark:text-unno-muted border-b border-gray-200 dark:border-white/[.06]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Produto</th>
                  <th className="text-right px-3 py-2 font-medium">Formas</th>
                  <th className="text-right px-3 py-2 font-medium">Fechadas</th>
                  <th className="text-right px-4 py-2 font-medium">Participação</th>
                </tr>
              </thead>
              <tbody>
                {porFicha.map(f => (
                  <tr key={f.codigo} className="border-b border-gray-100 dark:border-white/[.04] last:border-0">
                    <td className="px-4 py-2">
                      <span className="text-gray-400 text-xs mr-1.5">{f.codigo}</span>
                      <span className="text-gray-900 dark:text-unno-text">{f.nome}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-unno-muted">
                      {fmt(f.formas)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-900 dark:text-unno-text">
                      {fmt(f.fechadas)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">
                      {totais.formas > 0 ? `${fmt((100 * f.formas) / totais.formas, 1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {loading && <p className="text-xs text-gray-400">Carregando…</p>}

      {!loading && chips.length === 0 && (
        <Card>
          <CardBody className="text-center py-10">
            <p className="text-sm text-gray-500 dark:text-unno-muted">
              Nenhuma sessão de produção em {MESES[mes]}.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

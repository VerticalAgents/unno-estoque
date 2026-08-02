import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'

/**
 * O mês inteiro numa tela.
 *
 * A aba Semana é onde se planeja; esta é onde se enxerga. Vem de
 * `v_plano_semana` (migrations 049/051), que já traz planejado e realizado lado
 * a lado — inclusive produção que aconteceu sem estar no plano.
 *
 * O que ela NÃO mostra: semana sem plano salvo aparece vazia, mesmo que tenha
 * havido produção. A view parte dos planos, e sem plano não há com o que
 * comparar.
 */

const FORMAS_POR_BATELADA = 4
const DIAS_CABECALHO = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

interface LinhaMes {
  data: string
  ficha_id: string
  ficha_codigo: string
  ficha_nome: string
  formas_planejadas: number
  unidades_planejadas: number
  formas_realizadas: number | null
  unidades_produzidas: number | null
  em_andamento: boolean
  fora_do_plano: boolean
}

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
  const [linhas, setLinhas] = useState<LinhaMes[]>([])
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
    const { data, error } = await supabase
      .from('v_plano_semana')
      .select('data, ficha_id, ficha_codigo, ficha_nome, formas_planejadas, unidades_planejadas, formas_realizadas, unidades_produzidas, em_andamento, fora_do_plano')
      .eq('empresa_id', profile.empresa_id)
      .gte('data', primeiroDia)
      .lte('data', ultimoDia)

    if (error) { setErro(error.message); setLoading(false); return }
    setErro('')
    // O banco devolve as somas como texto (são bigint); sem converter, "44" + 1
    // viraria "441" na hora de totalizar.
    setLinhas(((data ?? []) as unknown as Record<string, unknown>[]).map(r => ({
      data: String(r.data).slice(0, 10),
      ficha_id: String(r.ficha_id),
      ficha_codigo: String(r.ficha_codigo),
      ficha_nome: String(r.ficha_nome),
      formas_planejadas: Number(r.formas_planejadas ?? 0),
      unidades_planejadas: Number(r.unidades_planejadas ?? 0),
      formas_realizadas: r.formas_realizadas == null ? null : Number(r.formas_realizadas),
      unidades_produzidas: r.unidades_produzidas == null ? null : Number(r.unidades_produzidas),
      em_andamento: Boolean(r.em_andamento),
      fora_do_plano: Boolean(r.fora_do_plano),
    })))
    setLoading(false)
  }, [profile, primeiroDia, ultimoDia])

  useEffect(() => { carregar() }, [carregar])

  const porDia = useMemo(() => {
    const mapa = new Map<string, LinhaMes[]>()
    for (const l of linhas) {
      const atual = mapa.get(l.data) ?? []
      atual.push(l)
      mapa.set(l.data, atual)
    }
    return mapa
  }, [linhas])

  /** Só o que cai dentro do mês — as bordas das semanas vazam para os vizinhos. */
  const doMes = useMemo(
    () => linhas.filter(l => paraData(l.data).getMonth() === mes),
    [linhas, mes],
  )

  const totais = useMemo(() => {
    const formas = doMes.reduce((s, l) => s + l.formas_planejadas, 0)
    const unidades = doMes.reduce((s, l) => s + l.unidades_planejadas, 0)
    const formasReais = doMes.reduce((s, l) => s + (l.formas_realizadas ?? 0), 0)
    const unidadesReais = doMes.reduce((s, l) => s + (l.unidades_produzidas ?? 0), 0)
    // Bateladas por ficha e por dia: uma batelada não mistura produtos.
    const bateladas = doMes.reduce(
      (s, l) => s + Math.ceil(l.formas_planejadas / FORMAS_POR_BATELADA), 0)
    const dias = new Set(doMes.filter(l => l.formas_planejadas > 0).map(l => l.data)).size
    return { formas, unidades, formasReais, unidadesReais, bateladas, dias }
  }, [doMes])

  const porFicha = useMemo(() => {
    const mapa = new Map<string, { codigo: string; nome: string; formas: number; reais: number }>()
    for (const l of doMes) {
      const atual = mapa.get(l.ficha_id)
        ?? { codigo: l.ficha_codigo, nome: l.ficha_nome, formas: 0, reais: 0 }
      atual.formas += l.formas_planejadas
      atual.reais += l.formas_realizadas ?? 0
      mapa.set(l.ficha_id, atual)
    }
    return [...mapa.values()].sort((a, b) => (a.codigo < b.codigo ? -1 : 1))
  }, [doMes])

  const temRealizado = doMes.some(l => l.formas_realizadas != null)
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
          { r: 'Planejado', v: `${fmt(totais.formas)} formas`, s: `${fmt(totais.bateladas)} bateladas` },
          { r: 'Unidades', v: fmt(totais.unidades), s: 'previstas no mês' },
          { r: 'Dias com produção', v: String(totais.dias), s: 'no mês' },
          temRealizado
            ? {
                r: 'Produzido',
                v: `${fmt(totais.formasReais)} formas`,
                s: totais.formas > 0
                  ? `${fmt((100 * totais.formasReais) / totais.formas, 0)}% do plano`
                  : '—',
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
                (s, dia) => s + (porDia.get(dia) ?? []).reduce((t, l) => t + l.formas_planejadas, 0), 0)
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
                    const itens = (porDia.get(dia) ?? []).filter(l => l.formas_planejadas > 0 || l.formas_realizadas != null)
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
                          {itens.map(l => (
                            <div
                              key={l.ficha_id}
                              className={[
                                'text-[0.7rem] leading-tight rounded px-1 py-0.5 truncate',
                                l.fora_do_plano ? 'bg-amber-50 text-amber-800'
                                  : l.em_andamento ? 'bg-blue-50 text-blue-700'
                                  : l.formas_realizadas != null && l.formas_realizadas !== l.formas_planejadas
                                    ? 'bg-amber-50 text-amber-800'
                                    : l.formas_realizadas != null ? 'bg-brand-500/10 text-brand-700'
                                    : 'bg-gray-100 text-gray-700 dark:bg-white/[.06] dark:text-unno-text',
                              ].join(' ')}
                              title={`${l.ficha_codigo} ${l.ficha_nome}`}
                            >
                              {l.ficha_codigo.replace('FT-', '')}{' '}
                              {l.formas_realizadas != null
                                ? `${l.formas_realizadas}/${l.formas_planejadas}f`
                                : `${l.formas_planejadas}f`}
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
      {temRealizado && (
        <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-unno-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-gray-100 dark:bg-white/[.06]" /> só planejado
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-brand-500/20" /> produzido conforme o plano
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-amber-100" /> diferente do plano
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-blue-100" /> sessão aberta
          </span>
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
                  <th className="text-right px-3 py-2 font-medium">Planejado</th>
                  {temRealizado && <th className="text-right px-3 py-2 font-medium">Produzido</th>}
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
                      {fmt(f.formas)} formas
                    </td>
                    {temRealizado && (
                      <td className="px-3 py-2 text-right tabular-nums text-gray-900 dark:text-unno-text">
                        {fmt(f.reais)} formas
                      </td>
                    )}
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

      {!loading && doMes.length === 0 && (
        <Card>
          <CardBody className="text-center py-10">
            <p className="text-sm text-gray-500 dark:text-unno-muted">
              Nenhuma semana planejada em {MESES[mes]}. Clique numa semana do calendário
              para montar o plano dela.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

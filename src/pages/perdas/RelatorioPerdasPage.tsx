import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { formatDate, formatDateTime, formatQty } from '../../lib/utils'
import type { MotivoPerdaEnum, UnidadeMedida } from '../../types/database.types'
import {
  LinhasMotivos, LegendaMotivos, corDoMotivo, corPct, fmt, paraISO, segundaDe, rotuloSemana,
} from './graficos'

/**
 * O relatório de perdas — a versão que sai em papel.
 *
 * A tela de Perdas serve para olhar todo dia; esta serve para levar à reunião,
 * mandar para o sócio ou guardar no fim do mês. Por isso ela mostra as TRÊS
 * origens de uma vez, sem abas: quem lê no papel não clica.
 *
 * As três continuam sem se somar em lugar nenhum — produto em unidades, insumo
 * em quilo/litro/unidade, e a auditoria com a sua própria periodicidade. O
 * rodapé de método explica isso a quem receber a folha sem ter acompanhado a
 * conversa.
 */

interface DiaProduto {
  data: string
  sessao_codigo: string
  ficha_nome: string
  formas: number
  no_forno: number
  descartadas: number
  aproveitadas: number
  perda_pct: number | null
}

interface MotivoDia {
  data: string
  motivo_id: string
  motivo: string
  motivo_ordem: number
  quantidade: number
}

interface PerdaAuditoria {
  tipo: 'ec' | 'ep'
  data: string
  insumo_codigo: string
  insumo_nome: string
  unidade_medida: UnidadeMedida
  categoria_cor: string | null
  teorico: number
  fisico: number
  perda: number
  perda_pct: number | null
}

interface PerdaRow {
  id: string
  codigo: string
  data: string
  quantidade: number
  unidade: UnidadeMedida
  motivo: MotivoPerdaEnum
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

const TIPO_LABEL: Record<'ec' | 'ep', string> = {
  ep: 'Estoque produtivo',
  ec: 'Estoque central',
}

/** Mesmo padrão de impressão do dossiê de rastreabilidade. */
const printStyles = `
  @page { size: A4; margin: 14mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    body * { visibility: hidden; }
    .rel-print, .rel-print * { visibility: visible; }
    .rel-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; background: #fff; }
    .rel-no-print { display: none !important; }
    .rel-bloco { break-inside: avoid; page-break-inside: avoid;
                 border: 1px solid #ddd !important; box-shadow: none !important;
                 border-radius: 6px !important; margin-bottom: 10px; }
    .rel-print table { font-size: 9.5pt; }
  }
`

const SEMANAS = 12

export function RelatorioPerdasPage() {
  const { profile } = useAuth()

  const [dias, setDias] = useState<DiaProduto[]>([])
  const [motivos, setMotivos] = useState<MotivoDia[]>([])
  const [auditoria, setAuditoria] = useState<PerdaAuditoria[]>([])
  const [perdas, setPerdas] = useState<PerdaRow[]>([])
  const [metaProduto, setMetaProduto] = useState<number | null>(null)
  const [metaInsumo, setMetaInsumo] = useState<number | null>(null)
  const [empresa, setEmpresa] = useState('')
  const [loading, setLoading] = useState(true)

  const desde = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7 * SEMANAS)
    // Começa na segunda-feira: o relatório fala em semanas fechadas.
    return segundaDe(paraISO(d))
  }, [])

  const carregar = useCallback(async () => {
    if (!profile) return
    const [d, m, a, p, cfg, emp] = await Promise.all([
      supabase.from('v_perda_produto_dia').select('*')
        .eq('empresa_id', profile.empresa_id).gte('data', desde).order('data'),
      supabase.from('v_perda_produto_motivo').select('*')
        .eq('empresa_id', profile.empresa_id).gte('data', desde).order('data'),
      supabase.from('v_perda_auditoria').select('*').order('data', { ascending: false }),
      supabase.from('perdas_insumo')
        .select('*, insumo:insumos(nome, codigo), lote:lotes(codigo), local:locais(nome)')
        .eq('empresa_id', profile.empresa_id).gte('data', desde)
        .order('data', { ascending: false }),
      supabase.from('configuracoes_sistema')
        .select('meta_perda_insumo_pct, meta_perda_produto_pct')
        .eq('empresa_id', profile.empresa_id).maybeSingle(),
      supabase.from('empresas').select('nome').eq('id', profile.empresa_id).maybeSingle(),
    ])

    setDias((d.data ?? []) as unknown as DiaProduto[])
    setMotivos((m.data ?? []) as unknown as MotivoDia[])
    setAuditoria((a.data ?? []) as unknown as PerdaAuditoria[])
    setPerdas((p.data ?? []) as unknown as PerdaRow[])
    const c = cfg.data as { meta_perda_insumo_pct: number | null; meta_perda_produto_pct: number | null } | null
    setMetaInsumo(c?.meta_perda_insumo_pct == null ? null : Number(c.meta_perda_insumo_pct))
    setMetaProduto(c?.meta_perda_produto_pct == null ? null : Number(c.meta_perda_produto_pct))
    setEmpresa((emp.data as { nome: string } | null)?.nome ?? 'Unno')
    setLoading(false)
  }, [profile, desde])

  useEffect(() => { carregar() }, [carregar])

  const listaMotivos = useMemo(() =>
    [...new Map(motivos.map(m => [m.motivo_id, m])).values()]
      .sort((a, b) => a.motivo_ordem - b.motivo_ordem)
      .map(m => ({ id: m.motivo_id, motivo: m.motivo, ordem: m.motivo_ordem })),
  [motivos])

  /** Uma linha por semana em que houve produção — semana vazia não vira zero. */
  const semanas = useMemo(() => {
    const chaves = [...new Set(dias.map(x => segundaDe(x.data)))].sort()
    return chaves.map(chave => {
      const doDia = dias.filter(x => segundaDe(x.data) === chave)
      const noForno = doDia.reduce((t, x) => t + x.no_forno, 0)
      const descartadas = doDia.reduce((t, x) => t + x.descartadas, 0)
      const fatias = new Map<string, { id: string; motivo: string; ordem: number; qtd: number }>()
      for (const mo of motivos.filter(x => segundaDe(x.data) === chave)) {
        const f = fatias.get(mo.motivo_id)
          ?? { id: mo.motivo_id, motivo: mo.motivo, ordem: mo.motivo_ordem, qtd: 0 }
        f.qtd += mo.quantidade
        fatias.set(mo.motivo_id, f)
      }
      return {
        chave, noForno, descartadas,
        pct: noForno > 0 ? (descartadas / noForno) * 100 : null,
        fatias: [...fatias.values()].sort((a, b) => a.ordem - b.ordem),
      }
    })
  }, [dias, motivos])

  const totalForno = semanas.reduce((t, s) => t + s.noForno, 0)
  const totalDescartado = semanas.reduce((t, s) => t + s.descartadas, 0)
  const pctPeriodo = totalForno > 0 ? (totalDescartado / totalForno) * 100 : null

  /** Motivos somados no período todo, do maior para o menor. */
  const motivosPeriodo = useMemo(() => {
    const m = new Map<string, { motivo: string; ordem: number; qtd: number }>()
    for (const x of motivos) {
      const f = m.get(x.motivo_id) ?? { motivo: x.motivo, ordem: x.motivo_ordem, qtd: 0 }
      f.qtd += x.quantidade
      m.set(x.motivo_id, f)
    }
    return [...m.entries()].map(([id, f]) => ({ id, ...f })).sort((a, b) => b.qtd - a.qtd)
  }, [motivos])

  const datasAuditoria = [...new Set(auditoria.map(a => a.data))].sort().reverse()

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <>
      <style>{printStyles}</style>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        <div className="rel-no-print flex flex-wrap items-center justify-between gap-3 mb-5">
          <Link to="/perdas" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Voltar
          </Link>
          <Button size="sm" onClick={() => window.print()}>Imprimir / salvar PDF</Button>
        </div>

        <div className="rel-print space-y-5">
          {/* ── Cabeçalho ─────────────────────────────────── */}
          <div className="rel-bloco">
            <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">
              Relatório de perdas
            </h1>
            <p className="text-sm text-gray-500 dark:text-unno-muted">
              {empresa} · produto de {formatDate(desde)} a {formatDate(paraISO(new Date()))}
              {' · '}insumo: todas as auditorias aplicadas
            </p>
            <p className="text-[11px] text-gray-400 mt-1">
              Emitido em {formatDateTime(new Date().toISOString())}
            </p>
          </div>

          {/* ── 1. Produto ────────────────────────────────── */}
          <Card className="rel-bloco">
            <CardHeader
              title="Produto — descarte na pós-produção"
              subtitle="Unidades descartadas sobre as que saíram do forno"
            />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-gray-400">No forno</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-unno-text">{fmt(totalForno)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-gray-400">Descartadas</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-unno-text">{fmt(totalDescartado)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-gray-400">Perda do período</p>
                  <p className={`text-xl font-bold ${pctPeriodo === null ? 'text-gray-300' : corPct(pctPeriodo)}`}>
                    {pctPeriodo === null ? '—' : `${pctPeriodo.toFixed(2)}%`}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-gray-400">Meta</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-unno-text">
                    {metaProduto === null ? '—' : `${metaProduto.toFixed(1)}%`}
                  </p>
                </div>
              </div>

              {semanas.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
                  Nenhuma pós-produção registrada no período.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase">Semana</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">No forno</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Descartadas</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Perda</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase">Contra a meta</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {semanas.map(s => (
                        <tr key={s.chave}>
                          <td className="px-2 py-2">semana de {rotuloSemana(s.chave)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(s.noForno)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(s.descartadas)}</td>
                          <td className={`px-2 py-2 text-right tabular-nums ${
                            s.pct === null ? 'text-gray-300' : corPct(s.pct)}`}>
                            {s.pct === null ? '—' : `${s.pct.toFixed(2)}%`}
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500">
                            {metaProduto === null || s.pct === null ? '—'
                              : s.pct <= metaProduto ? 'dentro'
                              : `${(s.pct - metaProduto).toFixed(2)} p.p. acima`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* ── 2. Motivos ────────────────────────────────── */}
          {motivosPeriodo.length > 0 && (
            <Card className="rel-bloco">
              <CardHeader
                title="Por que se descartou"
                subtitle="Participação de cada motivo, no período e semana a semana"
              />
              <CardBody className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase">Motivo</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Unidades</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Do descarte</th>
                        <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Do produzido</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {motivosPeriodo.map(m => (
                        <tr key={m.id}>
                          <td className="px-2 py-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                                  style={{ backgroundColor: corDoMotivo(m.ordem) }} />
                            {m.motivo}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{fmt(m.qtd)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {totalDescartado > 0 ? `${((m.qtd / totalDescartado) * 100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {totalForno > 0 ? `${((m.qtd / totalForno) * 100).toFixed(2)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div>
                  <p className="text-xs text-gray-500 dark:text-unno-muted mb-1">
                    Participação de cada motivo, semana a semana — uma linha cruzando a outra é
                    sinal de processo, não de azar.
                  </p>
                  <LinhasMotivos
                    semanas={semanas.map(s => ({ chave: s.chave, total: s.descartadas, fatias: s.fatias }))}
                    motivos={listaMotivos}
                  />
                  <div className="mt-2">
                    <LegendaMotivos motivos={listaMotivos} />
                  </div>
                </div>
              </CardBody>
            </Card>
          )}

          {/* ── 3. Detalhe por dia ────────────────────────── */}
          {dias.length > 0 && (
            <Card className="rel-bloco">
              <CardHeader title="Dia a dia" subtitle="Cada registro de pós-produção do período" />
              <CardBody className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Data</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Produção</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Ficha</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Formas</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">No forno</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Descartadas</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Perda</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                    {dias.map((d, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2">{formatDate(d.data)}</td>
                        <td className="px-4 py-2 font-mono text-xs">{d.sessao_codigo}</td>
                        <td className="px-4 py-2">{d.ficha_nome}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{d.formas}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmt(d.no_forno)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmt(d.descartadas)}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${
                          d.perda_pct === null ? 'text-gray-300' : corPct(Number(d.perda_pct))}`}>
                          {d.perda_pct === null ? '—' : `${Number(d.perda_pct).toFixed(2)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}

          {/* ── 4. Insumo — auditoria ─────────────────────── */}
          <Card className="rel-bloco">
            <CardHeader
              title="Insumo — auditoria de estoque"
              subtitle="Diferença entre o que o sistema esperava e o que a contagem encontrou"
            />
            <CardBody className="space-y-4">
              {datasAuditoria.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
                  Nenhuma auditoria aplicada até aqui. A perda de insumo passa a ser medida na
                  primeira contagem aplicada.
                </p>
              ) : (
                (['ep', 'ec'] as const).map(tipo => {
                  const doTipo = auditoria.filter(a => a.tipo === tipo)
                  if (doTipo.length === 0) return null
                  const ultima = [...new Set(doTipo.map(a => a.data))].sort().reverse()[0]
                  const linhas = doTipo
                    .filter(a => a.data === ultima && a.perda_pct !== null)
                    .sort((a, b) => Number(b.perda_pct) - Number(a.perda_pct))
                  const media = linhas.length
                    ? linhas.reduce((t, l) => t + Number(l.perda_pct), 0) / linhas.length
                    : null
                  return (
                    <div key={tipo}>
                      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
                        <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                          {TIPO_LABEL[tipo]} · {formatDate(ultima)}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-unno-muted">
                          média dos insumos{' '}
                          <strong className={media === null ? '' : corPct(media)}>
                            {media === null ? '—' : `${media.toFixed(2)}%`}
                          </strong>
                          {metaInsumo !== null && ` · meta ${metaInsumo.toFixed(1)}%`}
                        </p>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                            <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                            <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Teórico</th>
                            <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Contado</th>
                            <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Diferença</th>
                            <th className="px-2 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Perda</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                          {linhas.map(l => (
                            <tr key={l.insumo_codigo}>
                              <td className="px-2 py-2">
                                <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                      style={{ backgroundColor: l.categoria_cor ?? '#9ca3af' }} />
                                {l.insumo_nome}
                                <span className="text-xs text-gray-400 ml-1.5">{l.insumo_codigo}</span>
                              </td>
                              <td className="px-2 py-2 text-right tabular-nums">{fmt(Number(l.teorico), 3)}</td>
                              <td className="px-2 py-2 text-right tabular-nums">{fmt(Number(l.fisico), 3)}</td>
                              <td className="px-2 py-2 text-right tabular-nums">
                                {fmt(Number(l.perda), 3)} {l.unidade_medida}
                              </td>
                              <td className={`px-2 py-2 text-right tabular-nums ${corPct(Number(l.perda_pct))}`}>
                                {Number(l.perda_pct) > 0 ? '+' : ''}{Number(l.perda_pct).toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })
              )}
            </CardBody>
          </Card>

          {/* ── 5. Descartes de insumo ────────────────────── */}
          <Card className="rel-bloco">
            <CardHeader
              title="Insumo — descartes registrados"
              subtitle="Vencimento, contaminação, queda — com lote identificado"
            />
            <CardBody className="p-0 overflow-x-auto">
              {perdas.length === 0 ? (
                <p className="px-4 py-6 text-sm text-center text-gray-400">
                  Nenhum descarte de insumo registrado no período.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Data</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Lote</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Qtd</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Motivo</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Local</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                    {perdas.map(p => (
                      <tr key={p.id}>
                        <td className="px-4 py-2">{formatDate(p.data)}</td>
                        <td className="px-4 py-2">
                          {p.insumo?.nome}
                          <span className="text-xs text-gray-400 ml-1.5">{p.insumo?.codigo}</span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">{p.lote?.codigo}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          -{formatQty(p.quantidade, p.unidade)}
                        </td>
                        <td className="px-4 py-2 text-xs">{MOTIVO_LABELS[p.motivo]}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{p.local?.nome ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {/* ── Método ────────────────────────────────────── */}
          <div className="rel-bloco text-[11px] text-gray-500 dark:text-unno-muted space-y-1 px-1">
            <p className="font-semibold uppercase tracking-wide text-gray-400">Como estes números são medidos</p>
            <p>
              <strong>Produto:</strong> unidades descartadas na pós-produção sobre as que saíram do
              forno (formas abertas × rendimento da ficha), por dia de registro. Semana sem produção
              não entra na conta — ela não tem perda, tem ausência de produção.
            </p>
            <p>
              <strong>Insumo:</strong> diferença entre o estoque teórico e o contado, apurada a cada
              auditoria aplicada. Não tem periodicidade fixa: a série anda quando uma contagem é
              aplicada. A média mostrada é a média dos percentuais dos insumos, não uma soma — eles
              estão em quilo, litro e unidade, e somá-los daria um número sem significado.
            </p>
            <p>
              <strong>As três origens não se somam</strong> e não formam um total único. Produto está
              em unidades; insumo, em massa e volume; e cada um é medido num momento diferente.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

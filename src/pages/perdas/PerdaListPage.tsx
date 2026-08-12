import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate, formatQty } from '../../lib/utils'
import type { MotivoPerdaEnum, UnidadeMedida } from '../../types/database.types'

/**
 * Perdas — a tela que precisa APONTAR, não somar.
 *
 * Total não diz nada: 3% de perda pode ser rotina ou pode ser um forno
 * desregulado. O que denuncia é a COMPOSIÇÃO mudando ao longo do tempo — a
 * faixa de "assado em demasia" engordando semana a semana aparece antes de o
 * total mexer, e é aí que se olha o termostato.
 *
 * A fábrica perde de três jeitos, e eles não se somam:
 *
 *   1. PRODUTO descartado na pós-produção — em unidades, com motivo e data desde
 *      a 092. Tem denominador natural (o que saiu do forno), então percentual,
 *      semana e composição são todos legítimos.
 *   2. INSUMO que some entre duas auditorias — em kg, L ou unidade. Não tem
 *      semana: a série é por AUDITORIA, porque duas contagens podem estar a dez
 *      dias ou a um mês de distância. E não se soma entre insumos de unidades
 *      diferentes: o número global honesto é a média dos percentuais, e quem
 *      aponta de verdade é o ranking.
 *   3. INSUMO descartado com motivo conhecido e lote identificado.
 *
 * Uma aba para cada, cada uma com a sua meta. Nenhum número desta tela mistura
 * as três.
 */

// ── Tipos ────────────────────────────────────────────────────

type Aba = 'produto' | 'insumo' | 'registros'

/** `v_perda_produto_dia` (migration 095). */
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

/** `v_perda_produto_motivo` (migration 095). */
interface MotivoDia {
  data: string
  motivo_id: string
  motivo: string
  motivo_ordem: number
  quantidade: number
}

/** `v_perda_auditoria` (migration 066). */
interface PerdaAuditoria {
  contagem_id: string
  tipo: 'ec' | 'ep'
  data: string
  insumo_codigo: string
  insumo_nome: string
  unidade_medida: UnidadeMedida
  categoria: string | null
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

const TIPO_LABEL: Record<'ec' | 'ep', string> = {
  ep: 'Estoque produtivo (produção)',
  ec: 'Estoque central (armazém)',
}

/**
 * Cor por ORDEM do motivo, não por posição na lista carregada: a faixa do
 * "queimado" tem de ser a mesma cor toda semana, senão comparar duas barras
 * vira adivinhação.
 */
const CORES = ['#e11d48', '#f59e0b', '#0ea5e9', '#8b5cf6', '#10b981', '#f43f5e', '#64748b', '#84cc16']
const corDoMotivo = (ordem: number) => CORES[Math.abs(ordem) % CORES.length]

/** Mesma escala do resto do sistema. */
function corPct(pct: number): string {
  return pct <= 3 ? 'text-emerald-600' : pct <= 8 ? 'text-yellow-600' : 'text-red-600'
}

function fmt(n: number, casas = 0) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: casas })
}

// Datas montadas componente a componente: `new Date('2026-08-03')` é meia-noite
// UTC e no Brasil cai no dia 2.
function paraISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function paraData(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d)
}

/** A segunda-feira da semana em que a data cai. */
function segundaDe(iso: string): string {
  const d = paraData(iso)
  const dow = d.getDay()
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow))
  return paraISO(d)
}

function rotuloSemana(iso: string): string {
  const d = paraData(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── Gráficos, sem biblioteca ─────────────────────────────────

/** Colunas de percentual com a linha da meta atravessando. */
function BarrasSemana({
  semanas, meta,
}: {
  semanas: { chave: string; pct: number | null; descartadas: number }[]
  meta: number | null
}) {
  const maior = Math.max(...semanas.map(s => s.pct ?? 0), meta ?? 0, 1)
  return (
    <div className="relative pt-2">
      {meta !== null && (
        <div
          className="absolute left-0 right-0 border-t border-dashed border-emerald-500/70 z-10"
          style={{ bottom: `${28 + (meta / maior) * 100}px` }}
        >
          <span className="absolute -top-4 right-0 text-[10px] text-emerald-600">
            meta {meta.toFixed(1)}%
          </span>
        </div>
      )}
      <div className="flex items-end gap-1.5 h-[100px]">
        {semanas.map(s => (
          <div key={s.chave} className="flex-1 flex flex-col justify-end items-center h-full" title={
            s.pct === null ? 'sem produção nesta semana' : `${s.pct.toFixed(2)}% · ${s.descartadas} un`
          }>
            {s.pct === null ? (
              <div className="w-full h-[3px] rounded bg-gray-200 dark:bg-white/10" />
            ) : (
              <div
                className={`w-full rounded-t ${
                  meta !== null && s.pct > meta ? 'bg-red-400' : 'bg-brand-500'
                }`}
                style={{ height: `${Math.max((s.pct / maior) * 100, 2)}px` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1">
        {semanas.map(s => (
          <span key={s.chave} className="flex-1 text-[10px] text-center text-gray-400">
            {rotuloSemana(s.chave)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Composição percentual por motivo, semana a semana. */
function BarrasEmpilhadas({
  semanas,
}: {
  semanas: { chave: string; total: number; fatias: { motivo: string; ordem: number; qtd: number }[] }[]
}) {
  return (
    <div>
      <div className="flex items-end gap-1.5 h-[100px]">
        {semanas.map(s => (
          <div key={s.chave} className="flex-1 h-full flex flex-col justify-end">
            {s.total === 0 ? (
              <div className="w-full h-[3px] rounded bg-gray-200 dark:bg-white/10" />
            ) : (
              <div className="w-full h-full flex flex-col-reverse rounded overflow-hidden">
                {s.fatias.map(f => (
                  <div
                    key={f.motivo}
                    style={{
                      height: `${(f.qtd / s.total) * 100}%`,
                      backgroundColor: corDoMotivo(f.ordem),
                    }}
                    title={`${f.motivo}: ${f.qtd} un (${((f.qtd / s.total) * 100).toFixed(0)}%)`}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1">
        {semanas.map(s => (
          <span key={s.chave} className="flex-1 text-[10px] text-center text-gray-400">
            {rotuloSemana(s.chave)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Campo de meta que grava em `configuracoes_sistema`. */
function CampoMeta({
  valor, onGravar, rotulo,
}: {
  valor: number | null
  rotulo: string
  onGravar: (v: number | null) => Promise<void>
}) {
  const [texto, setTexto] = useState(valor === null ? '' : String(valor).replace('.', ','))
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    setTexto(valor === null ? '' : String(valor).replace('.', ','))
  }, [valor])

  async function gravar() {
    const limpo = texto.trim().replace(',', '.')
    const n = limpo === '' ? null : parseFloat(limpo)
    if (n !== null && (isNaN(n) || n < 0 || n > 100)) return
    setSalvando(true)
    await onGravar(n)
    setSalvando(false)
  }

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{rotulo}</p>
      <div className="flex items-baseline gap-1">
        <input
          value={texto}
          onChange={e => setTexto(e.target.value)}
          onBlur={gravar}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="—"
          className="w-14 bg-transparent text-xl font-bold text-gray-900 dark:text-unno-text
                     border-b border-dashed border-gray-300 focus:outline-none focus:border-brand-500"
        />
        <span className="text-sm text-gray-400">{salvando ? 'salvando…' : '%'}</span>
      </div>
      <p className="text-[11px] text-gray-400">em branco = sem meta</p>
    </div>
  )
}

// ── Página ───────────────────────────────────────────────────

export function PerdaListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [aba, setAba] = useState<Aba>('produto')
  const [dias, setDias] = useState<DiaProduto[]>([])
  const [motivos, setMotivos] = useState<MotivoDia[]>([])
  const [auditoria, setAuditoria] = useState<PerdaAuditoria[]>([])
  const [perdas, setPerdas] = useState<PerdaRow[]>([])
  const [metaProduto, setMetaProduto] = useState<number | null>(null)
  const [metaInsumo, setMetaInsumo] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [filtroMotivo, setFiltroMotivo] = useState('')
  const [tipoAuditoria, setTipoAuditoria] = useState<'ep' | 'ec'>('ep')

  const carregar = useCallback(async () => {
    if (!profile) return
    // 12 semanas para trás: o suficiente para ver tendência sem carregar o ano.
    const desde = new Date()
    desde.setDate(desde.getDate() - 7 * 12)

    const [d, m, a, p, cfg] = await Promise.all([
      supabase.from('v_perda_produto_dia').select('*')
        .eq('empresa_id', profile.empresa_id).gte('data', paraISO(desde)).order('data'),
      supabase.from('v_perda_produto_motivo').select('*')
        .eq('empresa_id', profile.empresa_id).gte('data', paraISO(desde)).order('data'),
      supabase.from('v_perda_auditoria').select('*').order('data', { ascending: false }),
      supabase.from('perdas_insumo')
        .select('*, insumo:insumos(nome, codigo), lote:lotes(codigo), local:locais(nome)')
        .eq('empresa_id', profile.empresa_id)
        .order('data', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('configuracoes_sistema')
        .select('meta_perda_insumo_pct, meta_perda_produto_pct')
        .eq('empresa_id', profile.empresa_id).maybeSingle(),
    ])

    setDias((d.data ?? []) as unknown as DiaProduto[])
    setMotivos((m.data ?? []) as unknown as MotivoDia[])
    setAuditoria((a.data ?? []) as unknown as PerdaAuditoria[])
    setPerdas((p.data ?? []) as unknown as PerdaRow[])
    const c = cfg.data as { meta_perda_insumo_pct: number | null; meta_perda_produto_pct: number | null } | null
    setMetaInsumo(c?.meta_perda_insumo_pct === null || c?.meta_perda_insumo_pct === undefined
      ? null : Number(c.meta_perda_insumo_pct))
    setMetaProduto(c?.meta_perda_produto_pct === null || c?.meta_perda_produto_pct === undefined
      ? null : Number(c.meta_perda_produto_pct))
    setLoading(false)
  }, [profile])

  useEffect(() => { carregar() }, [carregar])

  async function gravarMeta(campo: 'meta_perda_produto_pct' | 'meta_perda_insumo_pct', v: number | null) {
    if (!profile) return
    await supabase.from('configuracoes_sistema')
      .update({ [campo]: v }).eq('empresa_id', profile.empresa_id)
    if (campo === 'meta_perda_produto_pct') setMetaProduto(v)
    else setMetaInsumo(v)
  }

  // ── Produto: as 12 semanas ─────────────────────────────────
  const semanas = useMemo(() => {
    const chaves: string[] = []
    const hoje = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(hoje)
      d.setDate(d.getDate() - i * 7)
      const s = segundaDe(paraISO(d))
      if (!chaves.includes(s)) chaves.push(s)
    }

    return chaves.map(chave => {
      const doDia = dias.filter(x => segundaDe(x.data) === chave)
      const noForno = doDia.reduce((t, x) => t + x.no_forno, 0)
      const descartadas = doDia.reduce((t, x) => t + x.descartadas, 0)
      const fatias = new Map<string, { motivo: string; ordem: number; qtd: number }>()
      for (const mo of motivos.filter(x => segundaDe(x.data) === chave)) {
        const f = fatias.get(mo.motivo_id) ?? { motivo: mo.motivo, ordem: mo.motivo_ordem, qtd: 0 }
        f.qtd += mo.quantidade
        fatias.set(mo.motivo_id, f)
      }
      return {
        chave,
        noForno,
        descartadas,
        // Semana sem produção é NULA, não zero: zero diria "não perdemos nada",
        // quando o certo é "não produzimos".
        pct: noForno > 0 ? (descartadas / noForno) * 100 : null,
        fatias: [...fatias.entries()]
          .map(([id, f]) => ({ id, ...f }))
          .sort((a, b) => a.ordem - b.ordem),
      }
    })
  }, [dias, motivos])

  const comDados = semanas.filter(s => s.pct !== null)
  const ultima = comDados[comDados.length - 1]
  const media4 = comDados.slice(-5, -1)
  const mediaAnterior = media4.length
    ? media4.reduce((t, s) => t + (s.pct ?? 0), 0) / media4.length
    : null

  /**
   * O apontador: qual motivo mais ganhou participação na última semana em
   * relação às anteriores. Com menos de duas semanas medidas ele fica calado —
   * uma semana sozinha não tem com o que ser comparada, e apontar aí seria
   * ruído com cara de diagnóstico.
   */
  const oQueMudou = useMemo(() => {
    if (comDados.length < 2 || !ultima || ultima.descartadas === 0) return null
    const anteriores = comDados.slice(0, -1).filter(s => s.descartadas > 0)
    if (anteriores.length === 0) return null

    const parteNa = (s: typeof ultima, id: string) => {
      const f = s.fatias.find(x => x.id === id)
      return f ? (f.qtd / s.descartadas) * 100 : 0
    }

    let melhor: { motivo: string; agora: number; antes: number; alta: number } | null = null
    for (const f of ultima.fatias) {
      const agora = parteNa(ultima, f.id)
      const antes = anteriores.reduce((t, s) => t + parteNa(s, f.id), 0) / anteriores.length
      const alta = agora - antes
      if (!melhor || alta > melhor.alta) melhor = { motivo: f.motivo, agora, antes, alta }
    }
    return melhor && melhor.alta >= 5 ? melhor : null
  }, [comDados, ultima])

  // ── Insumo: por auditoria ──────────────────────────────────
  const doTipo = auditoria.filter(a => a.tipo === tipoAuditoria)
  const datasAuditoria = [...new Set(doTipo.map(a => a.data))].sort().reverse()
  const ultimaAuditoria = datasAuditoria[0]
  const penultima = datasAuditoria[1]

  const mediaDe = (data: string | undefined) => {
    if (!data) return null
    const pcts = doTipo.filter(a => a.data === data && a.perda_pct !== null).map(a => Number(a.perda_pct))
    return pcts.length ? pcts.reduce((t, p) => t + p, 0) / pcts.length : null
  }

  const ranking = useMemo(() => {
    if (!ultimaAuditoria) return []
    const antes = new Map(
      doTipo.filter(a => a.data === penultima)
        .map(a => [a.insumo_codigo, a.perda_pct === null ? null : Number(a.perda_pct)]))
    return doTipo
      .filter(a => a.data === ultimaAuditoria && a.perda_pct !== null)
      .map(a => ({
        codigo: a.insumo_codigo,
        nome: a.insumo_nome,
        cor: a.categoria_cor,
        pct: Number(a.perda_pct),
        perda: Number(a.perda),
        unidade: a.unidade_medida,
        antes: antes.get(a.insumo_codigo) ?? null,
      }))
      .sort((a, b) => b.pct - a.pct)
  }, [doTipo, ultimaAuditoria, penultima])

  const filtered = perdas.filter(p => !filtroMotivo || p.motivo === filtroMotivo)

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const ABAS: { id: Aba; label: string }[] = [
    { id: 'produto', label: 'Produto (pós-produção)' },
    { id: 'insumo', label: 'Insumo (auditoria)' },
    { id: 'registros', label: 'Descartes de insumo' },
  ]

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Perdas</h1>
          <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
            O que se perde, onde, e o que mudou desde a semana passada
          </p>
        </div>
        <Button onClick={() => navigate('/perdas/nova')}>+ Registrar Perda</Button>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-white/[.08]">
        {ABAS.map(t => (
          <button
            key={t.id}
            onClick={() => setAba(t.id)}
            className={[
              'px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors -mb-px',
              aba === t.id
                ? 'border-brand-600 text-brand-700 dark:text-brand-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ══ Produto ══════════════════════════════════════════ */}
      {aba === 'produto' && (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Perda da semana</p>
                <p className={`text-xl font-bold ${
                  ultima?.pct == null ? 'text-gray-300' : corPct(ultima.pct)
                }`}>
                  {ultima?.pct == null ? '—' : `${ultima.pct.toFixed(2)}%`}
                </p>
                <p className="text-[11px] text-gray-400">
                  {ultima ? `${fmt(ultima.descartadas)} de ${fmt(ultima.noForno)} un` : 'sem produção'}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Média 4 semanas</p>
                <p className="text-xl font-bold text-gray-900 dark:text-unno-text">
                  {mediaAnterior === null ? '—' : `${mediaAnterior.toFixed(2)}%`}
                </p>
                <p className="text-[11px] text-gray-400">
                  {mediaAnterior !== null && ultima?.pct != null
                    ? `${ultima.pct >= mediaAnterior ? '+' : ''}${(ultima.pct - mediaAnterior).toFixed(2)} p.p.`
                    : 'sem base de comparação'}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Descartadas</p>
                <p className="text-xl font-bold text-gray-900 dark:text-unno-text">
                  {fmt(comDados.reduce((t, s) => t + s.descartadas, 0))}
                </p>
                <p className="text-[11px] text-gray-400">nas 12 semanas</p>
              </div>
              <CampoMeta
                rotulo="Meta de descarte"
                valor={metaProduto}
                onGravar={v => gravarMeta('meta_perda_produto_pct', v)}
              />
            </div>
          </Card>

          {oQueMudou && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <strong>{oQueMudou.motivo}</strong> passou de{' '}
              {oQueMudou.antes.toFixed(0)}% para <strong>{oQueMudou.agora.toFixed(0)}%</strong> dos
              descartes nesta semana — alta de {oQueMudou.alta.toFixed(0)} pontos. Vale olhar o que
              mudou no processo.
            </div>
          )}

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-unno-text">
              Perda por semana
            </h2>
            <p className="text-xs text-gray-500 dark:text-unno-muted mb-2">
              Unidades descartadas sobre as que saíram do forno. Semana sem produção fica vazia.
            </p>
            <BarrasSemana
              semanas={semanas.map(s => ({ chave: s.chave, pct: s.pct, descartadas: s.descartadas }))}
              meta={metaProduto}
            />
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-unno-text">
              Composição do descarte
            </h2>
            <p className="text-xs text-gray-500 dark:text-unno-muted mb-2">
              A participação de cada motivo, semana a semana. Uma faixa que engorda é sinal de
              processo, não de azar.
            </p>
            <BarrasEmpilhadas
              semanas={semanas.map(s => ({ chave: s.chave, total: s.descartadas, fatias: s.fatias }))}
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 border-t border-gray-100 dark:border-white/[.06]">
              {[...new Map(motivos.map(m => [m.motivo_id, m])).values()]
                .sort((a, b) => a.motivo_ordem - b.motivo_ordem)
                .map(m => (
                  <span key={m.motivo_id} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-unno-muted">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: corDoMotivo(m.motivo_ordem) }} />
                    {m.motivo}
                  </span>
                ))}
            </div>
          </Card>

          {ultima && ultima.descartadas > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-unno-text mb-3">
                Motivos da última semana com produção
              </h2>
              <div className="space-y-2">
                {ultima.fatias.slice().sort((a, b) => b.qtd - a.qtd).map(f => (
                  <div key={f.id} className="flex items-center gap-3">
                    <span className="text-sm text-gray-700 dark:text-unno-muted w-44 shrink-0 truncate">
                      {f.motivo}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(f.qtd / ultima.descartadas) * 100}%`,
                          backgroundColor: corDoMotivo(f.ordem),
                        }}
                      />
                    </div>
                    <span className="text-sm tabular-nums text-gray-700 dark:text-unno-text w-28 text-right">
                      {fmt(f.qtd)} un · {((f.qtd / ultima.descartadas) * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {comDados.length === 0 && (
            <Card>
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                Nenhuma pós-produção registrada nas últimas 12 semanas. Os números aparecem quando
                a primeira for lançada.
              </p>
            </Card>
          )}
        </div>
      )}

      {/* ══ Insumo ═══════════════════════════════════════════ */}
      {aba === 'insumo' && (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-unno-muted">
              Medida na contagem, não por semana: a série anda quando uma auditoria é aplicada.
            </p>
            {/* EP e EC medem coisas diferentes e não se somam: um é a perda de
                produção, o outro a do armazém. */}
            <select
              value={tipoAuditoria}
              onChange={e => setTipoAuditoria(e.target.value as 'ep' | 'ec')}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm dark:border-white/[.08] dark:bg-unno-raised"
            >
              <option value="ep">{TIPO_LABEL.ep}</option>
              <option value="ec">{TIPO_LABEL.ec}</option>
            </select>
          </div>

          {datasAuditoria.length === 0 ? (
            <Card>
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                Nenhuma auditoria aplicada ainda. Faça uma contagem em{' '}
                <button onClick={() => navigate('/contagem')} className="text-brand-600 underline">
                  Contagem
                </button>{' '}
                e aplique o resultado — é dela que sai este número, e a série começa aí.
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-5">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">
                      Última auditoria
                    </p>
                    <p className={`text-xl font-bold ${
                      mediaDe(ultimaAuditoria) === null ? 'text-gray-300' : corPct(mediaDe(ultimaAuditoria)!)
                    }`}>
                      {mediaDe(ultimaAuditoria) === null ? '—' : `${mediaDe(ultimaAuditoria)!.toFixed(2)}%`}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {formatDate(ultimaAuditoria)} · média dos insumos
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-400">
                      Auditoria anterior
                    </p>
                    <p className="text-xl font-bold text-gray-900 dark:text-unno-text">
                      {mediaDe(penultima) === null ? '—' : `${mediaDe(penultima)!.toFixed(2)}%`}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {penultima ? formatDate(penultima) : 'sem base de comparação'}
                    </p>
                  </div>
                  <CampoMeta
                    rotulo="Meta de insumo"
                    valor={metaInsumo}
                    onGravar={v => gravarMeta('meta_perda_insumo_pct', v)}
                  />
                </div>
                <p className="text-[11px] text-gray-400 mt-3 pt-3 border-t border-gray-100 dark:border-white/[.06]">
                  Média dos percentuais, não soma: os insumos estão em quilo, litro e unidade, e
                  somá-los daria um número sem significado. O que aponta é o ranking abaixo.
                </p>
              </Card>

              <Card className="p-5">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-unno-text">
                  Onde está a perda
                </h2>
                <p className="text-xs text-gray-500 dark:text-unno-muted mb-3">
                  Insumos da última auditoria, do que mais perde para o que menos perde
                </p>
                <div className="space-y-2">
                  {ranking.map(r => {
                    const largura = Math.min(Math.abs(r.pct), 100)
                    const variacao = r.antes === null ? null : r.pct - r.antes
                    return (
                      <div key={r.codigo} className="flex items-center gap-3">
                        <span className="text-sm text-gray-700 dark:text-unno-muted w-44 shrink-0 truncate">
                          <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                style={{ backgroundColor: r.cor ?? '#9ca3af' }} />
                          {r.nome}
                        </span>
                        <div className="flex-1 h-2 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              r.pct <= 3 ? 'bg-emerald-400' : r.pct <= 8 ? 'bg-yellow-400' : 'bg-red-400'
                            }`}
                            style={{ width: `${largura}%` }}
                          />
                        </div>
                        <span className={`text-sm tabular-nums w-16 text-right ${corPct(r.pct)}`}>
                          {r.pct.toFixed(1)}%
                        </span>
                        <span className="text-xs tabular-nums w-20 text-right text-gray-400">
                          {variacao === null ? '—'
                            : `${variacao >= 0 ? '+' : ''}${variacao.toFixed(1)} p.p.`}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </Card>

              <Card className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-white/[.06] text-left">
                      <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                      {datasAuditoria.slice(0, 6).map(d => (
                        <th key={d} className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase text-right whitespace-nowrap">
                          {formatDate(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                    {[...new Set(doTipo.map(a => a.insumo_codigo))].map(codigo => {
                      const linhas = doTipo.filter(a => a.insumo_codigo === codigo)
                      return (
                        <tr key={codigo}>
                          <td className="px-4 py-2.5">
                            <span className="text-gray-900 dark:text-unno-text">{linhas[0].insumo_nome}</span>
                            <span className="text-xs text-gray-400 ml-1.5">{codigo}</span>
                          </td>
                          {datasAuditoria.slice(0, 6).map(d => {
                            const l = linhas.find(x => x.data === d)
                            const pct = l?.perda_pct === null || l === undefined ? null : Number(l.perda_pct)
                            return (
                              <td key={d} className="px-3 py-2.5 text-right tabular-nums">
                                {pct === null ? <span className="text-gray-300">—</span> : (
                                  <span className={corPct(pct)}>
                                    {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                                  </span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ══ Descartes de insumo ══════════════════════════════ */}
      {aba === 'registros' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-500 dark:text-unno-muted">
              Vencimento, contaminação, queda — com lote identificado
            </p>
            <select
              value={filtroMotivo}
              onChange={e => setFiltroMotivo(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm dark:border-white/[.08] dark:bg-unno-raised"
            >
              <option value="">Todos os motivos</option>
              {Object.entries(MOTIVO_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <Card className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-white/[.06] text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Data</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Código</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Lote</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase text-right">Qtd</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Motivo</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Local</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                {filtered.map(p => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-gray-600 dark:text-unno-muted">{formatDate(p.data)}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">{p.codigo}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-unno-text">{p.insumo?.nome}</p>
                      <p className="text-xs text-gray-400">{p.insumo?.codigo}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-unno-muted font-mono text-xs">
                      {p.lote?.codigo}
                    </td>
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
                      Nenhum descarte registrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  )
}

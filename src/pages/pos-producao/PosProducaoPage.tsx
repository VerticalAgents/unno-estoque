import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { CampoNumerico } from '../../components/ui/CampoNumerico'
import { formatDate } from '../../lib/utils'

/**
 * Pós-produção — o que acontece depois do forno.
 *
 * No dia da produção o brownie é cortado ainda quente, mas segue dentro da
 * forma. É ao desenformar que aparece unidade quebrada, crua, torta.
 *
 * A tela registra SÓ AS RUINS, com o motivo de cada uma. As boas saem por
 * diferença: `formas × rendimento − descartadas`. Ninguém conta unidade boa
 * uma a uma, e pedir esse número seria pedir uma estimativa disfarçada de
 * medição.
 *
 * É AQUI QUE O PRODUTO ENTRA NO ESTOQUE — na forma ele não existe para a
 * expedição — e a validade conta do dia em que saiu da forma.
 *
 * A unidade de registro é o DIA DE DESENFORMA, não a sessão. Desenformar
 * metade hoje e metade amanhã são dois eventos com quebras próprias: juntar
 * tudo num monte só apagaria o rendimento real de cada dia. Cada dia diz
 * quantas FORMAS foram abertas, com que validade, e o que quebrou; e vira um
 * lote. A sessão fica na fila até a última forma ser aberta.
 *
 * Este registro é sempre o retrato COMPLETO do que se sabe até agora: a tela
 * carrega os dias já gravados antes de mandar tudo de volta. O que não voltar
 * daqui seria apagado.
 */

interface Pendente {
  sessao_id: string
  codigo: string
  data_producao: string
  dias_parado: number
  formas: number
  unidades_teoricas: number
  unidades_registradas: number
  falta: number
  formas_desenformadas: number
}

interface Motivo {
  id: string
  nome: string
  ordem: number
}

interface SkuSessao {
  id: string
  ficha_codigo: string
  ficha_nome: string
  formas: number
  rendimento: number
  /** null quando a ficha não tem produto cadastrado — não vira estoque */
  produto_nome: string | null
  validade_dias: number | null
}

/** Um dia de desenforma: formas abertas, validade e o que quebrou nele. */
interface Desenforma {
  data: string
  validade: string
  formas: string
  /** motivo_id → quantidade digitada */
  descartes: Record<string, string>
  /** já estava gravada quando a tela abriu */
  gravada: boolean
}

function fmt(n: number) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

function hojeISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function somarDias(iso: string, dias: number) {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00:00`)
  if (isNaN(d.getTime())) return ''
  d.setDate(d.getDate() + dias)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const campoData =
  'block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm ' +
  'focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10 ' +
  'dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text'

export function PosProducaoPage() {
  const { profile } = useAuth()

  const [pendentes, setPendentes] = useState<Pendente[]>([])
  const [motivos, setMotivos] = useState<Motivo[]>([])
  const [sessaoId, setSessaoId] = useState<string | null>(null)
  const [skus, setSkus] = useState<SkuSessao[]>([])
  /** sku_id → os dias em que se desenformou */
  const [dias, setDias] = useState<Record<string, Desenforma[]>>({})
  /** sku_id → já mexeram nas formas? Até mexer, um dia sozinho leva tudo. */
  const [tocou, setTocou] = useState<Record<string, boolean>>({})
  const [observacoes, setObservacoes] = useState('')
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [sucesso, setSucesso] = useState('')

  const num = (s: string | undefined) => parseInt((s ?? '').replace(/\D/g, '')) || 0

  const carregar = useCallback(async () => {
    if (!profile) return
    const [pend, mot] = await Promise.all([
      supabase.from('v_pos_producao_pendente').select('*')
        .eq('empresa_id', profile.empresa_id)
        .order('data_producao'),          // a mais antiga é a mais urgente
      supabase.from('motivos_descarte').select('id, nome, ordem')
        .eq('empresa_id', profile.empresa_id).eq('ativo', true).order('ordem'),
    ])
    setPendentes((pend.data ?? []) as unknown as Pendente[])
    setMotivos((mot.data ?? []) as unknown as Motivo[])
    setLoading(false)
  }, [profile])

  useEffect(() => { carregar() }, [carregar])

  function novoDia(sku: SkuSessao, data: string, formas: string): Desenforma {
    return {
      data,
      validade: somarDias(data, sku.validade_dias ?? 365),
      formas,
      descartes: {},
      gravada: false,
    }
  }

  /** Abre uma sessão para registro: as fichas, os produtos e o que já foi feito. */
  async function abrir(id: string) {
    if (!profile) return
    setErro(''); setSucesso(''); setDias({}); setTocou({}); setObservacoes('')
    setSessaoId(id)

    const { data } = await supabase
      .from('sessoes_producao_skus')
      .select('id, ficha_tecnica_id, formas_assadas, multiplicador, ficha:fichas_tecnicas(codigo, nome), versao:fichas_tecnicas_versoes(rendimento_fornada)')
      .eq('sessao_id', id)

    const linhas = (data ?? []) as unknown as {
      id: string; ficha_tecnica_id: string
      formas_assadas: number | null; multiplicador: number | null
      ficha: { codigo: string; nome: string } | null
      versao: { rendimento_fornada: number | null } | null
    }[]

    // É o produto que diz quantos dias de validade contar — e a ficha que não
    // tem produto cadastrado não vira estoque nenhum.
    const { data: prods } = await supabase
      .from('produtos')
      .select('id, nome, ficha_tecnica_id, validade_dias')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .in('ficha_tecnica_id', linhas.map(r => r.ficha_tecnica_id))

    const porFicha = new Map(((prods ?? []) as unknown as {
      id: string; nome: string; ficha_tecnica_id: string; validade_dias: number | null
    }[]).map(p => [p.ficha_tecnica_id, p]))

    const lista: SkuSessao[] = linhas.map(r => {
      const p = porFicha.get(r.ficha_tecnica_id)
      return {
        id: r.id,
        ficha_codigo: r.ficha?.codigo ?? '—',
        ficha_nome: r.ficha?.nome ?? '—',
        // formas_assadas é o que foi ao forno; sem ela, o planejado é o que há
        formas: Number(r.formas_assadas ?? r.multiplicador ?? 0),
        rendimento: Number(r.versao?.rendimento_fornada ?? 0),
        produto_nome: p?.nome ?? null,
        validade_dias: p?.validade_dias ?? null,
      }
    })
    setSkus(lista)

    // Os dias já registrados. Sem eles, salvar de novo apagaria o primeiro
    // registro — a função recebe o retrato inteiro, não um incremento.
    const { data: pos } = await supabase
      .from('pos_producao')
      .select('observacoes, partes:pos_producao_partes(sessao_sku_id, data_desenforma, validade, formas, descartes:pos_producao_descartes(motivo_id, quantidade))')
      .eq('sessao_id', id).maybeSingle()

    const anterior = pos as unknown as {
      observacoes: string | null
      partes: {
        sessao_sku_id: string; data_desenforma: string; validade: string; formas: number
        descartes: { motivo_id: string; quantidade: number }[]
      }[]
    } | null

    const gravados: Record<string, Desenforma[]> = {}
    if (anterior) {
      setObservacoes(anterior.observacoes ?? '')
      for (const pt of anterior.partes ?? []) {
        (gravados[pt.sessao_sku_id] ??= []).push({
          data: pt.data_desenforma,
          validade: pt.validade,
          formas: String(pt.formas),
          descartes: Object.fromEntries(
            (pt.descartes ?? []).map(d => [d.motivo_id, String(d.quantidade)])),
          gravada: true,
        })
      }
      for (const v of Object.values(gravados)) v.sort((a, b) => a.data.localeCompare(b.data))
    }

    // Sem nada gravado: um dia com a data de hoje e TODAS as formas, para quem
    // desenformou de uma vez só conferir e salvar.
    setDias(Object.fromEntries(lista.map(s => [
      s.id,
      gravados[s.id] ?? [novoDia(s, hojeISO(), String(s.formas))],
    ])))
    setTocou(Object.fromEntries(lista.map(s => [s.id, Boolean(gravados[s.id])])))
  }

  function mexer(skuId: string, f: (ds: Desenforma[]) => Desenforma[]) {
    setDias(d => ({ ...d, [skuId]: f(d[skuId] ?? []) }))
  }

  /** Mudar a data recalcula a validade; mudar a validade só muda a validade. */
  function editarDia(sku: SkuSessao, i: number, campo: 'data' | 'validade' | 'formas', valor: string) {
    if (campo === 'formas') setTocou(t => ({ ...t, [sku.id]: true }))
    mexer(sku.id, ds => ds.map((d, j) => {
      if (j !== i) return d
      if (campo === 'data') {
        return { ...d, data: valor, validade: somarDias(valor, sku.validade_dias ?? 365) }
      }
      return { ...d, [campo]: valor }
    }))
  }

  function editarDescarte(skuId: string, i: number, motivoId: string, valor: string) {
    mexer(skuId, ds => ds.map((d, j) =>
      j === i ? { ...d, descartes: { ...d.descartes, [motivoId]: valor } } : d))
  }

  const resumo = useMemo(() => skus.map(s => {
    const crus = dias[s.id] ?? []
    // Enquanto ninguém mexeu e só existe um dia, ele leva todas as formas: é o
    // caso comum de desenformar tudo de uma vez, sem digitar nada.
    const auto = !tocou[s.id] && crus.length === 1
    const linhas = (auto ? [{ ...crus[0], formas: String(s.formas) }] : crus).map(d => {
      const formas = num(d.formas)
      const noForno = formas * s.rendimento
      const descartadas = motivos.reduce((t, m) => t + num(d.descartes[m.id]), 0)
      return {
        dia: d, formas, noForno, descartadas,
        boas: Math.max(noForno - descartadas, 0),
        rendimentoReal: formas > 0 ? Math.max(noForno - descartadas, 0) / formas : 0,
        excede: descartadas > noForno,
        semData: !d.data || !d.validade,
      }
    })
    const formasFeitas = linhas.reduce((t, l) => t + l.formas, 0)
    return {
      sku: s, linhas, auto, formasFeitas,
      faltaFormas: s.formas - formasFeitas,
      boas: linhas.reduce((t, l) => t + l.boas, 0),
      descartadas: linhas.reduce((t, l) => t + l.descartadas, 0),
      excedeuFormas: formasFeitas > s.formas,
      invalida: linhas.some(l => l.excede || l.semData || l.formas <= 0),
    }
  }), [skus, motivos, dias, tocou])

  const totalBoas = resumo.reduce((t, r) => t + r.boas, 0)
  const totalDescartado = resumo.reduce((t, r) => t + r.descartadas, 0)
  const faltamFormas = resumo.reduce((t, r) => t + Math.max(r.faltaFormas, 0), 0)
  const naoPodeSalvar = resumo.some(r => r.excedeuFormas || r.invalida)
    || resumo.every(r => r.formasFeitas === 0)

  async function salvar() {
    if (!profile || !sessaoId) return
    setSalvando(true); setErro('')

    // Vai o retrato completo: os dias já gravados mais os de agora.
    const partes = resumo.flatMap(r => r.linhas.map(l => ({
      sessao_sku_id: r.sku.id,
      data_desenforma: l.dia.data,
      validade: l.dia.validade,
      formas: l.formas,
      descartes: motivos
        .map(m => ({ motivo_id: m.id, quantidade: num(l.dia.descartes[m.id]) }))
        .filter(d => d.quantidade > 0),
    })))

    const { data, error } = await supabase.rpc('registrar_pos_producao', {
      p_empresa_id: profile.empresa_id,
      p_sessao_id: sessaoId,
      p_responsavel_id: profile.id,
      p_partes: partes,
      p_observacoes: observacoes || null,
    })

    setSalvando(false)
    const resp = data as {
      ok?: boolean; erro?: string; boas?: number; lotes?: number
      falta_formas?: number; avisos?: string[]
    } | null
    if (error || !resp?.ok) {
      setErro(error?.message ?? resp?.erro ?? 'Não foi possível registrar.')
      return
    }
    const lotes = resp.lotes ?? 0
    const falta = resp.falta_formas ?? 0
    setSucesso(
      `${resp.boas ?? totalBoas} unidades no estoque em `
      + (lotes === 1 ? '1 lote' : `${lotes} lotes`)
      + `, ${totalDescartado} descartadas. `
      + (falta > 0
        ? `Faltam ${falta} formas para desenformar — a sessão continua na fila.`
        : 'Sessão desenformada por inteiro.')
      + (resp.avisos?.length ? ` ${resp.avisos.join(' ')}` : ''))
    voltar()
    await carregar()
  }

  function voltar() {
    setSessaoId(null); setSkus([]); setDias({}); setTocou({})
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const sessaoAtual = pendentes.find(p => p.sessao_id === sessaoId)

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Pós-produção</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          Desenforme e embalagem: registre as formas abertas e o que foi descartado em cada dia.
        </p>
      </div>

      {sucesso && (
        <div className="p-3 rounded-lg bg-brand-500/10 border border-brand-500/25 text-sm text-brand-700">
          {sucesso}
        </div>
      )}

      {/* ── Fila ────────────────────────────────────────────── */}
      {!sessaoId && (
        <Card>
          <CardHeader
            title="Sessões esperando"
            subtitle="Produções já fechadas com formas ainda por desenformar"
          />
          <CardBody className={pendentes.length === 0 ? '' : 'p-0'}>
            {pendentes.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-unno-muted text-center py-6">
                Nenhuma sessão esperando. Tudo em dia.
              </p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-white/[.04]">
                {pendentes.map(p => (
                  <div key={p.sessao_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                        <span className="font-mono">{p.codigo}</span>
                        {' · '}{formatDate(p.data_producao)}
                        {p.dias_parado >= 2 && (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            há {p.dias_parado} dias
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-unno-muted">
                        {p.formas} formas · {p.unidades_teoricas} unidades no forno
                        {p.formas_desenformadas > 0 && (
                          <> · <strong className="text-gray-700 dark:text-unno-text">
                            {p.formas_desenformadas} formas já desenformadas
                          </strong>, faltam {p.formas - p.formas_desenformadas}</>
                        )}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => abrir(p.sessao_id)}>
                      {p.formas_desenformadas > 0 ? 'Continuar' : 'Registrar'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── Registro ────────────────────────────────────────── */}
      {sessaoId && (
        <Card>
          <CardHeader
            title={`Desenforma — ${sessaoAtual?.codigo ?? ''}`}
            subtitle="Um bloco por dia: as formas abertas e o que quebrou naquele dia"
            action={<Button variant="ghost" size="sm" onClick={voltar}>Voltar</Button>}
          />
          <CardBody className="space-y-6">
            {/* Sem motivo cadastrado não há o que preencher, e a tela ficaria
                só com os títulos dos produtos — parecendo defeito. */}
            {motivos.length === 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                Nenhum motivo de descarte cadastrado. Cadastre os motivos em{' '}
                <strong>Configurações → Motivos de descarte</strong> e volte aqui —
                são eles que viram os campos de cada dia.
              </div>
            )}

            {resumo.map(r => (
              <div key={r.sku.id} className="space-y-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                    <span className="text-gray-400 mr-1.5">{r.sku.ficha_codigo}</span>
                    {r.sku.ficha_nome}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-unno-muted tabular-nums">
                    {r.sku.formas} formas × {r.sku.rendimento} = {r.sku.formas * r.sku.rendimento} unidades
                  </p>
                </div>

                {r.sku.produto_nome === null && (
                  <div className="rounded-lg px-3 py-2 text-xs bg-amber-50 border border-amber-200 text-amber-800">
                    <strong>{r.sku.ficha_nome}</strong> não tem produto cadastrado:
                    o que for desenformado não vai entrar no estoque. Cadastre em{' '}
                    <strong>Produtos</strong> e registre depois.
                  </div>
                )}

                {r.linhas.map((l, i) => (
                  <div key={i} className="rounded-lg border border-gray-200 dark:border-white/[.06] p-3 space-y-3">
                    <div className="flex items-end gap-2 flex-wrap">
                      <label className="flex-1 min-w-[8.5rem]">
                        <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                          Desenformado em
                        </span>
                        <input type="date" className={campoData} value={l.dia.data}
                          onChange={e => editarDia(r.sku, i, 'data', e.target.value)} />
                      </label>

                      <div>
                        <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                          Formas abertas
                        </span>
                        <CampoNumerico
                          valor={l.dia.formas}
                          onDigitar={v => editarDia(r.sku, i, 'formas', v)}
                          onPasso={d => editarDia(r.sku, i, 'formas',
                            String(Math.max(0, l.formas + d)))}
                          largura="w-20"
                        />
                      </div>

                      <label className="flex-1 min-w-[8.5rem]">
                        <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                          Vence em
                          {r.sku.validade_dias ? ` (${r.sku.validade_dias} dias)` : ''}
                        </span>
                        <input type="date" className={campoData} value={l.dia.validade}
                          onChange={e => editarDia(r.sku, i, 'validade', e.target.value)} />
                      </label>

                      {l.dia.gravada ? (
                        <span className="text-[11px] text-gray-400 pb-2">já registrado</span>
                      ) : r.linhas.length > 1 && (
                        <Button variant="ghost" size="sm"
                          onClick={() => { setTocou(t => ({ ...t, [r.sku.id]: true }))
                            mexer(r.sku.id, ds => ds.filter((_, j) => j !== i)) }}>
                          Remover
                        </Button>
                      )}
                    </div>

                    {motivos.length > 0 && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {motivos.map(m => (
                          <div key={m.id} className="flex items-center gap-2">
                            <span className="flex-1 min-w-0 text-sm text-gray-600 dark:text-unno-muted truncate">
                              {m.nome}
                            </span>
                            <CampoNumerico
                              valor={l.dia.descartes[m.id] ?? ''}
                              onDigitar={v => editarDescarte(r.sku.id, i, m.id, v)}
                              onPasso={d => editarDescarte(r.sku.id, i, m.id,
                                String(Math.max(0, num(l.dia.descartes[m.id]) + d)))}
                              largura="w-20"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* As boas do dia, por diferença, ao vivo */}
                    <div className={`rounded-lg px-3 py-2 text-xs ${
                      l.excede
                        ? 'bg-red-50 border border-red-200 text-red-700'
                        : 'bg-gray-50 dark:bg-white/[.03] text-gray-600 dark:text-unno-muted'
                    }`}>
                      {l.excede ? (
                        <>Os descartes ({l.descartadas}) passam das {l.noForno} unidades
                          que saíram destas {l.formas} formas.</>
                      ) : (
                        <>
                          {l.formas} formas = {l.noForno} unidades ·{' '}
                          {l.descartadas} descartadas ·{' '}
                          boas <strong className="text-gray-900 dark:text-unno-text">{l.boas}</strong>
                          {' · '}rendimento real <strong>{fmt(l.rendimentoReal)}</strong> un/forma
                          {r.sku.rendimento > 0 && ` (teórico ${r.sku.rendimento})`}
                        </>
                      )}
                    </div>
                  </div>
                ))}

                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <Button variant="ghost" size="sm"
                    onClick={() => { setTocou(t => ({ ...t, [r.sku.id]: true }))
                      mexer(r.sku.id, ds => [
                        // O dia automático vira número antes de ganhar companhia,
                        // senão o valor dele sumiria.
                        ...(r.auto ? r.linhas.map(x => x.dia) : ds),
                        novoDia(r.sku, hojeISO(), ''),
                      ]) }}>
                    + Outro dia de desenforma
                  </Button>

                  <p className={`text-xs ${
                    r.excedeuFormas ? 'text-red-700'
                      : r.faltaFormas > 0 ? 'text-amber-700'
                      : 'text-gray-500 dark:text-unno-muted'
                  }`}>
                    {r.excedeuFormas
                      ? `${r.formasFeitas} formas desenformadas contra ${r.sku.formas} que foram ao forno.`
                      : r.faltaFormas > 0
                        ? `Faltam ${r.faltaFormas} formas na prateleira.`
                        : 'Todas as formas desenformadas.'}
                  </p>
                </div>
              </div>
            ))}

            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                Observações (opcional)
              </label>
              <textarea
                rows={2}
                value={observacoes}
                onChange={e => setObservacoes(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
            </div>

            {erro && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {erro}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-gray-100 dark:border-white/[.06]">
              <p className="text-sm text-gray-600 dark:text-unno-muted">
                Total: <strong className="text-gray-900 dark:text-unno-text">{totalBoas}</strong> boas
                {' · '}{totalDescartado} descartadas
                {faltamFormas > 0 && (
                  <span className="text-amber-700"> · {faltamFormas} formas ainda fechadas</span>
                )}
              </p>
              <Button loading={salvando} disabled={naoPodeSalvar} onClick={salvar}>
                {faltamFormas > 0 ? 'Registrar o que já saiu' : 'Registrar pós-produção'}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

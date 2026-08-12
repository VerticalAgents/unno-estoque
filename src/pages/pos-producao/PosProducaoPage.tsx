import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { CampoNumerico } from '../../components/ui/CampoNumerico'
import { formatDate } from '../../lib/utils'

/**
 * Pós-produção — o que acontece no dia seguinte.
 *
 * No dia da produção o brownie é cortado ainda quente, mas segue dentro da
 * forma. É aqui, ao desenformar, que aparece unidade quebrada, crua, torta.
 *
 * Por isso esta tela registra SÓ AS RUINS, com o motivo de cada uma. As boas
 * saem por diferença: `formas assadas × rendimento − descartadas`. Ninguém
 * conta unidade boa uma a uma, e pedir esse número seria pedir uma estimativa
 * disfarçada de medição.
 *
 * É AQUI QUE O PRODUTO ENTRA NO ESTOQUE. Enquanto está na forma ele não
 * existe para a expedição. A quantidade boa se divide por VALIDADE, porque a
 * desenforma nem sempre acaba no mesmo dia: cada data vira um lote, com os
 * dias de validade contados dela.
 *
 * E o registro PODE SER PARCIAL: o que saiu da forma hoje entra no estoque
 * hoje, e a sessão continua na fila até a última unidade sair. Continua um
 * registro por sessão, mas ele é sempre o retrato completo do que se sabe até
 * agora — por isso esta tela CARREGA o que já foi gravado antes de mandar de
 * volta. O que não voltar daqui seria apagado.
 */

interface Pendente {
  sessao_id: string
  codigo: string
  data_producao: string
  dias_parado: number
  formas: number
  unidades_teoricas: number
  /** o que já virou lote em registros anteriores */
  unidades_registradas: number
  falta: number
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

/** Uma fatia da quantidade boa: o que saiu da forma num dia. */
interface Parte {
  desenforma: string
  validade: string
  quantidade: string
  /** preenchido quando esta linha já é um lote gravado antes */
  lote: string | null
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

export function PosProducaoPage() {
  const { profile } = useAuth()

  const [pendentes, setPendentes] = useState<Pendente[]>([])
  const [motivos, setMotivos] = useState<Motivo[]>([])
  const [sessaoId, setSessaoId] = useState<string | null>(null)
  const [skus, setSkus] = useState<SkuSessao[]>([])
  /** chave `${sku_id}|${motivo_id}` → quantidade digitada */
  const [descartes, setDescartes] = useState<Record<string, string>>({})
  /** sku_id → as validades em que a quantidade boa foi dividida */
  const [partes, setPartes] = useState<Record<string, Parte[]>>({})
  /** sku_id → o usuário já mexeu nas quantidades? Até mexer, a linha única
   *  acompanha as boas sozinha; depois dela mexida, ninguém mexe por ele. */
  const [tocou, setTocou] = useState<Record<string, boolean>>({})
  const [observacoes, setObservacoes] = useState('')
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [sucesso, setSucesso] = useState('')

  const chave = (skuId: string, motivoId: string) => `${skuId}|${motivoId}`
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

  /** Abre uma sessão para registro: busca as fichas dela e os produtos delas. */
  async function abrir(id: string) {
    if (!profile) return
    setErro(''); setSucesso(''); setDescartes({}); setPartes({}); setObservacoes('')
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

    const produtos = (prods ?? []) as {
      id: string; nome: string; ficha_tecnica_id: string; validade_dias: number | null
    }[]
    const porFicha = new Map(produtos.map(p => [p.ficha_tecnica_id, p]))

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

    // O que já foi registrado antes. A pós pode ter sido feita em pedaços, e
    // este registro é sempre o retrato COMPLETO do que se sabe até agora — o
    // que não voltar daqui seria apagado ao salvar.
    const [{ data: pos }, { data: lotes }] = await Promise.all([
      supabase.from('pos_producao')
        .select('id, observacoes, descartes:pos_producao_descartes(sessao_sku_id, motivo_id, quantidade)')
        .eq('sessao_id', id).maybeSingle(),
      supabase.from('lotes_produto')
        .select('codigo, produto_id, quantidade_produzida, validade, data_desenforma')
        .eq('sessao_id', id).order('validade'),
    ])

    const anterior = pos as unknown as {
      id: string; observacoes: string | null
      descartes: { sessao_sku_id: string; motivo_id: string; quantidade: number }[]
    } | null

    if (anterior) {
      setObservacoes(anterior.observacoes ?? '')
      setDescartes(Object.fromEntries(
        (anterior.descartes ?? []).map(d =>
          [chave(d.sessao_sku_id, d.motivo_id), String(d.quantidade)])))
    }

    // Cada lote vira uma linha de validade, pela ficha do produto dele.
    const skuPorFicha = new Map(linhas.map(l => [l.ficha_tecnica_id, l.id]))
    const skuDoProduto = new Map(
      produtos.map(p => [p.id, skuPorFicha.get(p.ficha_tecnica_id)]))

    const jaGravadas: Record<string, Parte[]> = {}
    for (const l of (lotes ?? []) as unknown as {
      codigo: string; produto_id: string; quantidade_produzida: number
      validade: string; data_desenforma: string | null
    }[]) {
      const skuId = skuDoProduto.get(l.produto_id)
      if (!skuId) continue
      ;(jaGravadas[skuId] ??= []).push({
        desenforma: l.data_desenforma ?? '',
        validade: l.validade,
        quantidade: String(l.quantidade_produzida),
        lote: l.codigo,
      })
    }

    // Sem nada gravado: uma linha com a data de hoje e tudo que saiu bom, para
    // quem desenformou de uma vez só confirmar e salvar.
    setPartes(Object.fromEntries(lista.map(s => [
      s.id,
      jaGravadas[s.id] ?? [novaParte(s, hojeISO())],
    ])))
    setTocou(Object.fromEntries(lista.map(s => [s.id, Boolean(jaGravadas[s.id])])))
  }

  function novaParte(sku: SkuSessao, data: string): Parte {
    return {
      desenforma: data,
      validade: somarDias(data, sku.validade_dias ?? 365),
      quantidade: '',
      lote: null,
    }
  }

  function mexerNasPartes(skuId: string, f: (linhas: Parte[]) => Parte[]) {
    setPartes(p => ({ ...p, [skuId]: f(p[skuId] ?? []) }))
  }

  /** Mudar a data recalcula a validade; mudar a validade só muda a validade. */
  function editarParte(sku: SkuSessao, i: number, campo: keyof Parte, valor: string) {
    if (campo === 'quantidade') setTocou(t => ({ ...t, [sku.id]: true }))
    mexerNasPartes(sku.id, linhas => linhas.map((p, j) => {
      if (j !== i) return p
      if (campo !== 'desenforma') return { ...p, [campo]: valor }
      return { ...p, desenforma: valor, validade: somarDias(valor, sku.validade_dias ?? 365) }
    }))
  }

  const resumo = useMemo(() => skus.map(s => {
    const teorico = s.formas * s.rendimento
    const descartadas = motivos.reduce((t, m) => t + num(descartes[chave(s.id, m.id)]), 0)
    const boas = Math.max(teorico - descartadas, 0)
    const cru = partes[s.id] ?? []
    // Enquanto ele não mexeu nas quantidades e só existe uma linha, ela é
    // "tudo o que saiu bom" e acompanha os descartes sozinha. É o caso comum:
    // desenformou de uma vez, não digita quantidade nenhuma.
    const auto = !tocou[s.id] && cru.length === 1
    const linhas = auto ? [{ ...cru[0], quantidade: String(boas) }] : cru
    const somadas = linhas.reduce((t, p) => t + num(p.quantidade), 0)
    const falta = boas - somadas
    return {
      sku: s, teorico, descartadas, boas, linhas, somadas, falta, auto,
      rendimentoReal: s.formas > 0 ? boas / s.formas : 0,
      excedeu: descartadas > teorico,
      // Não se desenforma o que não saiu do forno.
      excedeuPartes: falta < 0,
      semValidade: s.produto_nome !== null
        && linhas.some(p => num(p.quantidade) > 0 && !p.validade),
    }
  }), [skus, motivos, descartes, partes, tocou])

  const totalDescartado = resumo.reduce((t, r) => t + r.descartadas, 0)
  const totalTeorico = resumo.reduce((t, r) => t + r.teorico, 0)
  const totalBoas = resumo.reduce((t, r) => t + r.boas, 0)
  const totalRegistrando = resumo.reduce((t, r) => t + r.somadas, 0)
  const algumExcede = resumo.some(r => r.excedeu || r.excedeuPartes || r.semValidade)
  /** Registro parcial: sobra brownie na forma para amanhã. */
  const faltaDesenformar = resumo.reduce(
    (t, r) => t + (r.sku.produto_nome === null ? 0 : Math.max(r.falta, 0)), 0)

  async function salvar() {
    if (!profile || !sessaoId) return
    setSalvando(true); setErro('')

    const lista = skus.flatMap(s =>
      motivos
        .map(m => ({ sessao_sku_id: s.id, motivo_id: m.id, quantidade: num(descartes[chave(s.id, m.id)]) }))
        .filter(d => d.quantidade > 0))

    // Só as fichas que têm produto geram lote. Vai o retrato completo — o que
    // já estava gravado mais o que saiu agora.
    const partesEnviadas = resumo
      .filter(r => r.sku.produto_nome !== null)
      .flatMap(r => r.linhas
        .map(p => ({
          sessao_sku_id: r.sku.id,
          data_desenforma: p.desenforma || null,
          validade: p.validade || null,
          quantidade: num(p.quantidade),
        }))
        .filter(p => p.quantidade > 0))

    const { data, error } = await supabase.rpc('registrar_pos_producao', {
      p_empresa_id: profile.empresa_id,
      p_sessao_id: sessaoId,
      p_responsavel_id: profile.id,
      p_descartes: lista,
      p_observacoes: observacoes || null,
      p_partes: partesEnviadas,
    })

    setSalvando(false)
    const resp = data as {
      ok?: boolean; erro?: string; lotes?: number; falta?: number; avisos?: string[]
    } | null
    if (error || !resp?.ok) {
      setErro(error?.message ?? resp?.erro ?? 'Não foi possível registrar.')
      return
    }
    const lotes = resp.lotes ?? 0
    const falta = resp.falta ?? 0
    setSucesso(
      `${totalRegistrando} unidades no estoque em `
      + (lotes === 1 ? '1 lote' : `${lotes} lotes`)
      + `, ${totalDescartado} descartadas. `
      + (falta > 0
        ? `Faltam ${falta} para desenformar — a sessão continua na fila.`
        : 'Sessão desenformada por inteiro.')
      + (resp.avisos?.length ? ` ${resp.avisos.join(' ')}` : ''))
    setSessaoId(null)
    setSkus([])
    setPartes({})
    setTocou({})
    await carregar()
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
          Desenforme e embalagem: registre as unidades descartadas e o motivo de cada uma.
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
            subtitle="Produções já fechadas que ainda não foram desenformadas"
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
                        {p.unidades_registradas > 0 && (
                          <> · <strong className="text-gray-700 dark:text-unno-text">
                            {p.unidades_registradas} já no estoque
                          </strong>, faltam {p.falta}</>
                        )}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => abrir(p.sessao_id)}>
                      {p.unidades_registradas > 0 ? 'Continuar' : 'Registrar'}
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
        <>
          <Card>
            <CardHeader
              title={`Descartes — ${sessaoAtual?.codigo ?? ''}`}
              subtitle="Quantas unidades foram descartadas por cada motivo"
              action={
                <Button variant="ghost" size="sm"
                  onClick={() => { setSessaoId(null); setSkus([]); setPartes({}) }}>
                  Voltar
                </Button>
              }
            />
            <CardBody className="space-y-5">
              {/* Sem motivo cadastrado não há o que preencher, e a tela ficaria
                  só com os títulos dos produtos — parecendo defeito. */}
              {motivos.length === 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                  Nenhum motivo de descarte cadastrado. Cadastre os motivos em{' '}
                  <strong>Configurações → Motivos de descarte</strong> e volte aqui —
                  são eles que viram as colunas desta tela.
                </div>
              )}

              {resumo.map(r => (
                <div key={r.sku.id} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                      <span className="text-gray-400 mr-1.5">{r.sku.ficha_codigo}</span>
                      {r.sku.ficha_nome}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted tabular-nums">
                      {r.sku.formas} formas × {r.sku.rendimento} = {r.teorico} unidades
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    {motivos.map(m => (
                      <div key={m.id} className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 text-sm text-gray-600 dark:text-unno-muted truncate">
                          {m.nome}
                        </span>
                        <CampoNumerico
                          valor={descartes[chave(r.sku.id, m.id)] ?? ''}
                          onDigitar={v => setDescartes(s => ({ ...s, [chave(r.sku.id, m.id)]: v }))}
                          onPasso={d => setDescartes(s => {
                            const atual = num(s[chave(r.sku.id, m.id)])
                            const n = Math.max(0, atual + d)
                            return { ...s, [chave(r.sku.id, m.id)]: n > 0 ? String(n) : '' }
                          })}
                          largura="w-20"
                        />
                      </div>
                    ))}
                  </div>

                  {/* As boas por diferença, ao vivo */}
                  <div className={`rounded-lg px-3 py-2 text-xs ${
                    r.excedeu
                      ? 'bg-red-50 border border-red-200 text-red-700'
                      : 'bg-gray-50 dark:bg-white/[.03] text-gray-600 dark:text-unno-muted'
                  }`}>
                    {r.excedeu ? (
                      <>Os descartes ({r.descartadas}) passam do que saiu do forno ({r.teorico}).</>
                    ) : (
                      <>
                        Descartadas <strong>{r.descartadas}</strong> ·{' '}
                        boas <strong className="text-gray-900 dark:text-unno-text">{r.boas}</strong>
                        {' · '}rendimento real{' '}
                        <strong>{fmt(r.rendimentoReal)}</strong> un/forma
                        {r.sku.rendimento > 0 && ` (teórico ${r.sku.rendimento})`}
                      </>
                    )}
                  </div>

                  {/* ── Validades ──────────────────────────────
                      As boas entram no estoque aqui, e a validade conta do dia
                      em que saíram da forma. Quando a desenforma se espalha por
                      mais de um dia, cada dia vira um lote. */}
                  {r.sku.produto_nome === null ? (
                    <div className="rounded-lg px-3 py-2 text-xs bg-amber-50 border border-amber-200 text-amber-800">
                      <strong>{r.sku.ficha_nome}</strong> não tem produto cadastrado:
                      estas unidades não vão entrar no estoque. Cadastre em{' '}
                      <strong>Produtos</strong> e registre a pós-produção depois.
                    </div>
                  ) : r.boas > 0 && (
                    <div className="rounded-lg border border-gray-200 dark:border-white/[.06] p-3 space-y-2">
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
                          Validades
                        </p>
                        <p className="text-xs text-gray-500 dark:text-unno-muted">
                          {r.sku.validade_dias
                            ? `${r.sku.validade_dias} dias a partir da desenforma`
                            : 'produto sem prazo cadastrado — 1 ano'}
                        </p>
                      </div>

                      {r.linhas.map((p, i) => (
                        <div key={i} className="flex items-end gap-2 flex-wrap">
                          <label className="flex-1 min-w-[8.5rem]">
                            <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                              Desenformado em
                            </span>
                            <input
                              type="date"
                              value={p.desenforma}
                              onChange={e => editarParte(r.sku, i, 'desenforma', e.target.value)}
                              className="block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm
                                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                                         dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                            />
                          </label>

                          <label className="flex-1 min-w-[8.5rem]">
                            <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                              Vence em
                            </span>
                            <input
                              type="date"
                              value={p.validade}
                              onChange={e => editarParte(r.sku, i, 'validade', e.target.value)}
                              className="block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm
                                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                                         dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                            />
                          </label>

                          <div>
                            <span className="block text-[11px] text-gray-500 dark:text-unno-muted mb-0.5">
                              Unidades
                            </span>
                            <CampoNumerico
                              valor={p.quantidade}
                              onDigitar={v => editarParte(r.sku, i, 'quantidade', v)}
                              onPasso={d => editarParte(r.sku, i, 'quantidade',
                                String(Math.max(0, num(p.quantidade) + d)))}
                              largura="w-24"
                            />
                          </div>

                          {p.lote ? (
                            <span className="text-[11px] text-gray-400 font-mono pb-2">{p.lote}</span>
                          ) : r.linhas.length > 1 && (
                            <Button variant="ghost" size="sm"
                              onClick={() => { setTocou(t => ({ ...t, [r.sku.id]: true }))
                                mexerNasPartes(r.sku.id, l => l.filter((_, j) => j !== i)) }}>
                              Remover
                            </Button>
                          )}
                        </div>
                      ))}

                      {/* Quanto ainda está na forma. Registrar sem fechar a
                          conta é legítimo: desenformou metade hoje, o resto
                          amanhã, e o que saiu já vira estoque. */}
                      <div className={`rounded-lg px-3 py-2 text-xs ${
                        r.excedeuPartes
                          ? 'bg-red-50 border border-red-200 text-red-700'
                          : r.falta > 0
                            ? 'bg-amber-50 border border-amber-200 text-amber-800'
                            : 'bg-gray-50 dark:bg-white/[.03] text-gray-600 dark:text-unno-muted'
                      }`}>
                        {r.excedeuPartes ? (
                          <>As validades pedem {Math.abs(r.falta)} unidade(s) a mais
                            do que as {r.boas} que saíram boas.</>
                        ) : r.falta > 0 ? (
                          <>Vão para o estoque <strong>{r.somadas}</strong>;
                            {' '}<strong>{r.falta}</strong> ainda estão na forma.
                            Registre agora e volte quando desenformar o resto.</>
                        ) : (
                          <>Todas as <strong>{r.boas}</strong> unidades boas vão para o estoque
                            {r.linhas.length > 1 && ` em ${r.linhas.length} lotes`}.</>
                        )}
                      </div>

                      <Button variant="ghost" size="sm"
                        onClick={() => { setTocou(t => ({ ...t, [r.sku.id]: true }))
                          mexerNasPartes(r.sku.id, l => [
                            // A linha automática vira número antes de ganhar
                            // companhia, senão ela sumiria com o valor.
                            ...(r.auto ? r.linhas : l),
                            novaParte(r.sku, hojeISO()),
                          ]) }}>
                        + Outra validade
                      </Button>
                    </div>
                  )}
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
                  {' · '}{totalDescartado} descartadas de {totalTeorico}
                  {faltaDesenformar > 0 && (
                    <span className="text-amber-700"> · {faltaDesenformar} ainda na forma</span>
                  )}
                </p>
                <Button loading={salvando} disabled={algumExcede} onClick={salvar}>
                  {faltaDesenformar > 0 ? 'Registrar o que já saiu' : 'Registrar pós-produção'}
                </Button>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

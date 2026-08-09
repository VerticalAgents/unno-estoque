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
 * Um registro por sessão: a pós-produção sai de uma vez, nunca em pedaços.
 */

interface Pendente {
  sessao_id: string
  codigo: string
  data_producao: string
  dias_parado: number
  formas: number
  unidades_teoricas: number
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
}

function fmt(n: number) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

export function PosProducaoPage() {
  const { profile } = useAuth()

  const [pendentes, setPendentes] = useState<Pendente[]>([])
  const [motivos, setMotivos] = useState<Motivo[]>([])
  const [sessaoId, setSessaoId] = useState<string | null>(null)
  const [skus, setSkus] = useState<SkuSessao[]>([])
  /** chave `${sku_id}|${motivo_id}` → quantidade digitada */
  const [descartes, setDescartes] = useState<Record<string, string>>({})
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

  /** Abre uma sessão para registro: busca as fichas dela. */
  async function abrir(id: string) {
    setErro(''); setSucesso(''); setDescartes({}); setObservacoes('')
    setSessaoId(id)
    const { data } = await supabase
      .from('sessoes_producao_skus')
      .select('id, formas_assadas, multiplicador, ficha:fichas_tecnicas(codigo, nome), versao:fichas_tecnicas_versoes(rendimento_fornada)')
      .eq('sessao_id', id)

    setSkus(((data ?? []) as unknown as {
      id: string; formas_assadas: number | null; multiplicador: number | null
      ficha: { codigo: string; nome: string } | null
      versao: { rendimento_fornada: number | null } | null
    }[]).map(r => ({
      id: r.id,
      ficha_codigo: r.ficha?.codigo ?? '—',
      ficha_nome: r.ficha?.nome ?? '—',
      // formas_assadas é o que foi ao forno; sem ela, o planejado é o que há
      formas: Number(r.formas_assadas ?? r.multiplicador ?? 0),
      rendimento: Number(r.versao?.rendimento_fornada ?? 0),
    })))
  }

  const resumo = useMemo(() => skus.map(s => {
    const teorico = s.formas * s.rendimento
    const descartadas = motivos.reduce((t, m) => t + num(descartes[chave(s.id, m.id)]), 0)
    const boas = Math.max(teorico - descartadas, 0)
    return {
      sku: s, teorico, descartadas, boas,
      rendimentoReal: s.formas > 0 ? boas / s.formas : 0,
      excedeu: descartadas > teorico,
    }
  }), [skus, motivos, descartes])

  const totalDescartado = resumo.reduce((t, r) => t + r.descartadas, 0)
  const totalTeorico = resumo.reduce((t, r) => t + r.teorico, 0)
  const totalBoas = resumo.reduce((t, r) => t + r.boas, 0)
  const algumExcede = resumo.some(r => r.excedeu)

  async function salvar() {
    if (!profile || !sessaoId) return
    setSalvando(true); setErro('')

    const lista = skus.flatMap(s =>
      motivos
        .map(m => ({ sessao_sku_id: s.id, motivo_id: m.id, quantidade: num(descartes[chave(s.id, m.id)]) }))
        .filter(d => d.quantidade > 0))

    const { data, error } = await supabase.rpc('registrar_pos_producao', {
      p_empresa_id: profile.empresa_id,
      p_sessao_id: sessaoId,
      p_responsavel_id: profile.id,
      p_descartes: lista,
      p_observacoes: observacoes || null,
    })

    setSalvando(false)
    const resp = data as { ok?: boolean; erro?: string } | null
    if (error || !resp?.ok) {
      setErro(error?.message ?? resp?.erro ?? 'Não foi possível registrar.')
      return
    }
    setSucesso(`Pós-produção registrada: ${totalBoas} unidades boas, ${totalDescartado} descartadas.`)
    setSessaoId(null)
    setSkus([])
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
                      </p>
                    </div>
                    <Button size="sm" onClick={() => abrir(p.sessao_id)}>Registrar</Button>
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
                <Button variant="ghost" size="sm" onClick={() => { setSessaoId(null); setSkus([]) }}>
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
                </p>
                <Button loading={salvando} disabled={algumExcede} onClick={salvar}>
                  Registrar pós-produção
                </Button>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

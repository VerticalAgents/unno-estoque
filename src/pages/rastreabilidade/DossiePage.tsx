import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { formatDate, formatDateTime } from '../../lib/utils'

/**
 * O dossiê: da validade do produto até a nota fiscal do insumo.
 *
 * Este documento sai da tela e vai para a mão de um auditor do cliente, então
 * ele tem duas obrigações que uma tela comum não tem: caber numa folha A4 e
 * dizer o que NÃO sabe. Sessão sem rastreabilidade de insumo aparece com o
 * aviso escrito, e não como uma tabela vazia que parece defeito.
 *
 * Tudo vem de uma chamada só (`dossie_rastreabilidade`, migration 093) porque
 * são cinco níveis de junção: consulta em cascata no cliente seria lenta e
 * impossível de conferir.
 *
 * A ficha técnica mostrada é a VERSÃO USADA na sessão, não a de hoje — numa
 * auditoria de agosto vale a receita de agosto.
 */

interface Lote {
  codigo: string
  qr_code: string | null
  quantidade_produzida: number
  quantidade_disponivel: number
  status: string
  data_producao: string
  data_desenforma: string | null
  sessao_id: string
}

interface ItemFicha {
  insumo_codigo: string
  insumo_nome: string
  quantidade: number
  unidade: string
  observacoes: string | null
}

interface Sku {
  ficha_id: string
  ficha_codigo: string
  ficha_nome: string
  versao_id: string
  versao: number
  notas_alteracao: string | null
  rendimento_fornada: number | null
  peso_medio_g: number | null
  formas_assadas: number | null
  quantidade_produzida: number | null
  itens: ItemFicha[] | null
}

interface Sessao {
  id: string
  codigo: string
  data_producao: string
  data_abertura: string | null
  data_fechamento: string | null
  aberta_por: string | null
  fechada_por: string | null
  observacoes_abertura: string | null
  observacoes_fechamento: string | null
  skus: Sku[] | null
}

interface InsumoUsado {
  sessao_codigo: string
  insumo_codigo: string
  insumo_nome: string
  unidade: string
  consumo_real: number
  lote_codigo: string
  sublotes: number
  marca: string | null
  fornecedor: string | null
  fornecedor_cnpj: string | null
  numero_nf: string | null
  data_recebimento: string | null
  data_fabricacao: string | null
  validade_original: string | null
  temperatura_recebimento: number | null
  embalagem_aberta: boolean | null
  origem: string | null
  recebido_por: string | null
  recipientes: string | null
}

interface Desenforma {
  sessao_codigo: string
  data_desenforma: string
  validade: string
  formas: number
  no_forno: number
  descartadas: number
  aproveitadas: number
}

/**
 * O aproveitamento destas unidades.
 *
 * Só o descarte da DESENFORMA entra aqui: é o que quebrou nas formas que
 * viraram este lote, medido no dia, com motivo. A perda de insumo fica de fora
 * de propósito — ela é apurada na auditoria de estoque, por período, e não se
 * reparte por lote.
 */
interface Resumo {
  formas: number
  no_forno: number
  descartadas: number
  aproveitadas: number
  perda_pct: number
}

interface Descarte {
  motivo: string
  quantidade: number
}

interface Dossie {
  ok: boolean
  erro?: string
  validade: string
  produto: {
    id: string; codigo: string; nome: string
    peso_unitario_g: number | null; validade_dias: number | null
    ficha_tecnica_id: string | null
  }
  resumo: Resumo
  descartes: Descarte[]
  lotes: Lote[]
  sessoes: Sessao[]
  insumos: InsumoUsado[]
  desenforma: Desenforma[]
  avisos: string[]
  emitido_em: string
}

const ORIGEM_LABEL: Record<string, string> = {
  recebimento: 'Recebimento de fornecedor',
  inventario_inicial: 'Abertura de estoque',
  producao: 'Produzido na casa',
}

function fmt(n: number | null | undefined, casas = 3) {
  if (n === null || n === undefined) return '—'
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: casas })
}

/** Impressão em A4: o resto da aplicação some, só o dossiê fica. */
const printStyles = `
  @page { size: A4; margin: 14mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    body * { visibility: hidden; }
    .dossie-print, .dossie-print * { visibility: visible; }
    .dossie-print {
      position: absolute; left: 0; top: 0; width: 100%;
      color: #000; background: #fff;
    }
    .dossie-no-print { display: none !important; }
    /* Nenhum bloco pode ser partido no meio: quem lê em papel perde o fio. */
    .dossie-bloco { break-inside: avoid; page-break-inside: avoid;
                    border: 1px solid #ddd !important; box-shadow: none !important;
                    border-radius: 6px !important; margin-bottom: 10px; }
    .dossie-print table { font-size: 10pt; }
  }
`

export function DossiePage() {
  const { validade, produtoId } = useParams<{ validade: string; produtoId: string }>()
  const { profile } = useAuth()
  const [dossie, setDossie] = useState<Dossie | null>(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile || !validade || !produtoId) return
    supabase
      .rpc('dossie_rastreabilidade', {
        p_empresa_id: profile.empresa_id,
        p_validade: validade,
        p_produto_id: produtoId,
      })
      .then(({ data, error }) => {
        const resp = data as unknown as Dossie | null
        if (error || !resp?.ok) {
          setErro(error?.message ?? resp?.erro ?? 'Não foi possível montar o dossiê.')
        } else {
          setDossie(resp)
        }
        setLoading(false)
      })
  }, [profile, validade, produtoId])

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (erro || !dossie) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500">{erro || 'Dossiê não encontrado.'}</p>
        <Link to="/rastreabilidade" className="text-brand-600 text-sm mt-2 inline-block">
          Voltar para a rastreabilidade
        </Link>
      </div>
    )
  }

  const totalProduzido = dossie.lotes.reduce((t, l) => t + l.quantidade_produzida, 0)
  const totalDisponivel = dossie.lotes.reduce((t, l) => t + l.quantidade_disponivel, 0)
  const primeiraFicha = dossie.sessoes[0]?.skus?.[0]

  return (
    <>
      <style>{printStyles}</style>

      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        {/* ── Barra de ações: não vai para o papel ─────────── */}
        <div className="dossie-no-print flex flex-wrap items-center justify-between gap-3 mb-5">
          <Link
            to="/rastreabilidade"
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Voltar
          </Link>
          <div className="flex gap-2">
            {primeiraFicha && (
              <Link to={`/fichas/${primeiraFicha.ficha_id}/imprimir?versao=${primeiraFicha.versao_id}`}>
                <Button variant="secondary" size="sm">Exportar ficha técnica</Button>
              </Link>
            )}
            <Button size="sm" onClick={() => window.print()}>Exportar dossiê</Button>
          </div>
        </div>

        <div className="dossie-print lg:grid lg:grid-cols-[16rem_1fr] lg:gap-5 lg:items-start">
          {/* ── Card lateral: a identidade do que se rastreia ── */}
          <Card className="dossie-bloco mb-5 lg:mb-0 lg:sticky lg:top-4">
            <CardBody className="space-y-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Dossiê de rastreabilidade</p>
                <p className="text-base font-bold text-gray-900 dark:text-unno-text leading-tight mt-0.5">
                  {dossie.produto.nome}
                </p>
                <p className="text-xs text-gray-500 dark:text-unno-muted font-mono">
                  {dossie.produto.codigo}
                </p>
              </div>

              <div className="pt-3 border-t border-gray-100 dark:border-white/[.06]">
                <p className="text-[11px] uppercase tracking-wide text-gray-400">Validade</p>
                <p className="text-lg font-bold text-gray-900 dark:text-unno-text">
                  {formatDate(dossie.validade)}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {/* "Aproveitadas", não "produzidas": o card lateral fala da
                    mesma coisa que o bloco de aproveitamento, e usar dois
                    rótulos para o mesmo número confunde quem confere. */}
                <div>
                  <p className="text-gray-400">Aproveitadas</p>
                  <p className="font-semibold text-gray-900 dark:text-unno-text">{fmt(totalProduzido, 0)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Em estoque</p>
                  <p className="font-semibold text-gray-900 dark:text-unno-text">{fmt(totalDisponivel, 0)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Lotes</p>
                  <p className="font-semibold text-gray-900 dark:text-unno-text">{dossie.lotes.length}</p>
                </div>
                <div>
                  <p className="text-gray-400">Produções</p>
                  <p className="font-semibold text-gray-900 dark:text-unno-text">{dossie.sessoes.length}</p>
                </div>
              </div>

              {dossie.produto.peso_unitario_g && (
                <p className="text-xs text-gray-500 dark:text-unno-muted">
                  {fmt(dossie.produto.peso_unitario_g, 0)} g por unidade
                </p>
              )}

              <p className="text-[10px] text-gray-400 pt-2 border-t border-gray-100 dark:border-white/[.06]">
                Emitido em {formatDateTime(dossie.emitido_em)}
              </p>
            </CardBody>
          </Card>

          <div className="space-y-5">
            {/* ── O que este documento não prova ─────────────── */}
            {dossie.avisos.length > 0 && (
              <div className="dossie-bloco p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
                {dossie.avisos.map((a, i) => <p key={i}>{a}</p>)}
              </div>
            )}

            {/* ── Aproveitamento: a primeira coisa que se lê ─── */}
            {dossie.resumo?.no_forno > 0 && (
              <Card className="dossie-bloco">
                <CardHeader
                  title="Aproveitamento"
                  subtitle="Do que saiu do forno até o que virou estoque"
                />
                <CardBody className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-gray-400">Produzidas</p>
                      <p className="text-xl font-bold text-gray-900 dark:text-unno-text tabular-nums">
                        {fmt(dossie.resumo.no_forno, 0)}
                      </p>
                      <p className="text-[11px] text-gray-400">{dossie.resumo.formas} formas</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-gray-400">Aproveitadas</p>
                      <p className="text-xl font-bold text-emerald-600 tabular-nums">
                        {fmt(dossie.resumo.aproveitadas, 0)}
                      </p>
                      <p className="text-[11px] text-gray-400">viraram estoque</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-gray-400">Descartadas</p>
                      <p className="text-xl font-bold text-gray-900 dark:text-unno-text tabular-nums">
                        {fmt(dossie.resumo.descartadas, 0)}
                      </p>
                      <p className="text-[11px] text-gray-400">unidades</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-gray-400">Perda</p>
                      <p className="text-xl font-bold text-gray-900 dark:text-unno-text tabular-nums">
                        {fmt(dossie.resumo.perda_pct, 2)}%
                      </p>
                      <p className="text-[11px] text-gray-400">na desenforma</p>
                    </div>
                  </div>

                  {dossie.descartes.length > 0 && (
                    <div className="pt-3 border-t border-gray-100 dark:border-white/[.06]">
                      <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">
                        Motivo do descarte
                      </p>
                      <div className="flex flex-wrap gap-x-5 gap-y-1">
                        {dossie.descartes.map(d => (
                          <span key={d.motivo} className="text-sm text-gray-700 dark:text-unno-muted">
                            {d.motivo}{' '}
                            <strong className="text-gray-900 dark:text-unno-text tabular-nums">
                              {fmt(d.quantidade, 0)}
                            </strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Quem lê o documento precisa saber o que ele não mede. */}
                  <p className="text-[11px] text-gray-400 pt-1">
                    Perda medida na desenforma. A perda de insumo é apurada por
                    período na auditoria de estoque e não se reparte por lote.
                  </p>
                </CardBody>
              </Card>
            )}

            {/* ── Lotes ──────────────────────────────────────── */}
            <Card className="dossie-bloco">
              <CardHeader title="Lotes do produto" subtitle="O que vence nesta data" />
              <CardBody className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Lote</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Produção</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Desenforma</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Produzidas</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Em estoque</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                    {dossie.lotes.map(l => (
                      <tr key={l.codigo}>
                        <td className="px-4 py-2 font-mono text-xs">{l.codigo}</td>
                        <td className="px-4 py-2">{formatDate(l.data_producao)}</td>
                        <td className="px-4 py-2">{l.data_desenforma ? formatDate(l.data_desenforma) : '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmt(l.quantidade_produzida, 0)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmt(l.quantidade_disponivel, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>

            {/* ── Produção ───────────────────────────────────── */}
            <Card className="dossie-bloco">
              <CardHeader
                title="Produção"
                subtitle={dossie.sessoes.length > 1
                  ? 'Mais de uma produção originou este lote — todas entram no dossiê'
                  : 'A sessão que originou este produto'}
              />
              <CardBody className="space-y-4">
                {dossie.sessoes.map(s => (
                  <div key={s.id} className="space-y-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                      <span className="font-mono">{s.codigo}</span>
                      {' · '}{formatDate(s.data_producao)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">
                      Aberta por {s.aberta_por ?? '—'}
                      {s.data_abertura && ` em ${formatDateTime(s.data_abertura)}`}
                      {' · '}fechada por {s.fechada_por ?? '—'}
                      {s.data_fechamento && ` em ${formatDateTime(s.data_fechamento)}`}
                    </p>
                    {(s.skus ?? []).map(sk => (
                      <p key={sk.versao_id} className="text-xs text-gray-600 dark:text-unno-muted">
                        {sk.ficha_nome} — {sk.formas_assadas ?? '—'} formas assadas
                        {sk.quantidade_produzida !== null && `, ${fmt(sk.quantidade_produzida, 0)} unidades boas`}
                      </p>
                    ))}
                    {(s.observacoes_abertura || s.observacoes_fechamento) && (
                      <p className="text-xs text-gray-500 dark:text-unno-muted italic">
                        {[s.observacoes_abertura, s.observacoes_fechamento].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>

            {/* ── Ficha técnica na versão usada ──────────────── */}
            {dossie.sessoes.flatMap(s => s.skus ?? []).map(sk => (
              <Card key={`${sk.versao_id}-ficha`} className="dossie-bloco">
                <CardHeader
                  title={`Ficha técnica — ${sk.ficha_nome}`}
                  subtitle={`Versão ${sk.versao} · ${sk.ficha_codigo}`
                    + (sk.rendimento_fornada ? ` · rende ${sk.rendimento_fornada} un por forma` : '')
                    + (sk.peso_medio_g ? ` · ${fmt(sk.peso_medio_g, 0)} g por unidade` : '')}
                  action={
                    <Link
                      to={`/fichas/${sk.ficha_id}/imprimir?versao=${sk.versao_id}`}
                      className="dossie-no-print"
                    >
                      <Button variant="ghost" size="sm">Exportar</Button>
                    </Link>
                  }
                />
                <CardBody className="p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Por forma</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Observação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {(sk.itens ?? []).map(it => (
                        <tr key={it.insumo_codigo}>
                          <td className="px-4 py-2">
                            <span className="text-gray-400 font-mono text-xs mr-1.5">{it.insumo_codigo}</span>
                            {it.insumo_nome}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                            {fmt(it.quantidade)} {it.unidade}
                          </td>
                          <td className="px-4 py-2 text-xs text-gray-500">{it.observacoes ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sk.notas_alteracao && (
                    <p className="px-4 py-2 text-xs text-gray-500 dark:text-unno-muted border-t border-gray-100 dark:border-white/[.06]">
                      {sk.notas_alteracao}
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}

            {/* ── Insumos, lotes e marcas ────────────────────── */}
            <Card className="dossie-bloco">
              <CardHeader
                title="Insumos utilizados"
                subtitle="O que de fato saiu dos recipientes nesta produção"
              />
              <CardBody className="p-0 overflow-x-auto">
                {dossie.insumos.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-center text-gray-400">
                    Sem consumo de insumo registrado nestas produções.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Insumo</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Lote</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Marca</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Consumo</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Recipiente</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {dossie.insumos.map((u, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2">
                            <span className="text-gray-400 font-mono text-xs mr-1.5">{u.insumo_codigo}</span>
                            {u.insumo_nome}
                            {dossie.sessoes.length > 1 && (
                              <span className="block text-[11px] text-gray-400 font-mono">{u.sessao_codigo}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {u.lote_codigo}
                            {u.sublotes > 1 && (
                              <span className="block text-[11px] text-gray-400 font-sans">
                                {u.sublotes} sublotes
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">{u.marca ?? '—'}</td>
                          <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                            {fmt(u.consumo_real)} {u.unidade}
                          </td>
                          <td className="px-4 py-2 text-xs text-gray-500">{u.recipientes ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>

            {/* ── Recebimento e nota fiscal ──────────────────── */}
            {dossie.insumos.length > 0 && (
              <Card className="dossie-bloco">
                <CardHeader
                  title="Recebimento e nota fiscal"
                  subtitle="De onde veio cada lote de insumo"
                />
                <CardBody className="p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Lote</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Fornecedor</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">NF</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Recebido</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Validade de origem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {dossie.insumos.map((u, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2">
                            <span className="font-mono text-xs">{u.lote_codigo}</span>
                            <span className="block text-[11px] text-gray-400">{u.insumo_nome}</span>
                          </td>
                          <td className="px-4 py-2">
                            {u.fornecedor ?? '—'}
                            {u.fornecedor_cnpj && (
                              <span className="block text-[11px] text-gray-400">{u.fornecedor_cnpj}</span>
                            )}
                            <span className="block text-[11px] text-gray-400">
                              {ORIGEM_LABEL[u.origem ?? ''] ?? u.origem ?? ''}
                            </span>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">{u.numero_nf ?? '—'}</td>
                          <td className="px-4 py-2 text-xs">
                            {u.data_recebimento ? formatDate(u.data_recebimento) : '—'}
                            {u.temperatura_recebimento !== null && (
                              <span className="block text-[11px] text-gray-400">
                                {fmt(u.temperatura_recebimento, 1)} °C na chegada
                              </span>
                            )}
                            {u.recebido_por && (
                              <span className="block text-[11px] text-gray-400">por {u.recebido_por}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {u.validade_original ? formatDate(u.validade_original) : '—'}
                            {u.data_fabricacao && (
                              <span className="block text-[11px] text-gray-400">
                                fabricado em {formatDate(u.data_fabricacao)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>
            )}

            {/* ── Desenforma ─────────────────────────────────── */}
            {dossie.desenforma.length > 0 && (
              <Card className="dossie-bloco">
                <CardHeader
                  title="Desenforma"
                  subtitle="Cada dia em que se desenformou, com o que quebrou nele — é daqui que conta a validade"
                />
                <CardBody className="p-0 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-100 dark:border-white/[.06]">
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Produção</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase">Data</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Formas</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Produzidas</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Descartadas</th>
                        <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase text-right">Aproveitadas</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-white/[.04]">
                      {dossie.desenforma.map((d, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2 font-mono text-xs">{d.sessao_codigo}</td>
                          <td className="px-4 py-2">{formatDate(d.data_desenforma)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{d.formas}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmt(d.no_forno, 0)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmt(d.descartadas, 0)}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-medium">
                            {fmt(d.aproveitadas, 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

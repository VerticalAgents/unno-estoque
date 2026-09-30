import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { CampoNumerico } from '../../components/ui/CampoNumerico'
import { CartaoLista, ListaResponsiva, ListaVazia } from '../../components/ui/ListaResponsiva'
import { formatQty } from '../../lib/utils'
import { QtdPorUnidade, usePorUnidade } from '../../lib/porUnidade'
import type { UnidadeMedida } from '../../types/database.types'

/**
 * META SEMANAL DA ODARA — quanto dura o estoque e quanto pedir (migration 131).
 *
 * A Odara compra os insumos e manda uma entrega por semana, na sexta, que
 * precisa cobrir a semana seguinte com folga: é a folga que deixa abastecer na
 * sexta os potes da segunda. Quem compra lá comprava no escuro (Lucca,
 * 29/09/2026). Esta tela é a planilha "PLANEJAMENTO DE REABASTECIMENTO" com o
 * estoque de verdade no lugar da contagem à mão.
 *
 * A autonomia NÃO é em dias: a semana às vezes tem quatro dias de Odara, às
 * vezes todos. É em semanas de meta — e em brownies, displays e caixas, que é
 * o que a Odara vende.
 */

const UN_POR_FORMA = 60     // convenção Odara (contexto/glossario.md)
const UN_POR_DISPLAY = 12
const UN_POR_CAIXA = 72     // 6 displays

type Ficha = { id: string; nome: string; versaoId: string | null }
type Linha = {
  insumo_id: string
  codigo: string
  nome: string
  unidade: UnidadeMedida
  consumoSemana: number
  aqui: number
  odara: number | null
  odaraEm: string | null
  embTam: number | null
  embTipo: string | null
}

const PLURAL: Record<string, [string, string]> = {
  fardo: ['fardo', 'fardos'], caixa: ['caixa', 'caixas'], saca: ['saca', 'sacas'],
  saco: ['saco', 'sacos'], balde: ['balde', 'baldes'], garrafa: ['galão/garrafa', 'galões/garrafas'],
  lata: ['lata', 'latas'], display: ['display', 'displays'],
}
const nomeEmb = (tipo: string | null, n: number) => {
  const par = PLURAL[tipo ?? ''] ?? ['embalagem', 'embalagens']
  return n === 1 ? par[0] : par[1]
}
const num = (v: number, casas = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: casas })
const milhares = (v: number) => v >= 10000 ? `${num(v / 1000, 1)} mil` : num(Math.round(v), 0)
const dataCurta = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** A Meta Odara sozinha, com moldura de página — a rota do papel 'odara'. */
export function MetaOdaraAvulsaPage() {
  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Meta Odara</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-1">
          Quanto dura cada insumo e quanto pedir para a entrega de sexta. Atualize a coluna "Na Odara" com o estoque de lá.
        </p>
      </div>
      <MetaOdaraPage />
    </div>
  )
}

export function MetaOdaraPage() {
  const { profile } = useAuth()
  const porUnidade = usePorUnidade()
  /** O papel 'odara' vê a meta, mas só grava o estoque de lá (migration 134b). */
  const soLeMeta = profile?.papel === 'odara'

  const [carregando, setCarregando] = useState(true)
  const [fichas, setFichas] = useState<Ficha[]>([])
  const [receitas, setReceitas] = useState<Record<string, { insumo_id: string; quantidade: number }[]>>({})
  /** O que está gravado, e o que está sendo digitado — para saber se há o que salvar. */
  const [metasSalvas, setMetasSalvas] = useState<Record<string, number>>({})
  const [metas, setMetas] = useState<Record<string, string>>({})
  const [folgaSalva, setFolgaSalva] = useState(20)
  const [folga, setFolga] = useState('20')
  const [salvando, setSalvando] = useState(false)
  const [estoque, setEstoque] = useState<Record<string, { codigo: string; nome: string; unidade: UnidadeMedida; total: number }>>({})
  const [externo, setExterno] = useState<Record<string, { quantidade: number | null; em: string | null }>>({})
  /** O que está sendo digitado no campo "na Odara", por insumo. */
  const [odaraTxt, setOdaraTxt] = useState<Record<string, string>>({})
  const [embalagem, setEmbalagem] = useState<Record<string, { tam: number | null; tipo: string | null }>>({})
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile) return
    let vivo = true
    const eid = profile.empresa_id

    async function carregar() {
      const [fch, mts, cfg, est, ext, ins, emb] = await Promise.all([
        supabase.from('fichas_tecnicas')
          .select('id, nome, versoes:fichas_tecnicas_versoes(id, ativa)')
          .eq('empresa_id', eid).eq('ativo', true).ilike('nome', '%odara%').order('nome'),
        supabase.from('metas_semanais_ficha').select('ficha_id, formas_semana').eq('empresa_id', eid),
        supabase.from('configuracoes_sistema').select('folga_reabastecimento_pct').eq('empresa_id', eid).maybeSingle(),
        supabase.from('v_estoque_consolidado')
          .select('insumo_id, insumo_codigo, insumo_nome, unidade_medida, qtd_total').eq('empresa_id', eid),
        supabase.from('estoque_externo_insumo').select('insumo_id, quantidade, updated_at').eq('empresa_id', eid),
        supabase.from('insumos').select('id, tamanho_embalagem').eq('empresa_id', eid),
        supabase.from('insumos_embalagem_config').select('insumo_id, tipo_embalagem, quantidade_total'),
      ])
      if (!vivo) return

      const fs: Ficha[] = ((fch.data ?? []) as unknown as { id: string; nome: string; versoes: { id: string; ativa: boolean }[] }[])
        .map(f => ({ id: f.id, nome: f.nome, versaoId: f.versoes?.find(v => v.ativa)?.id ?? null }))
      setFichas(fs)

      const versoes = fs.map(f => f.versaoId).filter((v): v is string => !!v)
      const itens = versoes.length
        ? (await supabase.from('fichas_tecnicas_itens').select('versao_id, insumo_id, quantidade').in('versao_id', versoes)).data ?? []
        : []
      if (!vivo) return
      const porVersao: Record<string, { insumo_id: string; quantidade: number }[]> = {}
      for (const it of itens as { versao_id: string; insumo_id: string; quantidade: number }[]) {
        (porVersao[it.versao_id] ??= []).push({ insumo_id: it.insumo_id, quantidade: Number(it.quantidade) })
      }
      setReceitas(Object.fromEntries(fs.map(f => [f.id, f.versaoId ? porVersao[f.versaoId] ?? [] : []])))

      const ms = Object.fromEntries(((mts.data ?? []) as { ficha_id: string; formas_semana: number }[])
        .map(m => [m.ficha_id, Number(m.formas_semana)]))
      setMetasSalvas(ms)
      setMetas(Object.fromEntries(fs.map(f => [f.id, String(ms[f.id] ?? 0)])))

      const fg = Number((cfg.data as { folga_reabastecimento_pct: number } | null)?.folga_reabastecimento_pct ?? 20)
      setFolgaSalva(fg)
      setFolga(String(fg))

      setEstoque(Object.fromEntries(((est.data ?? []) as {
        insumo_id: string; insumo_codigo: string; insumo_nome: string; unidade_medida: UnidadeMedida; qtd_total: number
      }[]).map(e => [e.insumo_id, { codigo: e.insumo_codigo, nome: e.insumo_nome, unidade: e.unidade_medida, total: Number(e.qtd_total ?? 0) }])))

      const ex = Object.fromEntries(((ext.data ?? []) as { insumo_id: string; quantidade: number | null; updated_at: string }[])
        .map(e => [e.insumo_id, { quantidade: e.quantidade == null ? null : Number(e.quantidade), em: e.updated_at }]))
      setExterno(ex)
      setOdaraTxt(Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, v.quantidade == null ? '' : String(v.quantidade)])))

      const tipos = Object.fromEntries(((emb.data ?? []) as { insumo_id: string; tipo_embalagem: string | null; quantidade_total: number | null }[])
        .map(e => [e.insumo_id, e]))
      setEmbalagem(Object.fromEntries(((ins.data ?? []) as { id: string; tamanho_embalagem: number | null }[]).map(i => {
        const t = tipos[i.id]
        const tam = Number(i.tamanho_embalagem) > 0 ? Number(i.tamanho_embalagem)
          : Number(t?.quantidade_total) > 0 ? Number(t!.quantidade_total) : null
        return [i.id, { tam, tipo: t?.tipo_embalagem ?? null }]
      })))

      setCarregando(false)
    }
    carregar()
    return () => { vivo = false }
  }, [profile?.empresa_id])

  // ── A meta ─────────────────────────────────────────────────
  const formasDe = (id: string) => Math.max(0, parseInt(metas[id] ?? '0', 10) || 0)
  const formasSemana = fichas.reduce((s, f) => s + formasDe(f.id), 0)
  const brownies = formasSemana * UN_POR_FORMA
  const folgaNum = Math.max(0, parseFloat(folga.replace(',', '.')) || 0)
  const mudouMeta = fichas.some(f => formasDe(f.id) !== (metasSalvas[f.id] ?? 0)) || folgaNum !== folgaSalva

  async function salvarMeta() {
    if (!profile) return
    setSalvando(true)
    setErro('')
    const { error: e1 } = await supabase.from('metas_semanais_ficha').upsert(
      fichas.map(f => ({
        empresa_id: profile.empresa_id, ficha_id: f.id,
        formas_semana: formasDe(f.id), updated_by: profile.id,
      })),
      { onConflict: 'empresa_id,ficha_id' },
    )
    const { error: e2 } = await supabase.from('configuracoes_sistema')
      .update({ folga_reabastecimento_pct: folgaNum }).eq('empresa_id', profile.empresa_id)
    setSalvando(false)
    if (e1 || e2) { setErro((e1 ?? e2)!.message); return }
    setMetasSalvas(Object.fromEntries(fichas.map(f => [f.id, formasDe(f.id)])))
    setFolgaSalva(folgaNum)
  }

  // ── Estoque na Odara: grava ao sair do campo ───────────────
  async function salvarOdara(insumoId: string) {
    if (!profile) return
    const txt = (odaraTxt[insumoId] ?? '').replace(',', '.').trim()
    const valor = txt === '' ? null : parseFloat(txt)
    if (valor !== null && (isNaN(valor) || valor < 0)) return
    if ((externo[insumoId]?.quantidade ?? null) === valor) return
    const { error } = await supabase.from('estoque_externo_insumo').upsert({
      empresa_id: profile.empresa_id, insumo_id: insumoId,
      quantidade: valor, atualizado_por: profile.id,
    }, { onConflict: 'empresa_id,insumo_id' })
    if (error) { setErro(error.message); return }
    setExterno(x => ({ ...x, [insumoId]: { quantidade: valor, em: new Date().toISOString() } }))
  }

  // ── A tabela ───────────────────────────────────────────────
  const linhas: Linha[] = useMemo(() => {
    const consumo = new Map<string, number>()
    for (const f of fichas) {
      const n = formasDe(f.id)
      if (n <= 0) continue
      for (const it of receitas[f.id] ?? []) {
        consumo.set(it.insumo_id, (consumo.get(it.insumo_id) ?? 0) + it.quantidade * n)
      }
    }
    return [...consumo.entries()]
      .filter(([, c]) => c > 0)
      .map(([id, c]) => {
        const e = estoque[id]
        return {
          insumo_id: id,
          codigo: e?.codigo ?? '',
          nome: e?.nome ?? '—',
          unidade: e?.unidade ?? 'kg',
          consumoSemana: c,
          aqui: e?.total ?? 0,
          odara: externo[id]?.quantidade ?? null,
          odaraEm: externo[id]?.em ?? null,
          embTam: embalagem[id]?.tam ?? null,
          embTipo: embalagem[id]?.tipo ?? null,
        }
      })
      // A mais urgente primeiro: a que dura menos aqui.
      .sort((a, b) => a.aqui / a.consumoSemana - b.aqui / b.consumoSemana)
  }, [fichas, receitas, metas, estoque, externo, embalagem])

  function autonomia(l: Linha) {
    const aqui = l.aqui / l.consumoSemana
    const total = (l.aqui + (l.odara ?? 0)) / l.consumoSemana
    const precisa = l.consumoSemana * (1 + folgaNum / 100)
    const falta = Math.max(0, precisa - l.aqui)
    const embs = l.embTam && falta > 0 ? Math.ceil(falta / l.embTam - 1e-9) : null
    const nivel = aqui < 1 ? 'vermelho' : aqui < 1 + folgaNum / 100 ? 'amarelo' : 'verde'
    return { aqui, total, falta, embs, nivel }
  }

  const COR: Record<string, string> = {
    vermelho: 'text-red-600 dark:text-red-400',
    amarelo: 'text-amber-600 dark:text-amber-400',
    verde: 'text-emerald-700 dark:text-emerald-400',
  }

  const qtd = (v: number, l: Linha) => (
    <QtdPorUnidade valor={v} unidade={l.unidade} config={porUnidade[l.insumo_id]} />
  )

  function celulaOdara(l: Linha) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <input
          type="number" inputMode="decimal" min={0} step="any"
          value={odaraTxt[l.insumo_id] ?? ''}
          onChange={e => setOdaraTxt(t => ({ ...t, [l.insumo_id]: e.target.value }))}
          onBlur={() => salvarOdara(l.insumo_id)}
          onClick={e => e.stopPropagation()}
          placeholder="—"
          className="w-24 rounded-controle border border-gray-300 dark:border-white/10 bg-white dark:bg-white/5
                     px-2 py-1 text-right text-sm tabular-nums focus:outline-none focus:border-brand-500"
          aria-label={`Estoque de ${l.nome} na Odara (${l.unidade})`}
        />
        <span className="text-[0.65rem] text-muted-foreground">
          {l.odaraEm ? `atualizado ${dataCurta(l.odaraEm)}` : l.unidade}
        </span>
      </div>
    )
  }

  /**
   * Quantos brownies de CADA ficha o estoque aguenta, na proporção da meta.
   *
   * Um número só, somando as fichas, mentia: o choco em pó só entra no
   * Tradicional, e a conta dava a ele os brownies de Doce de Leite também
   * (Lucca, 29/09/2026). Aqui entra só a ficha que usa o insumo.
   */
  function porFicha(l: Linha, semanas: number) {
    return fichas
      .filter(f => formasDe(f.id) > 0 && (receitas[f.id] ?? []).some(i => i.insumo_id === l.insumo_id))
      .map(f => {
        const un = semanas * formasDe(f.id) * UN_POR_FORMA
        return {
          id: f.id,
          nome: f.nome.replace(/^Brownie /, '').replace(/ Odara$/, ''),
          un,
          dica: `${milhares(un / UN_POR_DISPLAY)} displays · ${milhares(un / UN_POR_CAIXA)} caixas`,
        }
      })
  }

  function celulaAutonomia(l: Linha) {
    const a = autonomia(l)
    const temOdara = l.odara != null
    const semanas = temOdara ? a.total : a.aqui
    return (
      <div className="text-right tabular-nums">
        <p className={`font-semibold ${COR[a.nivel]}`}>{num(a.aqui)} sem. na fábrica</p>
        {temOdara && <p className="text-xs text-muted-foreground">{num(a.total)} sem. com a Odara</p>}
        {porFicha(l, semanas).map(f => (
          <p key={f.id} className="text-xs text-muted-foreground" title={f.dica}>
            ≈ {milhares(f.un)} {f.nome}
          </p>
        ))}
      </div>
    )
  }

  function celulaPedido(l: Linha) {
    const a = autonomia(l)
    if (a.falta <= 0) return <span className="text-muted-foreground">—</span>
    return (
      <div className="text-right tabular-nums">
        {a.embs != null
          ? <p className="font-semibold text-foreground">{a.embs} {nomeEmb(l.embTipo, a.embs)}</p>
          : <p className="font-semibold text-foreground">{formatQty(a.falta, l.unidade)}</p>}
        {a.embs != null && l.embTam && (
          <p className="text-xs text-muted-foreground">{formatQty(a.embs * l.embTam, l.unidade)}</p>
        )}
      </div>
    )
  }

  if (carregando) return <p className="text-sm text-gray-500">Carregando…</p>

  return (
    <div className="space-y-5">
      {/* ── A meta ── */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[1px] text-muted-foreground">Meta semanal</p>
            {fichas.map(f => (
              <div key={f.id} className="flex items-center gap-3">
                <CampoNumerico
                  valor={metas[f.id] ?? '0'}
                  onDigitar={v => setMetas(m => ({ ...m, [f.id]: v.replace(/\D/g, '') }))}
                  onPasso={d => setMetas(m => ({ ...m, [f.id]: String(Math.max(0, formasDe(f.id) + d)) }))}
                  sufixo="formas"
                  min={0}
                  desabilitado={soLeMeta}
                />
                <span className="text-sm text-foreground">{f.nome.replace(/^Brownie /, '')}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {milhares(formasDe(f.id) * UN_POR_FORMA)} brownies
                  {formasSemana > 0 && (
                    <> · <strong className="text-foreground">{Math.round(formasDe(f.id) / formasSemana * 100)}%</strong> da semana</>
                  )}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
              <CampoNumerico
                valor={folga}
                onDigitar={v => setFolga(v.replace(/[^\d.,]/g, ''))}
                onPasso={d => setFolga(String(Math.max(0, folgaNum + d * 5)))}
                sufixo="%"
                min={0}
                desabilitado={soLeMeta}
              />
              <span className="text-sm text-foreground">de folga na entrega</span>
            </div>
          </div>

          <div className="text-right space-y-1">
            <p className="text-2xl font-bold tabular-nums text-foreground">{formasSemana} formas</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              {milhares(brownies)} brownies · {milhares(brownies / UN_POR_DISPLAY)} displays ·{' '}
              {milhares(Math.ceil(brownies / UN_POR_CAIXA))} caixas por semana
            </p>
            {mudouMeta && !soLeMeta && (
              <Button size="sm" loading={salvando} onClick={salvarMeta} className="mt-2">Salvar meta</Button>
            )}
            {erro && <p className="text-xs text-red-600">{erro}</p>}
          </div>
        </div>
      </Card>

      {/* ── Por insumo ── */}
      <Card>
        <ListaResponsiva
          cartoes={linhas.length === 0
            ? <ListaVazia>Defina a meta para ver os insumos.</ListaVazia>
            : linhas.map(l => {
                const a = autonomia(l)
                return (
                  <CartaoLista
                    key={l.insumo_id}
                    titulo={<span className="font-medium text-foreground">{l.nome}</span>}
                    subtitulo={`${l.codigo} · ${formatQty(l.consumoSemana, l.unidade)}/semana`}
                    destaque={<span className={`tabular-nums font-semibold ${COR[a.nivel]}`}>{num(a.aqui)} sem.</span>}
                    campos={[
                      { rotulo: 'Na fábrica', valor: <span className="tabular-nums">{qtd(l.aqui, l)}</span> },
                      { rotulo: 'Na Odara', valor: celulaOdara(l) },
                      { rotulo: 'Autonomia', valor: celulaAutonomia(l) },
                      { rotulo: 'Pedir p/ sexta', valor: celulaPedido(l) },
                    ]}
                  />
                )
              })}
          tabela={
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {['Insumo', 'Consumo/semana', 'Na fábrica', 'Na Odara', 'Autonomia', 'Pedir p/ sexta'].map((h, i) => (
                    <th key={h} className={`px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[1px] text-muted-foreground ${i ? 'text-right' : ''}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {linhas.map(l => (
                  <tr key={l.insumo_id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{l.nome}</p>
                      <p className="text-xs text-muted-foreground">{l.codigo}</p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-foreground">{qtd(l.consumoSemana, l)}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-foreground">{qtd(l.aqui, l)}</td>
                    <td className="px-4 py-3">{celulaOdara(l)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{celulaAutonomia(l)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{celulaPedido(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      </Card>

      <p className="text-xs text-muted-foreground px-1">
        <strong>Pedir p/ sexta</strong> = uma semana de meta + {num(folgaNum, 0)}% de folga − o que há na fábrica agora,
        arredondado na embalagem do fornecedor. Conta com o estoque de hoje: quanto mais perto da sexta,
        mais exato. <span className="text-red-600 dark:text-red-400 font-semibold">Vermelho</span>: não chega a uma
        semana. <span className="text-amber-600 dark:text-amber-400 font-semibold">Amarelo</span>: chega, mas sem a folga.
      </p>
    </div>
  )
}

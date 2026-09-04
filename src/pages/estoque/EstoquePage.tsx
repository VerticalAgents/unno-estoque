import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { EstoqueConsolidado, CategoriaInsumo, UnidadeMedida } from '../../types/database.types'
import { Card } from '../../components/ui/Card'
import { CartaoLista, ListaResponsiva, ListaVazia } from '../../components/ui/ListaResponsiva'
import { formatQty, formatKg, formatDate, daysUntil } from '../../lib/utils'
import { InsumoDetalhePanel } from './InsumoDetalhePanel'
import { combina } from '../../lib/busca'

/**
 * ESTOQUE DE INSUMOS — a posição de tudo, EC mais EP.
 *
 * A tela é lida de duas maneiras muito diferentes. De longe, para saber **o que
 * pede providência hoje**; de perto, para conferir o número de um insumo. O
 * desenho atende as duas em ordem: o resumo em cima responde a primeira, a
 * lista embaixo responde a segunda.
 *
 * O resumo não é enfeite — cada quadro é um filtro. "3 a comprar" só vale a
 * pena estar escrito se der para tocar nele e ver quais são os três.
 */

type Alerta = 'comprar' | 'transferir' | 'etiquetar' | 'vencendo'

/** Quantos dias antes do vencimento a validade começa a incomodar. */
const DIAS_ATENCAO = 30

const CORES_SELO: Record<Alerta, string> = {
  comprar:    'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  transferir: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  etiquetar:  'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300',
  vencendo:   'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
}

/**
 * A cor da tarja na lateral da linha.
 *
 * A versão anterior pintava a linha inteira de amarelo. Com meia dúzia de
 * insumos em alerta, meia tabela ficava amarela e o destaque deixava de
 * destacar — além de brigar com a cor da validade dentro da própria linha. A
 * tarja diz a mesma coisa ocupando 3px.
 */
const CORES_TARJA: Record<Alerta, string> = {
  comprar:    '#f59e0b',
  transferir: '#3b82f6',
  etiquetar:  '#a855f7',
  vencendo:   '#ef4444',
}

const ROTULOS: Record<Alerta, string> = {
  comprar:    'comprar',
  transferir: 'transferir',
  etiquetar:  'etiquetar',
  vencendo:   `vence em ${DIAS_ATENCAO}d`,
}

const EXPLICACAO: Record<Alerta, string> = {
  comprar:    'EC abaixo do mínimo — comprar',
  transferir: 'EP abaixo do mínimo — transferir do EC',
  etiquetar:  'Há lotes sem etiqueta impressa',
  vencendo:   `Vence em até ${DIAS_ATENCAO} dias`,
}

/** Selo curto de alerta, do tamanho de caber três lado a lado num cartão. */
function Selo({ tipo }: { tipo: Alerta }) {
  return (
    <span
      title={EXPLICACAO[tipo]}
      className={`px-1.5 py-0.5 rounded-controle text-[0.65rem] font-semibold
                  uppercase tracking-wide ${CORES_SELO[tipo]}`}
    >
      {ROTULOS[tipo]}
    </span>
  )
}

// Validade mais próxima do vencimento por insumo
type ValidadeInfo = {
  insumo_id: string
  validade_ec: string | null   // validade_original do lote ativo mais próximo em EC
  validade_ep: string | null   // validade_ep do recipiente EP mais próximo
}

/**
 * Os dois temas declarados em cada faixa.
 *
 * Vermelho-escuro sobre fundo escuro não se lê a um metro da tela, que é a
 * distância de quem confere estoque em pé.
 */
function validadeClass(date: string | null): string {
  if (!date) return 'text-muted-foreground/40'
  const days = daysUntil(date)
  if (days <= DIAS_ATENCAO) return 'text-red-600 dark:text-red-400 font-semibold'
  if (days <= 60) return 'text-amber-600 dark:text-amber-400 font-semibold'
  return 'text-foreground/70'
}

/** A mais próxima entre as duas validades — é ela que decide o alerta. */
function venceEmBreve(val: ValidadeInfo | undefined): boolean {
  if (!val) return false
  return [val.validade_ec, val.validade_ep]
    .filter((d): d is string => !!d)
    .some(d => daysUntil(d) <= DIAS_ATENCAO)
}

export function EstoquePage() {
  const { profile } = useAuth()
  const [estoque, setEstoque] = useState<EstoqueConsolidado[]>([])
  const [categorias, setCategorias] = useState<CategoriaInsumo[]>([])
  const [validades, setValidades] = useState<Record<string, ValidadeInfo>>({})
  const [filtroCategoria, setFiltroCategoria] = useState('')
  /** Quadro do resumo em que se tocou. Nulo = a lista inteira. */
  const [filtroAlerta, setFiltroAlerta] = useState<Alerta | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [insumoSelecionado, setInsumoSelecionado] = useState<EstoqueConsolidado | null>(null)
  const [insumosSemEtiqueta, setInsumosSemEtiqueta] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!profile) return
    const eid = profile.empresa_id
    Promise.all([
      supabase.from('v_estoque_consolidado').select('*').eq('empresa_id', eid),
      supabase.from('categorias_insumo').select('*, insumos(id)').eq('empresa_id', eid),
      // Validade EC: lote ativo com menor validade_original por insumo
      supabase
        .from('lotes')
        .select('insumo_id, validade_original')
        .eq('empresa_id', eid)
        .eq('status', 'ativo')
        .order('validade_original', { ascending: true }),
      // Validade EP: validade_ep de locais_estado_atual (via lote) mais próxima
      supabase
        .from('locais_estado_atual')
        .select('validade_ep, lote:lotes!inner(insumo_id, empresa_id)')
        .eq('lote.empresa_id', eid)
        .not('validade_ep', 'is', null)
        .order('validade_ep', { ascending: true }),
      // Lotes ativos sem etiqueta impressa
      supabase
        .from('lotes')
        .select('insumo_id')
        .eq('empresa_id', eid)
        .eq('status', 'ativo')
        .eq('etiqueta_impressa', false),
    ]).then(([e, c, lotesEc, lotesEp, semEtiqueta]) => {
      setEstoque((e.data ?? []) as EstoqueConsolidado[])
      setCategorias((c.data ?? []) as CategoriaInsumo[])

      // Agrupa validade EC por insumo (a mais próxima)
      const ecMap: Record<string, string> = {}
      for (const l of (lotesEc.data ?? []) as { insumo_id: string; validade_original: string }[]) {
        if (!ecMap[l.insumo_id]) ecMap[l.insumo_id] = l.validade_original
      }

      // Agrupa validade EP por insumo (a mais próxima)
      const epMap: Record<string, string> = {}
      for (const row of (lotesEp.data ?? []) as unknown as { validade_ep: string; lote: { insumo_id: string } }[]) {
        const insumoId = row.lote?.insumo_id
        if (insumoId && !epMap[insumoId]) epMap[insumoId] = row.validade_ep
      }

      const combined: Record<string, ValidadeInfo> = {}
      const allIds = new Set([...Object.keys(ecMap), ...Object.keys(epMap)])
      for (const id of allIds) {
        combined[id] = { insumo_id: id, validade_ec: ecMap[id] ?? null, validade_ep: epMap[id] ?? null }
      }
      setValidades(combined)

      const semEtiquetaSet = new Set(
        ((semEtiqueta.data ?? []) as { insumo_id: string }[]).map(l => l.insumo_id)
      )
      setInsumosSemEtiqueta(semEtiquetaSet)
      setLoading(false)
    })
  }, [profile])

  type InsumoMeta = { id: string; categoria_id: string; estoque_minimo_ec?: number; estoque_maximo_ec?: number; estoque_minimo_ep?: number; estoque_maximo_ep?: number }
  const [insumosMeta, setInsumosMeta] = useState<Record<string, InsumoMeta>>({})
  useEffect(() => {
    if (!profile) return
    supabase.from('insumos').select('id, categoria_id, estoque_minimo_ec, estoque_maximo_ec, estoque_minimo_ep, estoque_maximo_ep').eq('empresa_id', profile.empresa_id)
      .then(({ data }) => {
        const map: Record<string, InsumoMeta> = {}
        ;(data ?? []).forEach((i: InsumoMeta) => { map[i.id] = i })
        setInsumosMeta(map)
      })
  }, [profile])

  const catMap = useMemo(
    () => Object.fromEntries(categorias.map(c => [c.id, c])),
    [categorias],
  )

  /**
   * Cada linha já com a categoria, a validade e os alertas resolvidos.
   *
   * Antes essa conta acontecia duas vezes — uma no cartão do celular, outra na
   * linha da tabela — e as duas cópias podiam divergir. Resolver uma vez aqui
   * também é o que permite ao resumo contar e ao filtro filtrar.
   */
  const linhas = useMemo(
    () => estoque.map(e => {
      const meta = insumosMeta[e.insumo_id]
      const val = validades[e.insumo_id]
      const alertas: Alerta[] = []

      if ((meta?.estoque_minimo_ec != null && e.qtd_estoque_central < meta.estoque_minimo_ec)
          || e.alerta_reposicao) alertas.push('comprar')
      if (meta?.estoque_minimo_ep != null && e.qtd_estoque_produtivo < meta.estoque_minimo_ep)
        alertas.push('transferir')
      if (insumosSemEtiqueta.has(e.insumo_id)) alertas.push('etiquetar')
      if (venceEmBreve(val)) alertas.push('vencendo')

      return { e, val, categoria: catMap[meta?.categoria_id ?? ''], alertas }
    }),
    [estoque, insumosMeta, validades, insumosSemEtiqueta, catMap],
  )

  const filtered = useMemo(
    () => linhas.filter(l => {
      const meta = insumosMeta[l.e.insumo_id]
      if (!combina(search, l.e.insumo_nome)) return false
      if (filtroCategoria && meta?.categoria_id !== filtroCategoria) return false
      if (filtroAlerta && !l.alertas.includes(filtroAlerta)) return false
      return true
    }),
    [linhas, insumosMeta, search, filtroCategoria, filtroAlerta],
  )

  /** Quantos insumos em cada situação — a conta é sobre TUDO, não sobre o filtro. */
  /**
   * O peso do estoque, em quilos.
   *
   * NEM TUDO É QUILO. A baunilha é medida em ml, o desmoldante em unidade —
   * somar os três daria um número que não quer dizer nada. Aqui entra o que é
   * massa (kg, e g convertido), e o resto é listado à parte, na unidade dele.
   *
   * Sem essa separação, "1.676 kg" incluiria 21 mil ml de essência como se
   * fossem 21 toneladas.
   */
  const pesos = useMemo(() => {
    const emKg = (v: number, un: string) =>
      un === 'kg' ? v : un === 'g' ? v / 1000 : null

    let central = 0, producao = 0
    const outras = new Map<string, number>()

    for (const e of estoque) {
      const un = e.unidade_medida
      const c = emKg(Number(e.qtd_estoque_central ?? 0), un)
      const p = emKg(Number(e.qtd_estoque_produtivo ?? 0), un)
      if (c === null || p === null) {
        const t = Number(e.qtd_total ?? 0)
        if (t > 0) outras.set(un, (outras.get(un) ?? 0) + t)
        continue
      }
      central += c
      producao += p
    }
    return { central, producao, total: central + producao, outras: [...outras] }
  }, [estoque])

  const contagens = useMemo(() => {
    const c: Record<Alerta, number> = { comprar: 0, transferir: 0, etiquetar: 0, vencendo: 0 }
    for (const l of linhas) for (const a of l.alertas) c[a]++
    return c
  }, [linhas])

  const alternarAlerta = (a: Alerta) => setFiltroAlerta(atual => (atual === a ? null : a))

  const campoClasse =
    'rounded-controle border border-border bg-input px-4 py-2.5 text-sm text-foreground ' +
    'placeholder-muted-foreground/50 focus:outline-none focus:border-ring ' +
    'focus:ring-[3px] focus:ring-brand-400/25 transition-[border-color,box-shadow] duration-200'

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Estoque de insumos</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Posição atual de cada insumo, somando o estoque central e o que está nos baldes.
        </p>
      </div>

      {/* ── O peso do estoque ────────────────────────────────
          Vem antes dos alertas porque responde a pergunta mais simples de
          todas: quanto a fábrica tem. O total é o número grande; os dois
          lugares ficam ao lado, menores, porque explicam o total em vez de
          competir com ele. */}
      {!loading && (
        <div className="rounded-bloco border border-border bg-card shadow-tema px-4 py-3.5">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-[0.6rem] uppercase tracking-[1px] font-semibold text-muted-foreground">
                Total
              </p>
              <p className="font-display text-3xl font-bold tabular-nums leading-none text-foreground">
                {formatKg(pesos.total)}
              </p>
            </div>
            <div>
              <p className="text-[0.6rem] uppercase tracking-[1px] font-semibold text-muted-foreground">
                Estoque central
              </p>
              <p className="font-display text-xl font-bold tabular-nums leading-none text-foreground/80">
                {formatKg(pesos.central)}
              </p>
            </div>
            <div>
              <p className="text-[0.6rem] uppercase tracking-[1px] font-semibold text-muted-foreground">
                Na produção
              </p>
              <p className="font-display text-xl font-bold tabular-nums leading-none text-foreground/80">
                {formatKg(pesos.producao)}
              </p>
            </div>
          </div>

          {/* O que não é massa não entra na soma — e some se não for dito. */}
          {pesos.outras.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2.5 pt-2.5 border-t border-border">
              Fora da soma, por não serem peso:{' '}
              {pesos.outras.map(([un, v]) => `${formatQty(v, un as UnidadeMedida)}`).join(' · ')}
            </p>
          )}
        </div>
      )}

      {/* ── O resumo, que também é filtro ─────────────────────
          Fica antes da lista porque responde a pergunta que se faz de longe:
          o que pede providência hoje. */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {(['comprar', 'transferir', 'etiquetar', 'vencendo'] as Alerta[]).map(a => {
            const n = contagens[a]
            const ativo = filtroAlerta === a
            const vazio = n === 0
            return (
              <button
                key={a}
                onClick={() => !vazio && alternarAlerta(a)}
                disabled={vazio}
                aria-pressed={ativo}
                title={vazio ? `Nada em ${ROTULOS[a]}` : EXPLICACAO[a]}
                className={[
                  'rounded-bloco border px-4 py-3 text-left transition-all duration-200 ease-out-expo',
                  vazio
                    ? 'border-border bg-card/60 cursor-default'
                    : 'border-border bg-card shadow-tema [@media(hover:hover)]:hover:-translate-y-0.5 hover:shadow-tema-md',
                  ativo ? 'ring-2 ring-ring border-transparent' : '',
                ].join(' ')}
              >
                <p
                  className="text-2xl font-display font-bold tabular-nums leading-none"
                  style={{ color: vazio ? undefined : CORES_TARJA[a] }}
                >
                  <span className={vazio ? 'text-muted-foreground/40' : ''}>{n}</span>
                </p>
                <p className="text-[0.65rem] uppercase tracking-[1px] font-semibold text-muted-foreground mt-1.5">
                  {ROTULOS[a]}
                </p>
              </button>
            )
          })}
        </div>
      )}

      <div className="flex gap-2.5 flex-wrap">
        <input
          type="search"
          placeholder="Buscar insumo..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={`flex-1 min-w-48 ${campoClasse}`}
        />
        <select
          value={filtroCategoria}
          onChange={e => setFiltroCategoria(e.target.value)}
          className={campoClasse}
        >
          <option value="">Todas as categorias</option>
          {categorias.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </div>

      {/* O filtro do resumo é o único que não tem campo próprio na tela — sem
          esta linha, quem tocou num quadro e esqueceu não entende por que a
          lista está curta. */}
      {filtroAlerta && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Mostrando só o que precisa <strong className="text-foreground">{ROTULOS[filtroAlerta]}</strong>.</span>
          <button
            onClick={() => setFiltroAlerta(null)}
            className="text-brand-600 dark:text-brand-400 font-semibold hover:underline"
          >
            Ver todos
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <Card>
          <ListaResponsiva
            cartoes={
              filtered.length === 0
                ? <ListaVazia>Nenhum insumo encontrado.</ListaVazia>
                : filtered.map(({ e, val, categoria, alertas }) => (
                    <CartaoLista
                      key={e.insumo_id}
                      onClick={() => setInsumoSelecionado(e)}
                      alerta={alertas.length > 0}
                      titulo={
                        <>
                          {categoria?.cor_hex && (
                            <span className="w-2 h-2 mt-1.5 rounded-full shrink-0" style={{ backgroundColor: categoria.cor_hex }} />
                          )}
                          <span className="font-medium text-foreground">{e.insumo_nome}</span>
                        </>
                      }
                      subtitulo={`${e.insumo_codigo}${categoria?.nome ? ` · ${categoria.nome}` : ''}`}
                      // O total é o que se procura de relance; o resto é detalhe.
                      destaque={<span className="tabular-nums">{formatQty(e.qtd_total, e.unidade_medida)}</span>}
                      marcadores={
                        alertas.length > 0
                          ? <>{alertas.map(a => <Selo key={a} tipo={a} />)}</>
                          : undefined
                      }
                      campos={[
                        { rotulo: 'EC', valor: <span className="tabular-nums">{formatQty(e.qtd_estoque_central, e.unidade_medida)}</span> },
                        { rotulo: 'EP', valor: <span className="tabular-nums">{formatQty(e.qtd_estoque_produtivo, e.unidade_medida)}</span> },
                        {
                          rotulo: 'Val. EC',
                          valor: val?.validade_ec
                            ? <span className={`tabular-nums ${validadeClass(val.validade_ec)}`}>{formatDate(val.validade_ec)}</span>
                            : <span className="text-muted-foreground/40">—</span>,
                        },
                        {
                          rotulo: 'Val. EP',
                          valor: val?.validade_ep
                            ? <span className={`tabular-nums ${validadeClass(val.validade_ep)}`}>{formatDate(val.validade_ep)}</span>
                            : <span className="text-muted-foreground/40">—</span>,
                        },
                      ]}
                    />
                  ))
            }
            tabela={
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    {[
                      { r: 'Insumo' }, { r: 'Categoria' },
                      { r: 'EC', fim: true }, { r: 'Val. EC', meio: true },
                      { r: 'EP', fim: true }, { r: 'Val. EP', meio: true },
                      { r: 'Total', fim: true }, { r: 'Mínimo', fim: true },
                    ].map(c => (
                      <th
                        key={c.r}
                        className={[
                          'px-4 py-3 text-[0.65rem] font-semibold uppercase tracking-[1px] text-muted-foreground',
                          c.fim ? 'text-right' : c.meio ? 'text-center' : '',
                        ].join(' ')}
                      >
                        {c.r}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filtered.map(({ e, val, categoria, alertas }) => (
                    <tr
                      key={e.insumo_id}
                      onClick={() => setInsumoSelecionado(e)}
                      // A tarja fica em box-shadow, e não em border-left: borda
                      // muda a largura da célula e desalinha a coluna das linhas
                      // sem alerta.
                      style={alertas.length > 0
                        ? { boxShadow: `inset 3px 0 0 ${CORES_TARJA[alertas[0]]}` }
                        : undefined}
                      className="cursor-pointer transition-colors duration-150 hover:bg-accent"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          {categoria?.cor_hex && (
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: categoria.cor_hex }} />
                          )}
                          <span className="font-medium text-foreground">{e.insumo_nome}</span>
                          {alertas.map(a => <Selo key={a} tipo={a} />)}
                        </div>
                        <p className="text-xs text-muted-foreground/70 ml-4">{e.insumo_codigo}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{categoria?.nome ?? '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-foreground/80">
                        {formatQty(e.qtd_estoque_central, e.unidade_medida)}
                      </td>
                      <td className="px-4 py-3 text-center text-xs">
                        {val?.validade_ec
                          ? <span className={`tabular-nums ${validadeClass(val.validade_ec)}`}>{formatDate(val.validade_ec)}</span>
                          : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-foreground/80">
                        {formatQty(e.qtd_estoque_produtivo, e.unidade_medida)}
                      </td>
                      <td className="px-4 py-3 text-center text-xs">
                        {val?.validade_ep
                          ? <span className={`tabular-nums ${validadeClass(val.validade_ep)}`}>{formatDate(val.validade_ep)}</span>
                          : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                        {formatQty(e.qtd_total, e.unidade_medida)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground/60">
                        {e.estoque_minimo ? formatQty(e.estoque_minimo, e.unidade_medida) : '—'}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Nenhum insumo encontrado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            }
          />
        </Card>
      )}

      {/* A legenda desceu para o rodapé: ela se consulta uma vez, quando bate a
          dúvida sobre o que a cor quer dizer, e não a cada visita à tela. */}
      {!loading && (
        <div className="flex gap-4 text-xs text-muted-foreground flex-wrap px-1">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
            Vence em até {DIAS_ATENCAO} dias
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
            Vence em até 60 dias
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-amber-500 inline-block" />
            Tarja na lateral: a linha pede providência
          </span>
        </div>
      )}

      {insumoSelecionado && (
        <InsumoDetalhePanel
          insumo={insumoSelecionado}
          onClose={() => setInsumoSelecionado(null)}
        />
      )}
    </div>
  )
}

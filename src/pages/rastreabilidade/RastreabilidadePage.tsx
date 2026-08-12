import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { QRScanner } from '../../components/qr/QRScanner'
import { combina } from '../../lib/busca'

/**
 * A porta de entrada da rastreabilidade retrospectiva.
 *
 * A pergunta que esta tela existe para atender chega de fora e é sempre a
 * mesma: *"que insumo vocês usaram no produto com validade tal?"*. Por isso a
 * entrada principal é um calendário de VALIDADES — não de produção.
 *
 * Quem liga, porém, costuma estar com a caixa na mão. Então além do calendário
 * há busca por código de lote e leitura do QR da etiqueta, que caem no mesmo
 * lugar: o dossiê daquela validade e daquele produto.
 *
 * Um dia pode ter mais de um produto vencendo. Aí a tela pergunta qual —
 * produtos de clientes diferentes nunca podem sair no mesmo documento. O que
 * ela nunca pergunta é a SESSÃO: quando dois lotes da mesma validade vieram de
 * produções diferentes, não há como saber qual delas gerou a caixa que o
 * auditor tem na mão, e o dossiê traz as duas.
 */

const DIAS_CABECALHO = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

interface DiaValidade {
  validade: string
  produto_id: string
  produto_nome: string
  produto_codigo: string
  lotes: number
  unidades_produzidas: number
  unidades_disponiveis: number
  sessoes: number
}

// Data sempre como string YYYY-MM-DD montada componente a componente:
// `new Date('2026-08-03')` é meia-noite UTC e no Brasil cai no dia 2.
function paraISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function segundaDa(d: Date): Date {
  const c = new Date(d)
  const dow = c.getDay()
  c.setDate(c.getDate() + (dow === 0 ? -6 : 1 - dow))
  return c
}

function fmt(n: number) {
  return n.toLocaleString('pt-BR')
}

export function RastreabilidadePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const hoje = new Date()

  const [ano, setAno] = useState(hoje.getFullYear())
  const [mes, setMes] = useState(hoje.getMonth())
  const [linhas, setLinhas] = useState<DiaValidade[]>([])
  const [loading, setLoading] = useState(true)
  const [diaAberto, setDiaAberto] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const [lendoQR, setLendoQR] = useState(false)
  const [erroBusca, setErroBusca] = useState('')

  /** As semanas que cobrem o mês, sempre começando na segunda. */
  const semanas = useMemo(() => {
    const primeiro = new Date(ano, mes, 1)
    const ultimo = new Date(ano, mes + 1, 0)
    const dias: Date[][] = []
    let cursor = segundaDa(primeiro)
    while (cursor <= ultimo) {
      const semana: Date[] = []
      for (let i = 0; i < 7; i++) {
        semana.push(new Date(cursor))
        cursor.setDate(cursor.getDate() + 1)
      }
      dias.push(semana)
    }
    return dias
  }, [ano, mes])

  const carregar = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const primeiro = paraISO(new Date(ano, mes, 1))
    const ultimo = paraISO(new Date(ano, mes + 1, 0))
    const { data } = await supabase
      .from('v_calendario_validades')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .gte('validade', primeiro)
      .lte('validade', ultimo)
      .order('validade')
    setLinhas((data ?? []) as unknown as DiaValidade[])
    setLoading(false)
  }, [profile, ano, mes])

  useEffect(() => { carregar() }, [carregar])

  const porDia = useMemo(() => {
    const m = new Map<string, DiaValidade[]>()
    for (const l of linhas) {
      const lista = m.get(l.validade) ?? []
      lista.push(l)
      m.set(l.validade, lista)
    }
    return m
  }, [linhas])

  function abrir(iso: string, produtoId: string) {
    navigate(`/rastreabilidade/${iso}/${produtoId}`)
  }

  /** Um dia com um produto só vai direto; com vários, pergunta qual. */
  function clicarNoDia(iso: string) {
    const produtos = porDia.get(iso)
    if (!produtos || produtos.length === 0) return
    if (produtos.length === 1) return abrir(iso, produtos[0].produto_id)
    setDiaAberto(iso === diaAberto ? null : iso)
  }

  /** Do código do lote (ou do QR da etiqueta) direto para o dossiê dele. */
  const buscarLote = useCallback(async (texto: string) => {
    if (!profile) return
    setErroBusca('')
    const limpo = texto.trim().replace(/^QR-/i, '')
    if (!limpo) return
    const { data } = await supabase
      .from('lotes_produto')
      .select('codigo, qr_code, validade, produto_id')
      .eq('empresa_id', profile.empresa_id)
      .limit(50)

    const achado = ((data ?? []) as unknown as {
      codigo: string; qr_code: string | null; validade: string; produto_id: string
    }[]).find(l => combina(limpo, l.codigo, l.qr_code))

    if (!achado) {
      setErroBusca(`Nenhum lote de produto encontrado para "${texto}".`)
      return
    }
    setLendoQR(false)
    abrir(achado.validade, achado.produto_id)
  }, [profile])   // eslint-disable-line react-hooks/exhaustive-deps

  function mudarMes(delta: number) {
    const d = new Date(ano, mes + delta, 1)
    setAno(d.getFullYear())
    setMes(d.getMonth())
    setDiaAberto(null)
  }

  const isoHoje = paraISO(hoje)
  const produtosDoDia = diaAberto ? porDia.get(diaAberto) ?? [] : []

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Rastreabilidade</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          Escolha a validade do produto para ver tudo o que entrou nele.
        </p>
      </div>

      {/* ── Pelo código, para quem está com a caixa na mão ──── */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <input
            value={busca}
            onChange={e => setBusca(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') buscarLote(busca) }}
            placeholder="Código do lote do produto (LPROD-0001)"
            className="flex-1 min-w-[14rem] rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                       focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                       dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
          />
          <Button variant="secondary" onClick={() => buscarLote(busca)}>Buscar</Button>
          <Button variant="ghost" onClick={() => setLendoQR(true)}>Ler QR</Button>
        </CardBody>
        {erroBusca && (
          <CardBody className="pt-0">
            <p className="text-sm text-red-700">{erroBusca}</p>
          </CardBody>
        )}
      </Card>

      {lendoQR && (
        <QRScanner
          titulo="Etiqueta do produto"
          label="Aponte para o QR da caixa"
          onScan={v => buscarLote(v)}
          onError={m => setErroBusca(m)}
          acaoConcluir={{ rotulo: 'Cancelar', onClick: () => setLendoQR(false) }}
        />
      )}

      {/* ── O calendário de validades ───────────────────────── */}
      <Card>
        <CardHeader
          title={`${MESES[mes]} de ${ano}`}
          subtitle="Dias com produto vencendo"
          action={
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => mudarMes(-1)}>‹</Button>
              <Button variant="ghost" size="sm" onClick={() => { setAno(hoje.getFullYear()); setMes(hoje.getMonth()) }}>
                Hoje
              </Button>
              <Button variant="ghost" size="sm" onClick={() => mudarMes(1)}>›</Button>
            </div>
          }
        />
        <CardBody>
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-7 gap-1 mb-1">
                {DIAS_CABECALHO.map(d => (
                  <div key={d} className="text-[11px] uppercase tracking-wide text-gray-400 text-center py-1">
                    {d}
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                {semanas.map((semana, i) => (
                  <div key={i} className="grid grid-cols-7 gap-1">
                    {semana.map(d => {
                      const iso = paraISO(d)
                      const doMes = d.getMonth() === mes
                      const itens = porDia.get(iso) ?? []
                      const unidades = itens.reduce((t, x) => t + x.unidades_produzidas, 0)
                      const temCoisa = itens.length > 0
                      return (
                        <button
                          key={iso}
                          onClick={() => clicarNoDia(iso)}
                          disabled={!temCoisa}
                          className={[
                            'min-h-[4.5rem] rounded-lg border p-1.5 text-left transition-colors',
                            !doMes ? 'opacity-40' : '',
                            temCoisa
                              ? 'border-brand-500/30 bg-brand-500/5 hover:bg-brand-500/10 cursor-pointer'
                              : 'border-gray-100 dark:border-white/[.05] cursor-default',
                            diaAberto === iso ? 'ring-2 ring-brand-500' : '',
                          ].join(' ')}
                        >
                          <span className={[
                            'text-xs',
                            iso === isoHoje
                              ? 'font-bold text-brand-700'
                              : 'text-gray-500 dark:text-unno-muted',
                          ].join(' ')}>
                            {d.getDate()}
                          </span>
                          {temCoisa && (
                            <span className="block mt-0.5 text-[11px] leading-tight text-gray-700 dark:text-unno-text">
                              <strong>{fmt(unidades)}</strong> un
                              <span className="block text-gray-500 dark:text-unno-muted truncate">
                                {itens.length === 1 ? itens[0].produto_nome : `${itens.length} produtos`}
                              </span>
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>

              {linhas.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-unno-muted text-center py-6">
                  Nenhum produto vence neste mês.
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* ── Vários produtos no mesmo dia: qual deles? ───────── */}
      {produtosDoDia.length > 1 && (
        <Card>
          <CardHeader
            title="Qual produto?"
            subtitle="Mais de um produto vence neste dia — cada um tem o seu dossiê"
          />
          <CardBody className="p-0">
            <div className="divide-y divide-gray-100 dark:divide-white/[.04]">
              {produtosDoDia.map(p => (
                <div key={p.produto_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                      <span className="text-gray-400 mr-1.5 font-mono">{p.produto_codigo}</span>
                      {p.produto_nome}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">
                      {fmt(p.unidades_produzidas)} unidades ·{' '}
                      {p.lotes === 1 ? '1 lote' : `${p.lotes} lotes`} ·{' '}
                      {p.sessoes === 1 ? '1 produção' : `${p.sessoes} produções`}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => abrir(p.validade, p.produto_id)}>
                    Abrir dossiê
                  </Button>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

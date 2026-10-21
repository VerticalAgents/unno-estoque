import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { formatQty, ordemNatural } from '../../lib/utils'
import { parseLoteDoInsumo } from '../../lib/qr'
import type { UnidadeMedida } from '../../types/database.types'
import { DicaMaisAntiga } from './AbastecimentoUnidades'

/**
 * Reabastecer os baldes, SEM BALANÇA (migration 145).
 *
 * Até a 145 o balde era pesado antes e depois de encher, e o sistema tentava
 * saber quantos kg havia em cada um descontando o consumo teórico numa fila
 * que a equipe não segue. O número vivia errado e a pesagem não servia para
 * nada que importasse.
 *
 * O balde agora serve à RASTREABILIDADE: que lotes estão dentro dele. Decisão
 * do Lucca (21/10/2026):
 *
 *   1. escolher o insumo;
 *   2. marcar os baldes que encheu e dizer se cada um ESTAVA VAZIO — é o
 *      "estava vazio" que tira os lotes velhos do balde;
 *   3. bipar os fardos e dizer QUANTO VOLTOU para o estoque do que não foi
 *      inteiro (pegou 10 kg, voltou 3 kg).
 *
 * No fim do dia todo balde está cheio: é isso que o sistema assume.
 *
 * Os outros modos de armazenamento (pacote do fornecedor, porcionado, óleo e
 * ovo) continuam em "Levar embalagem original", em /transferencia/scan.
 */

type Passo = 'insumo' | 'baldes' | 'lotes' | 'sucesso'

type Balde = { local_id: string; nome: string; lotes: number }

type InsumoAlvo = {
  insumo_id: string
  codigo: string
  nome: string
  unidade: UnidadeMedida
  baldes: Balde[]
  /** O que está disponível no estoque central, para orientar quem vai buscar. */
  lotes_ec: number
  saldo_ec: number
}

type LoteBipado = { id: string; codigo: string; saldo: number; unidade: UnidadeMedida }

export function AbastecimentoPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [passo, setPasso] = useState<Passo>('insumo')
  const [carregando, setCarregando] = useState(true)
  // Muda quando a lista precisa ser relida, depois de reabastecer.
  const [recarga, setRecarga] = useState(0)
  const [insumos, setInsumos] = useState<InsumoAlvo[]>([])
  const [alvo, setAlvo] = useState<InsumoAlvo | null>(null)

  /** Por balde enchido: estava vazio? `undefined` = ainda não respondeu. */
  const [enchidos, setEnchidos] = useState<Record<string, boolean | undefined>>({})

  const [lotes, setLotes] = useState<LoteBipado[]>([])
  /** Quanto voltou de cada fardo, como texto — "3," não pode virar 3 no meio da digitação. */
  const [voltou, setVoltou] = useState<Record<string, string>>({})
  const [erroScan, setErroScan] = useState('')

  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [confirmar, setConfirmar] = useState(false)
  const [sucesso, setSucesso] = useState<{ levou: number; baldes: number; esvaziados: number } | null>(null)

  // ── Passo 1: o que existe para reabastecer ────────────────

  useEffect(() => {
    if (!profile) return
    let vivo = true

    async function carregar() {
      const empresa = profile!.empresa_id

      const [comp, locs, cfg, lotesEc, conteudo] = await Promise.all([
        supabase
          .from('v_recipientes_composicao')
          .select('local_id, local_nome, insumo_id, insumo_codigo, insumo_nome, unidade_medida')
          .eq('empresa_id', empresa),
        // A view não traz `efemero`: sem ele a lista mostraria as embalagens do
        // fornecedor que viraram ponto de consumo (migration 073).
        supabase
          .from('locais')
          .select('id, efemero')
          .eq('empresa_id', empresa)
          .eq('tipo', 'estoque_produtivo')
          .eq('ativo', true),
        supabase.from('insumos_armazenamento_config').select('insumo_id, modo_ep'),
        supabase
          .from('lotes')
          .select('id, insumo_id, quantidade_disponivel')
          .eq('empresa_id', empresa)
          .eq('status', 'ativo')
          .gt('quantidade_disponivel', 0),
        supabase.from('locais_lotes').select('local_id'),
      ])

      if (!vivo) return

      const efemero = new Map(
        ((locs.data ?? []) as { id: string; efemero: boolean }[]).map(l => [l.id, l.efemero]),
      )
      // Sem linha de config o insumo é de recipiente (`modo_ep ?? 'recipiente'`).
      const modos = new Map(
        ((cfg.data ?? []) as { insumo_id: string; modo_ep: string | null }[])
          .map(c => [c.insumo_id, c.modo_ep ?? 'recipiente']),
      )
      const lotesNoBalde = new Map<string, number>()
      for (const l of (conteudo.data ?? []) as { local_id: string }[]) {
        lotesNoBalde.set(l.local_id, (lotesNoBalde.get(l.local_id) ?? 0) + 1)
      }

      const porInsumo = new Map<string, InsumoAlvo>()
      for (const linha of (comp.data ?? []) as unknown as {
        local_id: string; local_nome: string
        insumo_id: string; insumo_codigo: string; insumo_nome: string; unidade_medida: UnidadeMedida
      }[]) {
        if (!efemero.has(linha.local_id) || efemero.get(linha.local_id)) continue
        if ((modos.get(linha.insumo_id) ?? 'recipiente') !== 'recipiente') continue

        let ins = porInsumo.get(linha.insumo_id)
        if (!ins) {
          ins = {
            insumo_id: linha.insumo_id, codigo: linha.insumo_codigo, nome: linha.insumo_nome,
            unidade: linha.unidade_medida, baldes: [], lotes_ec: 0, saldo_ec: 0,
          }
          porInsumo.set(linha.insumo_id, ins)
        }
        ins.baldes.push({
          local_id: linha.local_id, nome: linha.local_nome,
          lotes: lotesNoBalde.get(linha.local_id) ?? 0,
        })
      }

      for (const l of (lotesEc.data ?? []) as unknown as {
        insumo_id: string; quantidade_disponivel: number
      }[]) {
        const ins = porInsumo.get(l.insumo_id)
        if (!ins) continue
        ins.lotes_ec += 1
        ins.saldo_ec += Number(l.quantidade_disponivel ?? 0)
      }

      for (const ins of porInsumo.values()) ins.baldes.sort((x, y) => ordemNatural(x.nome, y.nome))
      setInsumos([...porInsumo.values()].sort((x, y) => ordemNatural(x.codigo, y.codigo)))
      setCarregando(false)
    }

    carregar()
    return () => { vivo = false }
  }, [profile?.empresa_id, recarga])

  // ── Passo 2: os baldes ────────────────────────────────────

  const marcados = alvo ? alvo.baldes.filter(bd => bd.local_id in enchidos) : []
  const faltaResponder = marcados.filter(bd => enchidos[bd.local_id] === undefined)
  const podeIrAosFardos = marcados.length > 0 && faltaResponder.length === 0

  function alternarBalde(id: string) {
    setEnchidos(prev => {
      const novo = { ...prev }
      if (id in novo) delete novo[id]
      else novo[id] = undefined
      return novo
    })
  }

  // ── Passo 3: os fardos ────────────────────────────────────

  /**
   * Aceita o fardo lido, qualquer que seja: a trava FEFO saiu (142) e a de
   * capacidade não faz sentido aqui — os baldes já foram enchidos.
   */
  async function bipar(qr: string) {
    setErroScan('')
    if (!alvo || !profile) return

    const { data: loteData } = await supabase
      .from('lotes')
      .select('id, codigo, insumo_id, unidade, quantidade_disponivel, status')
      .eq('codigo', parseLoteDoInsumo(qr, alvo.codigo))
      .maybeSingle()

    const lote = loteData as {
      id: string; codigo: string; insumo_id: string; unidade: UnidadeMedida
      quantidade_disponivel: number; status: string
    } | null

    if (!lote) { setErroScan(`QR não reconhecido: ${qr}`); return }
    if (lote.insumo_id !== alvo.insumo_id) {
      setErroScan(`${lote.codigo} é de outro insumo. Esta operação é de ${alvo.nome}.`)
      return
    }
    if (lote.status !== 'ativo' || lote.quantidade_disponivel <= 0) {
      setErroScan(`${lote.codigo} não está disponível no estoque central (${lote.status}).`)
      return
    }
    if (lotes.some(l => l.id === lote.id)) { setErroScan('Este fardo já foi bipado.'); return }

    const { data } = await supabase.rpc('validar_scan_lote', {
      p_empresa_id: profile.empresa_id, p_lote_id: lote.id,
      p_ja_escaneados: lotes.map(l => l.id), p_justificativa: null,
    })
    const resp = data as { erro?: string; trava?: string } | null
    // Erro de coerência (outro insumo, outra marca) vale; a trava de capacidade não.
    if (resp?.erro && !resp?.trava) { setErroScan(resp.erro); return }

    setLotes(prev => [...prev, {
      id: lote.id, codigo: lote.codigo, saldo: Number(lote.quantidade_disponivel), unidade: lote.unidade,
    }])
  }

  /** Quanto voltou, ou o motivo de o número não servir. Em branco = voltou nada. */
  function voltouDe(l: LoteBipado): { ok: true; valor: number } | { ok: false; msg: string } {
    const txt = (voltou[l.id] ?? '').replace(',', '.').trim()
    if (txt === '') return { ok: true, valor: 0 }
    const n = parseFloat(txt)
    if (isNaN(n) || n < 0) return { ok: false, msg: 'Número inválido.' }
    if (n >= l.saldo) return { ok: false, msg: `Ele só tinha ${formatQty(l.saldo, l.unidade)}: se voltou tudo, tire da lista.` }
    return { ok: true, valor: n }
  }

  const levou = lotes.reduce((s, l) => {
    const v = voltouDe(l)
    return s + (v.ok ? l.saldo - v.valor : 0)
  }, 0)
  const podeRegistrar = lotes.length > 0 && lotes.every(l => voltouDe(l).ok)

  async function registrar() {
    if (!alvo || !profile) return
    setSalvando(true)
    setErro('')

    const { data, error } = await supabase.rpc('registrar_reabastecimento_sem_peso', {
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_insumo_id:      alvo.insumo_id,
      p_baldes: marcados.map(bd => ({ local_id: bd.local_id, estava_vazio: !!enchidos[bd.local_id] })),
      p_lotes:  lotes.map(l => {
        const v = voltouDe(l)
        return { lote_id: l.id, voltou: v.ok ? v.valor : 0 }
      }),
    })

    setSalvando(false)
    setConfirmar(false)

    const resp = data as { ok: boolean; erro?: string; levou?: number; baldes?: number; esvaziados?: number } | null
    if (error || !resp?.ok) {
      setErro(resp?.erro ?? error?.message ?? 'Não foi possível registrar o reabastecimento.')
      return
    }
    setSucesso({ levou: Number(resp.levou ?? 0), baldes: Number(resp.baldes ?? 0), esvaziados: Number(resp.esvaziados ?? 0) })
    setPasso('sucesso')
  }

  function limpar() {
    setEnchidos({}); setLotes([]); setVoltou({})
    setErro(''); setErroScan('')
  }

  function recomecar() {
    setPasso('insumo')
    setAlvo(null)
    limpar()
    setSucesso(null)
    setCarregando(true)
    setInsumos([])
    setRecarga(n => n + 1)
  }

  // ── Render ────────────────────────────────────────────────

  const PASSOS: Passo[] = ['insumo', 'baldes', 'lotes']
  const indice = PASSOS.indexOf(passo)

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        {passo === 'insumo' && (
          <button
            onClick={() => navigate('/transferencia')}
            className="text-sm text-brand-600 dark:text-brand-400 hover:underline mb-2"
          >
            ← Transferência
          </button>
        )}
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Reabastecer recipientes</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          Encha os baldes e bipe os fardos que usou. Sem pesar.
        </p>
      </div>

      {passo !== 'sucesso' && (
        <div className="flex gap-1.5 mb-6">
          {PASSOS.map((s, i) => (
            <div
              key={s}
              className={`h-1.5 rounded-full flex-1 transition-colors ${
                indice > i ? 'bg-brand-600' : indice === i ? 'bg-brand-300' : 'bg-gray-200 dark:bg-white/10'
              }`}
            />
          ))}
        </div>
      )}

      {/* ── Passo 1: escolher o insumo ── */}
      {passo === 'insumo' && (
        <div className="space-y-4">
          {carregando && <p className="text-sm text-gray-500">Carregando os baldes…</p>}

          {!carregando && insumos.length === 0 && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-gray-900 dark:text-unno-text">
                Nenhum insumo com balde na produção
              </p>
              <p className="text-xs text-gray-600 dark:text-unno-muted mt-1">
                Cadastre os potes e baldes antes de reabastecer.
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate('/recipientes')}>
                Cadastrar recipiente
              </Button>
            </Card>
          )}

          {insumos.map(ins => (
            <Card
              key={ins.insumo_id}
              className="p-4"
              onClick={() => { setAlvo(ins); limpar(); setPasso('baldes') }}
            >
              <div className="flex justify-between items-start gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-unno-text truncate">{ins.nome}</p>
                  <p className="text-xs text-gray-500 dark:text-unno-muted">
                    {ins.baldes.length} balde{ins.baldes.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
              {ins.lotes_ec === 0 ? (
                <p className="text-xs text-amber-700 mt-2">Sem fardo no estoque central para este insumo.</p>
              ) : (
                <p className="text-xs text-gray-500 dark:text-unno-muted mt-2">
                  No estoque central: {formatQty(ins.saldo_ec, ins.unidade)} em {ins.lotes_ec}{' '}
                  fardo{ins.lotes_ec === 1 ? '' : 's'}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* ── Passo 2: os baldes que encheu ── */}
      {passo === 'baldes' && alvo && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">REABASTECENDO</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">{alvo.nome}</p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Toque nos baldes que você encheu e diga se cada um estava vazio antes. Os que você
              não mexeu ficam como estão.
            </p>
          </Card>

          {alvo.baldes.map(bd => {
            const marcado = bd.local_id in enchidos
            const resposta = enchidos[bd.local_id]
            return (
              <Card key={bd.local_id} className={`p-4 ${marcado ? 'ring-2 ring-brand-500' : ''}`}>
                <button
                  type="button"
                  onClick={() => alternarBalde(bd.local_id)}
                  className="w-full flex justify-between items-center gap-3 text-left"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-gray-900 dark:text-unno-text">{bd.nome}</span>
                    <span className="block text-xs text-gray-500 dark:text-unno-muted">
                      {bd.lotes === 0 ? 'nenhum lote registrado' : `${bd.lotes} lote${bd.lotes === 1 ? '' : 's'} registrado${bd.lotes === 1 ? '' : 's'} dentro`}
                    </span>
                  </span>
                  <span className={`text-xs font-semibold shrink-0 ${marcado ? 'text-brand-700 dark:text-brand-400' : 'text-gray-400'}`}>
                    {marcado ? '✓ Enchi este' : 'Toque se encheu'}
                  </span>
                </button>

                {marcado && (
                  <div className="mt-3">
                    <p className="text-sm text-gray-700 dark:text-unno-text mb-2">Estava vazio antes de encher?</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button" size="lg"
                        variant={resposta === true ? 'primary' : 'secondary'}
                        onClick={() => setEnchidos(prev => ({ ...prev, [bd.local_id]: true }))}
                      >
                        Sim, vazio
                      </Button>
                      <Button
                        type="button" size="lg"
                        variant={resposta === false ? 'primary' : 'secondary'}
                        onClick={() => setEnchidos(prev => ({ ...prev, [bd.local_id]: false }))}
                      >
                        Não, tinha sobra
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}

          {faltaResponder.length > 0 && (
            <p className="text-sm text-amber-700">
              Falta dizer se estava vazio: {faltaResponder.map(bd => bd.nome).join(', ')}.
            </p>
          )}

          <Button size="xl" fullWidth disabled={!podeIrAosFardos} onClick={() => setPasso('lotes')}>
            Continuar → bipar os fardos
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => { setAlvo(null); setPasso('insumo') }}>
            ← Escolher outro insumo
          </Button>
        </div>
      )}

      {/* ── Passo 3: os fardos e o que voltou ── */}
      {passo === 'lotes' && alvo && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">FARDOS DE {alvo.nome.toUpperCase()}</p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Bipe todos os fardos que você usou. Se um não foi inteiro, diga quanto voltou para o
              estoque.
            </p>
            <DicaMaisAntiga />
          </Card>

          <Card className="p-5">
            <QRScanner
              onScan={qr => bipar(qr)}
              continuo
              titulo={alvo.nome}
              label={`${lotes.length} bipado${lotes.length === 1 ? '' : 's'}`}
              dicaDigitar={{
                texto: `Só a tarja preta da etiqueta — o insumo já é ${alvo.nome}. O espaço vira ponto e depois barra; os zeros da frente não precisam.`,
                exemplo: '5.2/2',
                tarja: true,
              }}
              acaoConcluir={{ rotulo: 'Terminei de bipar', onClick: () => setErroScan('') }}
              painel={
                <div className="text-xs">
                  {erroScan && <p className="font-semibold text-red-700 mb-2">{erroScan}</p>}
                  <div className="space-y-1">
                    {lotes.map(l => (
                      <div key={l.id} className="flex justify-between gap-2">
                        <span className="font-mono text-emerald-700 font-semibold truncate">✓ {l.codigo}</span>
                        <span className="text-gray-500 shrink-0">{formatQty(l.saldo, l.unidade)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              }
            />
            {erroScan && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{erroScan}</div>
            )}
          </Card>

          {lotes.map(l => {
            const v = voltouDe(l)
            return (
              <Card key={l.id} className="p-4">
                <div className="flex justify-between items-center gap-2">
                  <span className="font-mono text-sm text-gray-800 dark:text-unno-text truncate">{l.codigo}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-gray-500">tinha {formatQty(l.saldo, l.unidade)}</span>
                    <button
                      type="button"
                      onClick={() => setLotes(prev => prev.filter(x => x.id !== l.id))}
                      className="text-xs text-red-600 hover:underline"
                    >
                      tirar
                    </button>
                  </div>
                </div>
                <div className="mt-3">
                  <Input
                    label={`Voltou quanto para o estoque? (${l.unidade}) — em branco = usou inteiro`}
                    inputMode="decimal"
                    value={voltou[l.id] ?? ''}
                    onChange={e => setVoltou(prev => ({ ...prev, [l.id]: e.target.value }))}
                    placeholder="0"
                  />
                  {!v.ok && <p className="text-xs text-red-700 mt-1">{v.msg}</p>}
                </div>
              </Card>
            )
          })}

          {lotes.length > 0 && (
            <p className="text-sm text-gray-700 dark:text-unno-text">
              Vai para {marcados.length} balde{marcados.length === 1 ? '' : 's'}:{' '}
              <strong>{formatQty(levou, alvo.unidade)}</strong>
            </p>
          )}

          {erro && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{erro}</div>
          )}

          <Button size="xl" fullWidth disabled={!podeRegistrar} loading={salvando} onClick={() => setConfirmar(true)}>
            REGISTRAR REABASTECIMENTO
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => setPasso('baldes')}>
            ← Voltar aos baldes
          </Button>
        </div>
      )}

      {/* ── Sucesso ── */}
      {passo === 'sucesso' && sucesso && alvo && (
        <Card className="p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-unno-text mb-1">Reabastecimento registrado</h2>
          <p className="text-sm text-gray-500 dark:text-unno-muted mb-6">
            {formatQty(sucesso.levou, alvo.unidade)} de {alvo.nome} em {sucesso.baldes} balde
            {sucesso.baldes === 1 ? '' : 's'}
            {sucesso.esvaziados > 0 && ` (${sucesso.esvaziados} estava${sucesso.esvaziados === 1 ? '' : 'm'} vazio${sucesso.esvaziados === 1 ? '' : 's'})`}.
          </p>
          <Button size="xl" fullWidth onClick={recomecar}>Reabastecer outro insumo</Button>
        </Card>
      )}

      <ConfirmModal
        open={confirmar}
        title="Registrar reabastecimento?"
        description="Os fardos ficam com o que voltou, e os lotes passam a constar nos baldes marcados."
        confirmLabel="REGISTRAR"
        loading={salvando}
        summary={alvo ? (
          <div className="space-y-1">
            <p><strong>{alvo.nome}</strong> · {formatQty(levou, alvo.unidade)}</p>
            {marcados.map(bd => (
              <p key={bd.local_id}>{bd.nome}{enchidos[bd.local_id] ? ' · estava vazio' : ''}</p>
            ))}
            <p>{lotes.length} fardo{lotes.length === 1 ? '' : 's'}</p>
          </div>
        ) : undefined}
        onConfirm={registrar}
        onCancel={() => setConfirmar(false)}
      />
    </div>
  )
}

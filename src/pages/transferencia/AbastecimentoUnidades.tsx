import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { parseLoteDoInsumo, parseQRLoteCodigo } from '../../lib/qr'

/**
 * Reabastecer por unidade: óleo em garrafa, ovo em pó em pacote (migration 126).
 *
 * O QR fica na caixa (ou no saco), e garrafas e pacotes vão soltos para a
 * produção. Ninguém pesa — tratar isso como pote de açúcar, com tara e duas
 * pesagens, era conta à toa (Lucca, 28/09/2026).
 *
 * Três perguntas, na ordem da vida real:
 *
 *   1. quantas FECHADAS ainda estavam na produção — o "pesar o antes" daqui.
 *      A aberta não conta: o sistema fica no máximo uma unidade abaixo do
 *      real, e o erro não acumula (na contagem seguinte ela já foi usada);
 *   2. de quais caixas saiu, e quantas de cada;
 *   3. conferir e confirmar.
 */

export type InsumoPorUnidade = {
  insumo_id: string
  nome: string
  /** O que o sistema tem na produção, na unidade do insumo (kg). */
  tem: number
  /** Peso de uma garrafa/pacote, na unidade do insumo. */
  peso: number
  /** "garrafa", "pacote" — `insumos_embalagem_config.subunidade_tipo`. */
  tipo: string
  /** INS006 — para completar o código digitado só com a tarja preta. */
  codigo?: string
}

type Caixa = { id: string; codigo: string; tem: number; unidades: string }

type Passo = 'contar' | 'caixas' | 'confirmar' | 'ok'

const plural = (tipo: string, n: number) => (n === 1 ? tipo : `${tipo}s`)
const Maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** − [ n ] + — fora do componente para o campo não perder o foco a cada tecla. */
function Contador({ valor, onChange }: { valor: string; onChange: (v: string) => void }) {
  const n = /^\d+$/.test(valor.trim()) ? parseInt(valor, 10) : 0
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="lg" onClick={() => onChange(String(Math.max(0, n - 1)))}
              aria-label="menos um">−</Button>
      <input
        type="number" inputMode="numeric" min={0}
        value={valor}
        onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
        className="w-24 text-center text-2xl font-bold tabular-nums rounded-controle border border-gray-300
                   bg-white dark:bg-white/5 dark:border-white/10 py-2 focus:outline-none focus:border-brand-500"
      />
      <Button variant="secondary" size="lg" onClick={() => onChange(String(n + 1))}
              aria-label="mais um">+</Button>
    </div>
  )
}

export function AbastecimentoUnidades({ insumo, onVoltar, onConcluido }: {
  insumo: InsumoPorUnidade
  onVoltar: () => void
  onConcluido: () => void
}) {
  const { profile } = useAuth()
  const { tipo } = insumo
  // "garrafa" é feminino, "pacote" masculino — e a caixa/saco de onde saem
  // também. "Quantas pacotes" na tela é o tipo de coisa que tira a confiança.
  const fem = tipo.endsWith('a')
  const g = (f: string, m: string) => (fem ? f : m)
  const emb = tipo === 'pacote' ? 'saco' : 'caixa'
  const dEmb = emb === 'saco' ? 'deste' : 'desta'
  const g2 = (m: string, f: string) => (emb === 'saco' ? m : f)
  const esperado = Math.floor(insumo.tem / insumo.peso + 0.0001)

  const [passo, setPasso] = useState<Passo>('contar')
  const [tinha, setTinha] = useState('')
  const [caixas, setCaixas] = useState<Caixa[]>([])
  /**
   * A caixa aberta que a trava FEFO vai cobrar primeiro — mesma ordem de
   * `validar_scan_lote`. Dita antes da leitura, e não só depois do erro.
   */
  const [aberta, setAberta] = useState<{ id: string; codigo: string; tem: number } | null>(null)
  useEffect(() => {
    let vivo = true
    supabase.from('lotes')
      .select('id, codigo, quantidade_disponivel, quantidade_recebida, validade_pos_abertura')
      .eq('insumo_id', insumo.insumo_id).eq('status', 'ativo').gt('quantidade_disponivel', 0)
      .then(({ data }) => {
        if (!vivo) return
        const a = ((data ?? []) as {
          id: string; codigo: string; quantidade_disponivel: number; quantidade_recebida: number
          validade_pos_abertura: string | null
        }[])
          .filter(l => Number(l.quantidade_disponivel) < Number(l.quantidade_recebida))
          .sort((x, y) => (x.validade_pos_abertura ?? '9999-12-31').localeCompare(y.validade_pos_abertura ?? '9999-12-31')
                       || x.codigo.localeCompare(y.codigo))[0]
        setAberta(a ? {
          id: a.id, codigo: a.codigo,
          tem: Math.floor(Number(a.quantidade_disponivel) / insumo.peso + 0.0001),
        } : null)
      })
    return () => { vivo = false }
  }, [insumo.insumo_id, insumo.peso])
  const bipePrimeiro = aberta && !caixas.some(c => c.id === aberta.id) && caixas.length === 0 ? aberta : null
  const [erroScan, setErroScan] = useState('')
  const [travaFefo, setTravaFefo] = useState<{ qr: string; bloqueia: boolean; mensagem: string } | null>(null)
  const [justFefo, setJustFefo] = useState('')
  const [lendo, setLendo] = useState(false)
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [resultado, setResultado] = useState<{ tinha: number; levou: number; total: number } | null>(null)

  const nTinha = /^\d+$/.test(tinha.trim()) ? parseInt(tinha, 10) : null
  const unidadesDe = (c: Caixa) => (/^\d+$/.test(c.unidades.trim()) ? parseInt(c.unidades, 10) : null)
  const levou = caixas.reduce((s, c) => s + (unidadesDe(c) ?? 0), 0)
  const caixaComErro = (c: Caixa): string | null => {
    const n = unidadesDe(c)
    if (n === null || n <= 0) return `${g('Quantas', 'Quantos')} ${plural(tipo, 2)} saíram ${dEmb}?`
    if (n > c.tem) return `${emb === 'saco' ? 'Este' : 'Esta'} só tem ${c.tem} ${plural(tipo, c.tem)}.`
    return null
  }
  const podeConferir = caixas.every(c => caixaComErro(c) === null)

  async function bipar(qr: string, justificativa?: string) {
    setErroScan('')
    if (!profile) return

    const { data: loteData } = await supabase
      .from('lotes')
      .select('id, codigo, insumo_id, quantidade_disponivel, status')
      .eq('codigo', insumo.codigo ? parseLoteDoInsumo(qr, insumo.codigo) : parseQRLoteCodigo(qr))
      .maybeSingle()
    const lote = loteData as {
      id: string; codigo: string; insumo_id: string; quantidade_disponivel: number; status: string
    } | null

    if (!lote) { setErroScan(`QR não reconhecido: ${qr}`); return }
    if (lote.insumo_id !== insumo.insumo_id) {
      setErroScan(`${lote.codigo} é de outro insumo. Esta operação é de ${insumo.nome}.`)
      return
    }
    if (lote.status !== 'ativo' || lote.quantidade_disponivel <= 0) {
      setErroScan(`${lote.codigo} não está disponível no estoque central (${lote.status}).`)
      return
    }
    if (caixas.some(c => c.id === lote.id)) { setErroScan(emb === 'saco' ? 'Este saco já foi bipado.' : 'Esta caixa já foi bipada.'); return }

    // A mesma trava FEFO do reabastecimento de pote: a caixa aberta sai antes.
    const { data } = await supabase.rpc('validar_scan_lote', {
      p_empresa_id:    profile.empresa_id,
      p_lote_id:       lote.id,
      p_ja_escaneados: caixas.map(c => c.id),
      p_justificativa: justificativa?.trim() || null,
    })
    const resp = data as { erro?: string; trava?: string; modo?: string; mensagem?: string } | null
    if (resp?.trava === 'fefo') {
      setTravaFefo({ qr, bloqueia: resp.modo !== 'avisa', mensagem: resp.mensagem ?? '' })
      setLendo(false)
      return
    }
    if (resp?.erro && !resp?.trava) { setErroScan(resp.erro); return }

    setTravaFefo(null)
    setJustFefo('')
    setCaixas(prev => [...prev, {
      id: lote.id,
      codigo: lote.codigo,
      tem: Math.floor(Number(lote.quantidade_disponivel) / insumo.peso + 0.0001),
      unidades: '',
    }])
  }

  async function confirmar() {
    if (!profile || nTinha === null) return
    setSalvando(true)
    setErro('')
    const { data, error } = await supabase.rpc('registrar_abastecimento_unidades', {
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_insumo_id:      insumo.insumo_id,
      p_tinha:          nTinha,
      p_itens:          caixas.map(c => ({ lote_id: c.id, unidades: unidadesDe(c) })),
      p_justificativa:  null,
    })
    setSalvando(false)
    const resp = data as { ok: boolean; erro?: string; tinha?: number; levou?: number; total?: number } | null
    if (error || !resp?.ok) {
      setErro(resp?.erro ?? error?.message ?? 'Não foi possível registrar.')
      return
    }
    setResultado({ tinha: resp.tinha ?? 0, levou: resp.levou ?? 0, total: resp.total ?? 0 })
    setPasso('ok')
  }

  const PASSOS: Passo[] = ['contar', 'caixas', 'confirmar']
  const indice = PASSOS.indexOf(passo)

  return (
    <div className="space-y-4">
      {passo !== 'ok' && (
        <div className="flex gap-1.5">
          {PASSOS.map((s, i) => (
            <div key={s} className={`h-1.5 rounded-full flex-1 transition-colors ${
              indice > i ? 'bg-brand-600' : indice === i ? 'bg-brand-300' : 'bg-gray-200 dark:bg-white/10'
            }`} />
          ))}
        </div>
      )}

      {/* ── 1. O que ainda estava lá ── */}
      {passo === 'contar' && (
        <>
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">ABASTECENDO</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">{insumo.nome}</p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Sem balança: aqui se conta {plural(tipo, 2)}.
            </p>
          </Card>

          <Card className="p-5">
            <p className="font-semibold text-gray-900 dark:text-unno-text">
              {g('Quantas', 'Quantos')} {plural(tipo, 2)}{' '}
              <span className="underline">{g('fechadas', 'fechados')}</span> ainda estavam na produção?
            </p>

            {/* A regra que faz a conta fechar. Precisa estar à vista, não
                escondida numa dica: é o erro que o dedo comete. */}
            <div className="mt-3 p-3 rounded-controle bg-amber-50 border border-amber-300 text-sm text-amber-900">
              <strong>Conte só {g('as fechadas', 'os fechados')}.</strong> {Maiuscula(tipo)}{' '}
              {g('aberta', 'aberto')} não conta, mesmo que esteja quase {g('cheia', 'cheio')}.
            </div>

            <div className="mt-4 flex justify-center">
              <Contador valor={tinha} onChange={setTinha} />
            </div>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-3 text-center">
              O sistema esperava cerca de {esperado} {plural(tipo, esperado)}.
            </p>
          </Card>

          <Button size="xl" fullWidth disabled={nTinha === null}
                  onClick={() => { setErroScan(''); setPasso('caixas'); setLendo(true) }}>
            Continuar → bipar {emb === 'saco' ? 'os sacos' : 'as caixas'}
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={onVoltar}>← Trocar de insumo</Button>
        </>
      )}

      {/* ── 2. De onde saíram ── */}
      {passo === 'caixas' && (
        <>
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">DE ONDE SAÍRAM</p>
            <p className="text-sm text-gray-700 dark:text-unno-text mt-1">
              Bipe o QR de cada {emb} de onde você tirou{' '}
              {plural(tipo, 2)}, e diga {g('quantas', 'quantos')} saíram de cada.
            </p>
            {bipePrimeiro && (
              <p className="mt-3 p-3 rounded-controle bg-amber-50 border border-amber-300 text-sm text-amber-900">
                Bipe primeiro {emb === 'saco' ? 'o saco aberto' : 'a caixa aberta'}:{' '}
                <strong className="font-mono">{bipePrimeiro.codigo}</strong>{' '}
                ({bipePrimeiro.tem} {plural(tipo, bipePrimeiro.tem)}).
              </p>
            )}
          </Card>

          {travaFefo && (
            <div className={`p-4 rounded-bloco border space-y-3 ${
              travaFefo.bloqueia ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'
            }`}>
              <p className="font-semibold text-gray-900">Há uma embalagem aberta no estoque</p>
              <p className="text-sm text-gray-700">{travaFefo.mensagem}</p>
              {travaFefo.bloqueia ? (
                <Button variant="secondary" size="sm" fullWidth onClick={() => setTravaFefo(null)}>Entendi</Button>
              ) : (
                <>
                  <textarea rows={2} value={justFefo} onChange={e => setJustFefo(e.target.value)}
                    placeholder="Por que não a aberta?"
                    className="block w-full rounded-controle border border-gray-300 bg-white px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setTravaFefo(null); setJustFefo('') }}>
                      Cancelar
                    </Button>
                    <Button size="sm" disabled={justFefo.trim().length < 5}
                            onClick={() => bipar(travaFefo.qr, justFefo)}>
                      Usar mesmo assim
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {lendo && !travaFefo ? (
            <Card className="p-5">
              <QRScanner
                onScan={qr => bipar(qr)}
                continuo
                titulo={insumo.nome}
                label={`${caixas.length} bipada${caixas.length === 1 ? '' : 's'}`}
                dicaDigitar={insumo.codigo ? {
                  texto: `Só a tarja preta da etiqueta — o insumo já é ${insumo.nome}. O espaço vira ponto e depois barra; os zeros da frente não precisam.`,
                  exemplo: '5.2/2',
                  tarja: true,
                } : undefined}
                acaoConcluir={{ rotulo: 'Terminei de bipar', onClick: () => setLendo(false) }}
                painel={
                  <div className="text-xs">
                    {bipePrimeiro && (
                      <p className="mb-2 font-semibold text-amber-800">
                        Bipe primeiro: <span className="font-mono">{bipePrimeiro.codigo}</span>{' '}
                        ({emb === 'saco' ? 'aberto' : 'aberta'})
                      </p>
                    )}
                    {erroScan && <p className="font-semibold text-red-700 mb-2">{erroScan}</p>}
                    {caixas.map(c => (
                      <div key={c.id} className="flex justify-between gap-2">
                        <span className="font-mono text-emerald-700 font-semibold truncate">✓ {c.codigo}</span>
                        <span className="text-gray-500 shrink-0">{c.tem} {plural(tipo, c.tem)}</span>
                      </div>
                    ))}
                  </div>
                }
              />
            </Card>
          ) : !travaFefo && (
            <Button variant="secondary" size="lg" fullWidth onClick={() => { setErroScan(''); setLendo(true) }}>
              Bipar {caixas.length ? g2('outro', 'outra') : g2('o', 'a')} {emb}
            </Button>
          )}

          {erroScan && !lendo && (
            <p className="text-sm text-red-700">{erroScan}</p>
          )}

          {caixas.map(c => {
            const problema = caixaComErro(c)
            return (
              <Card key={c.id} className="p-4">
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="font-mono font-semibold text-gray-900 dark:text-unno-text truncate">{c.codigo}</p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">tem {c.tem} {plural(tipo, c.tem)}</p>
                  </div>
                  <button type="button" className="text-xs text-red-600 hover:underline"
                          onClick={() => setCaixas(prev => prev.filter(x => x.id !== c.id))}>
                    tirar
                  </button>
                </div>
                <p className="text-sm text-gray-700 dark:text-unno-text mb-2">
                  {g('Quantas', 'Quantos')} {plural(tipo, 2)} você tirou {dEmb}?
                </p>
                <div className="flex justify-center">
                  <Contador valor={c.unidades}
                    onChange={v => setCaixas(prev => prev.map(x => x.id === c.id ? { ...x, unidades: v } : x))} />
                </div>
                {problema && c.unidades !== '' && (
                  <p className="text-xs text-red-600 font-semibold mt-2 text-center">{problema}</p>
                )}
              </Card>
            )
          })}

          {/* O leitor aberto não trava: quem já bipou e digitou não precisa
              adivinhar que falta apertar "Terminei de bipar". */}
          <Button size="xl" fullWidth disabled={!podeConferir}
                  onClick={() => { setLendo(false); setErro(''); setPasso('confirmar') }}>
            {caixas.length === 0 ? 'Não levei nenhuma — só contei' : 'Conferir'}
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => { setLendo(false); setPasso('contar') }}>
            ← Voltar
          </Button>
        </>
      )}

      {/* ── 3. Conferir e confirmar ── */}
      {passo === 'confirmar' && nTinha !== null && (
        <>
          <Card className="p-5">
            <p className="text-xs text-gray-500 font-medium mb-3">CONFIRA</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-unno-muted">Estavam na produção ({g('fechadas', 'fechados')})</span>
                <span className="font-semibold tabular-nums">{nTinha}</span>
              </div>
              {caixas.map(c => (
                <div key={c.id} className="flex justify-between">
                  <span className="text-gray-600 dark:text-unno-muted">Levou de <span className="font-mono">{c.codigo}</span></span>
                  <span className="font-semibold tabular-nums">+ {unidadesDe(c)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-gray-200 dark:border-white/10 pt-2">
                <span className="font-semibold text-gray-900 dark:text-unno-text">Fica na produção</span>
                <span className="font-bold text-brand-700 dark:text-brand-400 tabular-nums">
                  {nTinha + levou} {plural(tipo, nTinha + levou)}
                </span>
              </div>
            </div>
            {nTinha !== esperado && (
              <p className="text-xs text-amber-700 mt-3">
                O sistema esperava {esperado} {plural(tipo, esperado)} lá — vale a sua contagem.
              </p>
            )}
          </Card>

          {erro && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-controle text-sm text-red-700">{erro}</div>
          )}

          <Button size="xl" fullWidth loading={salvando} onClick={confirmar}>Confirmar</Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => setPasso('caixas')}>← Voltar</Button>
        </>
      )}

      {passo === 'ok' && resultado && (
        <Card className="p-8 text-center">
          <h2 className="text-lg font-bold text-gray-900 dark:text-unno-text mb-1">Registrado</h2>
          <p className="text-sm text-gray-500 dark:text-unno-muted mb-6">
            {insumo.nome}: {resultado.tinha} + {resultado.levou} = <strong>{resultado.total}</strong>{' '}
            {plural(tipo, resultado.total)} na produção.
          </p>
          <Button size="lg" fullWidth onClick={onConcluido}>Reabastecer outro insumo</Button>
        </Card>
      )}
    </div>
  )
}

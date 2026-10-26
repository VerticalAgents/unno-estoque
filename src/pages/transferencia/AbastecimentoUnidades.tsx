import { useState } from 'react'
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
 * Quem reabastece diz só o que mexeu (Lucca, 21/10/2026):
 *
 *   1. bipa as caixas que pegou e diz quantas SOBRARAM em cada (0 = levou a
 *      caixa inteira);
 *   2. conferir e confirmar.
 *
 * Até a migration 144 a primeira pergunta era "quantas fechadas ainda estavam
 * na produção". Essa contagem passou para o fechamento da sessão, obrigatória:
 * quem fecha está com tudo na frente; quem reabastece está com pressa.
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

/** `sobrou`: quantas ficaram na caixa — o que saiu é `tem - sobrou`. */
type Caixa = { id: string; codigo: string; tem: number; sobrou: string }

/** A caixa já bipada na tela de "Levar embalagem original". */
export type CaixaInicial = { id: string; codigo: string; quantidade_disponivel: number }

type Passo = 'caixas' | 'confirmar' | 'ok'

const plural = (tipo: string, n: number) => (n === 1 ? tipo : `${tipo}s`)

/**
 * A dica que ficou no lugar da trava FEFO (migration 142, Lucca 14/10/2026):
 * sugere usar antes a embalagem mais antiga, sem dizer qual. Quem escolhe é o
 * operador; o sistema aceita qualquer uma. Usada também no reabastecimento de pote.
 */
export function DicaMaisAntiga() {
  return (
    <p className="mt-3 p-3 rounded-controle bg-amber-50 border border-amber-300 text-sm text-amber-900">
      Dica: use primeiro a embalagem que está há mais tempo no estoque.
    </p>
  )
}

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

export function AbastecimentoUnidades({ insumo, inicial, onVoltar, onConcluido }: {
  insumo: InsumoPorUnidade
  inicial?: CaixaInicial
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
  const unidadesNaCaixa = (q: number) => Math.floor(Number(q) / insumo.peso + 0.0001)

  const [passo, setPasso] = useState<Passo>('caixas')
  const [caixas, setCaixas] = useState<Caixa[]>(() => inicial
    ? [{ id: inicial.id, codigo: inicial.codigo, tem: unidadesNaCaixa(inicial.quantidade_disponivel), sobrou: '0' }]
    : [])
  const [erroScan, setErroScan] = useState('')
  const [lendo, setLendo] = useState(!inicial)
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [resultado, setResultado] = useState<{ levou: number } | null>(null)

  const sobrouDe = (c: Caixa) => (/^\d+$/.test(c.sobrou.trim()) ? parseInt(c.sobrou, 10) : null)
  const unidadesDe = (c: Caixa) => { const s = sobrouDe(c); return s === null ? null : c.tem - s }
  const levou = caixas.reduce((s, c) => s + Math.max(unidadesDe(c) ?? 0, 0), 0)
  const caixaComErro = (c: Caixa): string | null => {
    const s = sobrouDe(c)
    if (s === null) return `${g('Quantas', 'Quantos')} sobraram ${dEmb} ${emb}?`
    if (s > c.tem) return `${emb === 'saco' ? 'Este' : 'Esta'} só tem ${c.tem} ${plural(tipo, c.tem)}.`
    if (s === c.tem) return `Se ${g('sobraram todas', 'sobraram todos')}, nada saiu ${dEmb} ${emb}: tire da lista.`
    return null
  }
  const podeConferir = caixas.length > 0 && caixas.every(c => caixaComErro(c) === null)

  async function bipar(qr: string) {
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

    // A trava FEFO saiu (migration 142): qualquer caixa vale. A leitura segue
    // pelo banco pelas outras regras (outro insumo, outra marca).
    const { data } = await supabase.rpc('validar_scan_lote', {
      p_empresa_id:    profile.empresa_id,
      p_lote_id:       lote.id,
      p_ja_escaneados: caixas.map(c => c.id),
      p_justificativa: null,
    })
    const resp = data as { erro?: string; trava?: string } | null
    if (resp?.erro && !resp?.trava) { setErroScan(resp.erro); return }

    // A conferência de cima lê a lista antes das consultas; duas leituras no
    // meio delas passariam as duas. Aqui é a lista de agora que decide.
    setCaixas(prev => prev.some(c => c.id === lote.id) ? prev : [...prev, {
      id: lote.id,
      codigo: lote.codigo,
      tem: unidadesNaCaixa(lote.quantidade_disponivel),
      sobrou: '0',
    }])
  }

  async function confirmar() {
    if (!profile) return
    setSalvando(true)
    setErro('')
    const { data, error } = await supabase.rpc('registrar_abastecimento_unidades', {
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_insumo_id:      insumo.insumo_id,
      // Ninguém conta mais aqui: a contagem é do fechamento (migration 144).
      p_tinha:          null,
      p_itens:          caixas.map(c => ({ lote_id: c.id, unidades: unidadesDe(c) })),
      p_justificativa:  null,
    })
    setSalvando(false)
    const resp = data as { ok: boolean; erro?: string; levou?: number } | null
    if (error || !resp?.ok) {
      setErro(resp?.erro ?? error?.message ?? 'Não foi possível registrar.')
      return
    }
    setResultado({ levou: resp.levou ?? 0 })
    setPasso('ok')
  }

  const PASSOS: Passo[] = ['caixas', 'confirmar']
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

      {/* ── 1. De onde saíram ── */}
      {passo === 'caixas' && (
        <>
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">LEVANDO PARA A PRODUÇÃO</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">{insumo.nome}</p>
            <p className="text-sm text-gray-700 dark:text-unno-text mt-1">
              Bipe o QR de cada {emb} que você pegou e diga {g('quantas', 'quantos')}{' '}
              {plural(tipo, 2)} sobraram nela. {g('As', 'Os')} {plural(tipo, 2)} não têm QR: não precisa bipar.
            </p>
            <DicaMaisAntiga />
          </Card>

          {lendo ? (
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
          ) : (
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
                  {g('Quantas', 'Quantos')} {plural(tipo, 2)} sobraram {dEmb} {emb}?{' '}
                  <span className="text-gray-500 dark:text-unno-muted">(0 = levou {g2('o saco inteiro', 'a caixa inteira')})</span>
                </p>
                <div className="flex justify-center">
                  <Contador valor={c.sobrou}
                    onChange={v => setCaixas(prev => prev.map(x => x.id === c.id ? { ...x, sobrou: v } : x))} />
                </div>
                {problema ? (
                  <p className="text-xs text-red-600 font-semibold mt-2 text-center">{problema}</p>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-unno-muted mt-2 text-center">
                    Leva {unidadesDe(c)} {plural(tipo, unidadesDe(c) ?? 0)} para a produção.
                  </p>
                )}
              </Card>
            )
          })}

          {/* O leitor aberto não trava: quem já bipou e digitou não precisa
              adivinhar que falta apertar "Terminei de bipar". */}
          <Button size="xl" fullWidth disabled={!podeConferir}
                  onClick={() => { setLendo(false); setErro(''); setPasso('confirmar') }}>
            Conferir
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => { setLendo(false); onVoltar() }}>
            ← Voltar
          </Button>
        </>
      )}

      {/* ── 2. Conferir e confirmar ── */}
      {passo === 'confirmar' && (
        <>
          <Card className="p-5">
            <p className="text-xs text-gray-500 font-medium mb-3">CONFIRA</p>
            <div className="space-y-2 text-sm">
              {caixas.map(c => (
                <div key={c.id} className="flex justify-between">
                  <span className="text-gray-600 dark:text-unno-muted">Levou de <span className="font-mono">{c.codigo}</span></span>
                  <span className="font-semibold tabular-nums">+ {unidadesDe(c)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-gray-200 dark:border-white/10 pt-2">
                <span className="font-semibold text-gray-900 dark:text-unno-text">Vai para a produção</span>
                <span className="font-bold text-brand-700 dark:text-brand-400 tabular-nums">
                  {levou} {plural(tipo, levou)}
                </span>
              </div>
            </div>
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
            {insumo.nome}: <strong>{resultado.levou}</strong> {plural(tipo, resultado.levou)}{' '}
            levad{g('as', 'os')} para a produção.
          </p>
          <Button size="lg" fullWidth onClick={onConcluido}>Concluir</Button>
        </Card>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { formatQty, ordemNatural } from '../../lib/utils'
import { parseQRLoteCodigo } from '../../lib/qr'
import { bancada, daBancada, usaTara } from '../../lib/unidades'
import type { UnidadeMedida } from '../../types/database.types'

/**
 * Abastecer os potes do EP: o operador DECLARA o que fez.
 *
 * O fluxo antigo movia quantidade por aritmética — o sistema decidia quanto
 * cabia e truncava o último lote bipado. Quem virava "embalagem aberta" no
 * papel era escolhido pela ORDEM DA BIPAGEM, não por quem foi aberta de fato.
 *
 * Aqui a ordem é a da vida real:
 *
 *   1. escolher o insumo que vai ser abastecido (a tela diz quanto falta);
 *   2. encher os potes à vontade e PESAR cada um;
 *   3. bipar as embalagens usadas, já no fim;
 *   4. dizer quais zeraram e quanto sobrou nas outras.
 *
 * A diferença entre o que saiu das embalagens e o que entrou nos potes é
 * perda de abastecimento — gravada como movimento, sem travar nada.
 *
 * Os outros modos de armazenamento (pacote do fornecedor, porcionado, e o que
 * pergunta a cada pacote) continuam na TransferenciaPage, em /transferencia/scan.
 */

type Passo = 'insumo' | 'potes' | 'lotes' | 'fechar' | 'sucesso'

type Pote = {
  local_id: string
  nome: string
  capacidade: number | null
  ja_tem: number
  peso_tara: number | null
}

type InsumoAlvo = {
  insumo_id: string
  codigo: string
  nome: string
  unidade: UnidadeMedida
  potes: Pote[]
  conteudo: number
  capacidade: number
  /** O que está disponível no estoque central, para orientar quem vai buscar. */
  lotes_ec: number
  saldo_ec: number
  proximo: { codigo: string; saldo: number; aberto: boolean } | null
}

type LoteBipado = {
  id: string
  codigo: string
  saldo: number
  unidade: UnidadeMedida
  /** Embalagem que já tinha sido aberta antes desta operação. */
  aberto: boolean
}

/** Quanto foi declarado num pote, ou o motivo de o número não servir. */
type Colocado =
  | { estado: 'vazio' }
  | { estado: 'erro'; mensagem: string }
  | { estado: 'ok'; colocou: number; conteudoFinal: number }

export function AbastecimentoPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [passo, setPasso] = useState<Passo>('insumo')
  const [carregando, setCarregando] = useState(true)
  // Muda quando a lista precisa ser relida — depois de abastecer, os saldos
  // que a tela mostra estão velhos.
  const [recarga, setRecarga] = useState(0)
  const [insumos, setInsumos] = useState<InsumoAlvo[]>([])
  const [alvo, setAlvo] = useState<InsumoAlvo | null>(null)

  // Passo 2 — o que a balança disse, por pote. Texto, porque o campo é texto:
  // converter cedo transforma "12," em 12 e o operador perde o que digitou.
  const [pesos, setPesos] = useState<Record<string, string>>({})
  const [taras, setTaras] = useState<Record<string, string>>({})

  // Passo 3
  const [lotes, setLotes] = useState<LoteBipado[]>([])
  const [erroScan, setErroScan] = useState('')
  const [travaFefo, setTravaFefo] = useState<{
    qr: string; bloqueia: boolean; mensagem: string
  } | null>(null)
  const [justFefo, setJustFefo] = useState('')

  // Passo 4 — vazio = ainda não respondeu; '0' = zerou.
  const [sobras, setSobras] = useState<Record<string, string>>({})

  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [confirmar, setConfirmar] = useState(false)
  const [sucesso, setSucesso] = useState<{
    colocado: number; consumido: number; perda: number; recipientes: string
  } | null>(null)

  const b = bancada(alvo?.unidade ?? '')

  // ── Passo 1: o que existe para abastecer ──────────────────

  useEffect(() => {
    if (!profile) return
    let vivo = true

    async function carregar() {
      const empresa = profile!.empresa_id

      const [comp, locs, cfg, lotesEc] = await Promise.all([
        supabase
          .from('v_recipientes_composicao')
          .select('local_id, local_nome, capacidade_max, insumo_id, insumo_codigo, '
                + 'insumo_nome, unidade_medida, quantidade_total')
          .eq('empresa_id', empresa),
        // A view não traz `peso_tara` nem `efemero`, e os dois importam: a tara
        // para converter o peso do pote, e o `efemero` para não listar as
        // embalagens do fornecedor que viraram ponto de consumo (migration 073).
        supabase
          .from('locais')
          .select('id, peso_tara, efemero')
          .eq('empresa_id', empresa)
          .eq('tipo', 'estoque_produtivo')
          .eq('ativo', true),
        supabase.from('insumos_armazenamento_config').select('insumo_id, modo_ep'),
        supabase
          .from('lotes')
          .select('id, codigo, insumo_id, quantidade_disponivel, quantidade_recebida, '
                + 'validade_pos_abertura')
          .eq('empresa_id', empresa)
          .eq('status', 'ativo')
          .gt('quantidade_disponivel', 0),
      ])

      if (!vivo) return

      const extras = new Map(
        ((locs.data ?? []) as { id: string; peso_tara: number | null; efemero: boolean }[])
          .map(l => [l.id, l]),
      )
      // Sem linha de config o insumo é de recipiente — é o mesmo padrão que a
      // TransferenciaPage aplica (`modo_ep ?? 'recipiente'`).
      const modos = new Map(
        ((cfg.data ?? []) as { insumo_id: string; modo_ep: string | null }[])
          .map(c => [c.insumo_id, c.modo_ep ?? 'recipiente']),
      )

      const porInsumo = new Map<string, InsumoAlvo>()

      for (const linha of (comp.data ?? []) as unknown as {
        local_id: string; local_nome: string; capacidade_max: number | null
        insumo_id: string; insumo_codigo: string; insumo_nome: string
        unidade_medida: UnidadeMedida; quantidade_total: number
      }[]) {
        const extra = extras.get(linha.local_id)
        if (!extra || extra.efemero) continue
        if ((modos.get(linha.insumo_id) ?? 'recipiente') !== 'recipiente') continue

        let ins = porInsumo.get(linha.insumo_id)
        if (!ins) {
          ins = {
            insumo_id: linha.insumo_id,
            codigo: linha.insumo_codigo,
            nome: linha.insumo_nome,
            unidade: linha.unidade_medida,
            potes: [], conteudo: 0, capacidade: 0,
            lotes_ec: 0, saldo_ec: 0, proximo: null,
          }
          porInsumo.set(linha.insumo_id, ins)
        }

        ins.potes.push({
          local_id: linha.local_id,
          nome: linha.local_nome,
          capacidade: linha.capacidade_max,
          ja_tem: Number(linha.quantidade_total ?? 0),
          peso_tara: extra.peso_tara,
        })
        ins.conteudo += Number(linha.quantidade_total ?? 0)
        ins.capacidade += Number(linha.capacidade_max ?? 0)
      }

      // O lote que deve sair primeiro: o aberto, se houver; senão o de validade
      // mais próxima. É a mesma ordem que a trava FEFO cobra na bipagem — dizer
      // isto aqui evita que o operador desça com a embalagem errada.
      const ordenados = ((lotesEc.data ?? []) as unknown as {
        id: string; codigo: string; insumo_id: string
        quantidade_disponivel: number; quantidade_recebida: number
        validade_pos_abertura: string | null
      }[]).slice().sort((x, y) =>
        (x.validade_pos_abertura ?? '9999-12-31').localeCompare(y.validade_pos_abertura ?? '9999-12-31')
        || x.codigo.localeCompare(y.codigo))

      for (const l of ordenados) {
        const ins = porInsumo.get(l.insumo_id)
        if (!ins) continue
        ins.lotes_ec += 1
        ins.saldo_ec += Number(l.quantidade_disponivel ?? 0)
        const aberto = Number(l.quantidade_disponivel) < Number(l.quantidade_recebida)
        // Um aberto sempre desbanca um fechado, mesmo que venha depois na ordem.
        if (!ins.proximo || (aberto && !ins.proximo.aberto)) {
          ins.proximo = { codigo: l.codigo, saldo: Number(l.quantidade_disponivel), aberto }
        }
      }

      for (const ins of porInsumo.values()) {
        ins.potes.sort((x, y) => ordemNatural(x.nome, y.nome))
      }

      setInsumos([...porInsumo.values()].sort((x, y) => ordemNatural(x.codigo, y.codigo)))
      setCarregando(false)
    }

    carregar()
    return () => { vivo = false }
  }, [profile?.empresa_id, recarga])

  // ── Passo 2: o que cada pote recebeu ──────────────────────

  /**
   * Do peso na balança para o que entrou no pote.
   *
   * O campo é o peso BRUTO — pote e conteúdo — porque é o que o visor mostra
   * e é o único jeito de matar o erro de contar embalagens: quem esquece que
   * colocou oito e registra nove some com um pacote no estoque. A tara vem do
   * cadastro do recipiente, e o que já havia dentro é descontado no fim.
   */
  function colocadoNo(pote: Pote): Colocado {
    const bruto = (pesos[pote.local_id] ?? '').replace(',', '.').trim()
    if (bruto === '') return { estado: 'vazio' }

    const n = parseFloat(bruto)
    if (isNaN(n) || n < 0) return { estado: 'erro', mensagem: 'Peso inválido.' }

    // A tara sai do cadastro do pote; enquanto ela não existe, o que foi
    // digitado agora serve — e é salvo assim que o operador confirma.
    // `parseFloat` devolve NaN, não null, então `??` não filtraria nada aqui.
    let tara = 0
    if (usaTara(alvo?.unidade ?? '')) {
      const digitada = parseFloat((taras[pote.local_id] ?? '').replace(',', '.'))
      tara = pote.peso_tara ?? (isNaN(digitada) ? 0 : digitada)
      if (tara <= 0) {
        return { estado: 'erro', mensagem: 'Informe primeiro o peso do pote vazio.' }
      }
    }

    const conteudoFinal = daBancada(Math.max(0, n - tara), b.fator)
    const colocou = Number((conteudoFinal - pote.ja_tem).toFixed(6))

    if (colocou < -0.0005) {
      return {
        estado: 'erro',
        mensagem: `O pote está com ${formatQty(conteudoFinal, alvo!.unidade)} e já tinha `
                + `${formatQty(pote.ja_tem, alvo!.unidade)}. Confira a balança ou a tara.`,
      }
    }
    if (colocou <= 0) {
      return { estado: 'erro', mensagem: 'Este pote não recebeu nada — deixe o campo em branco.' }
    }
    return { estado: 'ok', colocou, conteudoFinal }
  }

  const potesDeclarados = useMemo(() => {
    if (!alvo) return []
    return alvo.potes
      .map(p => ({ pote: p, res: colocadoNo(p) }))
      .filter((x): x is { pote: Pote; res: Extract<Colocado, { estado: 'ok' }> } =>
        x.res.estado === 'ok')
  }, [alvo, pesos, taras])

  const temErroDePeso = useMemo(
    () => (alvo?.potes ?? []).some(p => colocadoNo(p).estado === 'erro'),
    [alvo, pesos, taras],
  )

  const colocado = potesDeclarados.reduce((s, x) => s + x.res.colocou, 0)

  /** A tara digitada agora vale para sempre: é atributo do pote, não da operação. */
  async function salvarTara(pote: Pote) {
    const valor = parseFloat((taras[pote.local_id] ?? '').replace(',', '.'))
    if (isNaN(valor) || valor <= 0 || !alvo) return
    await supabase.from('locais').update({ peso_tara: valor }).eq('id', pote.local_id)
    setAlvo({
      ...alvo,
      potes: alvo.potes.map(p => p.local_id === pote.local_id ? { ...p, peso_tara: valor } : p),
    })
  }

  // ── Passo 3: as embalagens que foram usadas ───────────────

  /**
   * Aceita o lote lido, honrando só a trava FEFO.
   *
   * `validar_scan_lote` também cobra capacidade — e aqui isso não faz sentido:
   * os potes já foram enchidos, o espaço livre já é zero, e a trava dispararia
   * em toda leitura. O que aconteceu já aconteceu; a bipagem só registra.
   */
  async function bipar(qr: string, justificativa?: string) {
    setErroScan('')
    if (!alvo || !profile) return

    const { data: loteData } = await supabase
      .from('lotes')
      .select('id, codigo, insumo_id, unidade, quantidade_disponivel, quantidade_recebida, status')
      .eq('codigo', parseQRLoteCodigo(qr))
      .maybeSingle()

    const lote = loteData as {
      id: string; codigo: string; insumo_id: string; unidade: UnidadeMedida
      quantidade_disponivel: number; quantidade_recebida: number; status: string
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
    if (lotes.some(l => l.id === lote.id)) {
      setErroScan('Esta embalagem já foi bipada.')
      return
    }

    const { data } = await supabase.rpc('validar_scan_lote', {
      p_empresa_id:    profile.empresa_id,
      p_lote_id:       lote.id,
      p_ja_escaneados: lotes.map(l => l.id),
      p_justificativa: justificativa?.trim() || null,
    })
    const resp = data as {
      ok?: boolean; erro?: string; trava?: string; modo?: string; mensagem?: string
    } | null

    if (resp?.trava === 'fefo') {
      setTravaFefo({
        qr,
        bloqueia: resp.modo !== 'avisa',
        mensagem: resp.mensagem ?? '',
      })
      return
    }
    // Erro de coerência (outro insumo, outra marca) continua valendo; a trava de
    // capacidade é ignorada de propósito.
    if (resp?.erro && !resp?.trava) { setErroScan(resp.erro); return }

    setTravaFefo(null)
    setJustFefo('')
    setLotes(prev => [...prev, {
      id: lote.id,
      codigo: lote.codigo,
      saldo: Number(lote.quantidade_disponivel),
      unidade: lote.unidade,
      aberto: Number(lote.quantidade_disponivel) < Number(lote.quantidade_recebida),
    }])
  }

  // ── Passo 4: o que zerou e o que sobrou ───────────────────

  function sobraDe(lote: LoteBipado): number | null {
    const txt = (sobras[lote.id] ?? '').replace(',', '.').trim()
    if (txt === '') return null
    const n = parseFloat(txt)
    if (isNaN(n) || n < 0) return null
    return daBancada(n, b.fator)
  }

  const respondidos = lotes.filter(l => sobraDe(l) !== null)
  const sobraExcedida = lotes.some(l => {
    const s = sobraDe(l)
    return s !== null && s > l.saldo + 0.001
  })
  const consumido = respondidos.reduce((s, l) => s + (l.saldo - (sobraDe(l) ?? 0)), 0)
  const perda = Number((consumido - colocado).toFixed(3))

  const podeFechar =
    respondidos.length === lotes.length
    && lotes.length > 0
    && !sobraExcedida
    && consumido > 0
    && perda >= -0.001

  async function confirmarAbastecimento() {
    if (!alvo || !profile) return
    setSalvando(true)
    setErro('')

    const { data, error } = await supabase.rpc('registrar_abastecimento', {
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_insumo_id:      alvo.insumo_id,
      p_potes: potesDeclarados.map(x => ({
        local_id: x.pote.local_id,
        colocou:  x.res.colocou,
      })),
      p_lotes: lotes.map(l => ({ lote_id: l.id, sobra: sobraDe(l) ?? 0 })),
      p_justificativa: null,
    })

    setSalvando(false)
    setConfirmar(false)

    const resp = data as {
      ok: boolean; erro?: string
      colocado?: number; consumido?: number; perda?: number; recipientes?: string
    } | null

    if (error || !resp?.ok) {
      setErro(resp?.erro ?? error?.message ?? 'Não foi possível registrar o abastecimento.')
      return
    }

    setSucesso({
      colocado:    Number(resp.colocado ?? 0),
      consumido:   Number(resp.consumido ?? 0),
      perda:       Number(resp.perda ?? 0),
      recipientes: resp.recipientes ?? '',
    })
    setPasso('sucesso')
  }

  function recomecar() {
    setPasso('insumo')
    setAlvo(null)
    setPesos({}); setTaras({}); setLotes([]); setSobras({})
    setErro(''); setErroScan(''); setTravaFefo(null); setJustFefo('')
    setSucesso(null)
    // Os saldos mudaram — a lista do passo 1 tem de ser relida, senão a tela
    // volta mostrando os potes como estavam antes de encher.
    setCarregando(true)
    setInsumos([])
    setRecarga(n => n + 1)
  }

  // ── Render ────────────────────────────────────────────────

  const PASSOS: Passo[] = ['insumo', 'potes', 'lotes', 'fechar']
  const indice = PASSOS.indexOf(passo)

  return (
    <div className="p-4 max-w-lg mx-auto min-h-screen">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">Abastecer a produção</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          Encha os potes, pese, e depois diga quais embalagens usou
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
          {carregando && <p className="text-sm text-gray-500">Carregando os recipientes…</p>}

          {!carregando && insumos.length === 0 && (
            <Card className="p-5">
              <p className="text-sm font-semibold text-gray-900 dark:text-unno-text">
                Nenhum insumo com recipiente no estoque produtivo
              </p>
              <p className="text-xs text-gray-600 dark:text-unno-muted mt-1">
                Cadastre os potes, baldes e caixas antes de abastecer.
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate('/recipientes')}>
                Cadastrar recipiente
              </Button>
            </Card>
          )}

          {insumos.map(ins => {
            const falta = Math.max(ins.capacidade - ins.conteudo, 0)
            const cheio = falta <= 0.001
            const semLote = ins.lotes_ec === 0
            const pct = ins.capacidade > 0
              ? Math.min(100, Math.round((ins.conteudo / ins.capacidade) * 100))
              : 0
            return (
              <Card
                key={ins.insumo_id}
                className={`p-4 ${cheio ? 'opacity-60' : ''}`}
                onClick={() => {
                  setAlvo(ins)
                  setPesos({}); setTaras({}); setLotes([]); setSobras({})
                  setErro('')
                  setPasso('potes')
                }}
              >
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-unno-text truncate">{ins.nome}</p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">
                      {ins.potes.length} recipiente{ins.potes.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className={`text-xs font-semibold shrink-0 ${cheio ? 'text-gray-400' : 'text-brand-700 dark:text-brand-400'}`}>
                    {cheio ? 'Cheio' : `Cabe ${formatQty(falta, ins.unidade)}`}
                  </span>
                </div>

                <div className="mt-3 h-2 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
                  {formatQty(ins.conteudo, ins.unidade)} de {formatQty(ins.capacidade, ins.unidade)} nos potes
                </p>

                {semLote ? (
                  <p className="text-xs text-amber-700 mt-2">
                    Sem embalagem no estoque central para este insumo.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-unno-muted mt-2">
                    No estoque central: {formatQty(ins.saldo_ec, ins.unidade)} em {ins.lotes_ec}{' '}
                    embalagem{ins.lotes_ec === 1 ? '' : 's'}
                    {ins.proximo && (
                      <>
                        {' · '}pegue <strong className="text-gray-700 dark:text-unno-text">{ins.proximo.codigo}</strong>
                        {ins.proximo.aberto && ' (já aberta)'}
                      </>
                    )}
                  </p>
                )}
              </Card>
            )
          })}

          {!carregando && (
            <Button variant="ghost" size="lg" fullWidth onClick={() => navigate('/transferencia/scan')}>
              Outro tipo de transferência
            </Button>
          )}
        </div>
      )}

      {/* ── Passo 2: encher e pesar ── */}
      {passo === 'potes' && alvo && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">ABASTECENDO</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">{alvo.nome}</p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Encha os potes até onde der. Depois pese cada um que você mexeu — os
              outros ficam em branco.
            </p>
            {alvo.proximo && (
              <p className="text-xs text-gray-600 dark:text-unno-muted mt-2">
                Comece pela embalagem <strong>{alvo.proximo.codigo}</strong>
                {alvo.proximo.aberto && ', que já está aberta'}.
              </p>
            )}
          </Card>

          {alvo.potes.map(pote => {
            const res = colocadoNo(pote)
            const precisaTara = usaTara(alvo.unidade) && !pote.peso_tara
            return (
              <Card key={pote.local_id} className="p-4">
                <div className="flex justify-between items-start gap-3 mb-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 dark:text-unno-text truncate">{pote.nome}</p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">
                      Já tinha {formatQty(pote.ja_tem, alvo.unidade)}
                      {pote.capacidade != null && ` · comporta ${formatQty(pote.capacidade, alvo.unidade)}`}
                    </p>
                  </div>
                </div>

                {precisaTara ? (
                  <div className="space-y-2">
                    <Input
                      label={`Peso do pote VAZIO (${b.rotulo})`}
                      type="number"
                      inputMode="decimal"
                      value={taras[pote.local_id] ?? ''}
                      onChange={e => setTaras(t => ({ ...t, [pote.local_id]: e.target.value }))}
                      placeholder="Só uma vez: fica salvo no cadastro"
                      hint="Sem a tara não dá para saber quanto tem dentro."
                    />
                    <Button
                      variant="secondary" size="sm" fullWidth
                      disabled={!(parseFloat((taras[pote.local_id] ?? '').replace(',', '.')) > 0)}
                      onClick={() => salvarTara(pote)}
                    >
                      Salvar a tara
                    </Button>
                  </div>
                ) : (
                  <>
                    <Input
                      label={usaTara(alvo.unidade)
                        ? `Peso na balança, com o pote (${b.rotulo})`
                        : `Quanto tem dentro agora (${b.rotulo})`}
                      type="number"
                      inputMode="decimal"
                      value={pesos[pote.local_id] ?? ''}
                      onChange={e => setPesos(p => ({ ...p, [pote.local_id]: e.target.value }))}
                      placeholder="Em branco se não mexeu neste pote"
                      error={res.estado === 'erro' ? res.mensagem : undefined}
                    />
                    {res.estado === 'ok' && (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-2">
                        Entrou <strong>{formatQty(res.colocou, alvo.unidade)}</strong> — o pote fica com{' '}
                        {formatQty(res.conteudoFinal, alvo.unidade)}
                        {pote.capacidade != null && res.conteudoFinal > pote.capacidade && (
                          <> , acima da capacidade cadastrada. Tudo bem: vale o que está no pote.</>
                        )}
                      </p>
                    )}
                    {usaTara(alvo.unidade) && pote.peso_tara != null && (
                      <p className="text-[0.7rem] text-gray-400 mt-1">
                        Tara do pote: {pote.peso_tara} {b.rotulo}
                      </p>
                    )}
                  </>
                )}
              </Card>
            )
          })}

          <Card className="p-4">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-unno-muted">Entrou nos potes</span>
              <span className="font-bold text-brand-700 dark:text-brand-400 tabular-nums">
                {formatQty(colocado, alvo.unidade)}
              </span>
            </div>
          </Card>

          <Button
            size="xl" fullWidth
            disabled={colocado <= 0 || temErroDePeso}
            onClick={() => { setErroScan(''); setPasso('lotes') }}
          >
            Continuar → bipar as embalagens
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => setPasso('insumo')}>
            ← Trocar de insumo
          </Button>
        </div>
      )}

      {/* ── Passo 3: bipar as embalagens usadas ── */}
      {passo === 'lotes' && alvo && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">JÁ NOS POTES</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">
              {formatQty(colocado, alvo.unidade)} de {alvo.nome}
            </p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Agora bipe todas as embalagens que você usou — as que zeraram e as
              que sobraram.
            </p>
          </Card>

          {lotes.length > 0 && (
            <Card className="p-4">
              <p className="text-xs text-gray-500 font-medium mb-2">
                {lotes.length} EMBALAGEM{lotes.length === 1 ? '' : 'S'} BIPADA{lotes.length === 1 ? '' : 'S'}
              </p>
              <div className="space-y-1.5">
                {lotes.map(l => (
                  <div key={l.id} className="flex justify-between items-center gap-2 text-sm">
                    <span className="font-mono text-gray-700 dark:text-unno-text truncate">
                      {l.codigo}{l.aberto && <span className="text-amber-600 text-xs"> · aberta</span>}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-gray-500 text-xs">{formatQty(l.saldo, l.unidade)}</span>
                      <button
                        type="button"
                        onClick={() => setLotes(prev => prev.filter(x => x.id !== l.id))}
                        className="text-xs text-red-600 hover:underline"
                      >
                        tirar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {travaFefo ? (
            <div className={`p-4 rounded-xl border space-y-3 ${
              travaFefo.bloqueia ? 'bg-red-50 border-red-300' : 'bg-amber-50 border-amber-300'
            }`}>
              <p className="font-semibold text-gray-900">Há uma embalagem aberta no estoque</p>
              <p className="text-sm text-gray-700">{travaFefo.mensagem}</p>
              {travaFefo.bloqueia ? (
                <Button variant="secondary" size="sm" fullWidth onClick={() => setTravaFefo(null)}>
                  Entendi
                </Button>
              ) : (
                <>
                  <textarea
                    rows={2}
                    value={justFefo}
                    onChange={e => setJustFefo(e.target.value)}
                    placeholder="Ex: a embalagem aberta foi separada para descarte"
                    className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                               focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
                  />
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setTravaFefo(null); setJustFefo('') }}>
                      Cancelar
                    </Button>
                    <Button
                      size="sm" fullWidth
                      disabled={justFefo.trim().length < 5}
                      onClick={() => bipar(travaFefo.qr, justFefo)}
                    >
                      Registrar mesmo assim
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Card className="p-5">
              <QRScanner
                onScan={qr => bipar(qr)}
                continuo
                titulo={alvo.nome}
                label={`${lotes.length} bipada${lotes.length === 1 ? '' : 's'}`}
                acaoConcluir={{
                  rotulo: 'Terminei de bipar',
                  onClick: () => { setErroScan(''); setPasso('fechar') },
                }}
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
                <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {erroScan}
                </div>
              )}
            </Card>
          )}

          <Button
            size="xl" fullWidth
            disabled={lotes.length === 0}
            onClick={() => { setErroScan(''); setPasso('fechar') }}
          >
            Continuar → o que sobrou
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => setPasso('potes')}>
            ← Voltar aos potes
          </Button>
        </div>
      )}

      {/* ── Passo 4: o que zerou e o que sobrou ── */}
      {passo === 'fechar' && alvo && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium">ÚLTIMO PASSO</p>
            <p className="font-semibold text-gray-900 dark:text-unno-text">
              Cada embalagem zerou ou sobrou quanto?
            </p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
              Pese a sobra e volte com ela para o estoque. Não precisa descontar o
              peso da embalagem.
            </p>
          </Card>

          {lotes.map(l => {
            const s = sobraDe(l)
            const zerou = (sobras[l.id] ?? '') === '0'
            const excedeu = s !== null && s > l.saldo + 0.001
            return (
              <Card key={l.id} className="p-4">
                <div className="flex justify-between items-start gap-3 mb-3">
                  <div className="min-w-0">
                    <p className="font-mono font-semibold text-gray-900 dark:text-unno-text truncate">
                      {l.codigo}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-unno-muted">
                      Tinha {formatQty(l.saldo, l.unidade)}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2 mb-2">
                  <Button
                    variant={zerou ? 'primary' : 'ghost'}
                    size="sm"
                    fullWidth
                    onClick={() => setSobras(v => ({ ...v, [l.id]: '0' }))}
                  >
                    Zerou
                  </Button>
                  <Button
                    variant={s !== null && !zerou ? 'primary' : 'ghost'}
                    size="sm"
                    fullWidth
                    onClick={() => setSobras(v => ({ ...v, [l.id]: v[l.id] === '0' ? '' : (v[l.id] ?? '') }))}
                  >
                    Sobrou
                  </Button>
                </div>

                {!zerou && (
                  <Input
                    label={`Peso da sobra (${b.rotulo})`}
                    type="number"
                    inputMode="decimal"
                    value={sobras[l.id] ?? ''}
                    onChange={e => setSobras(v => ({ ...v, [l.id]: e.target.value }))}
                    placeholder="Quanto voltou para o estoque"
                    error={excedeu
                      ? `Sobrou mais do que a embalagem tinha (${formatQty(l.saldo, l.unidade)}).`
                      : undefined}
                  />
                )}

                {s !== null && !excedeu && (
                  <p className="text-xs text-gray-600 dark:text-unno-muted mt-2">
                    Saiu desta embalagem: <strong>{formatQty(l.saldo - s, l.unidade)}</strong>
                    {s === 0 && ' — vai ficar esgotada'}
                  </p>
                )}
              </Card>
            )
          })}

          {/* O balanço. Ele nunca fecha: parte do insumo fica no funil, na
              colher e no chão, e é isso que a linha da perda diz. */}
          <Card className="p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-unno-muted">Saiu das embalagens</span>
              <span className="font-semibold tabular-nums">{formatQty(consumido, alvo.unidade)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-unno-muted">Entrou nos potes</span>
              <span className="font-semibold tabular-nums">{formatQty(colocado, alvo.unidade)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-gray-100 dark:border-white/10">
              <span className="text-gray-500 dark:text-unno-muted">Diferença (perda)</span>
              <span className={`font-bold tabular-nums ${perda > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                {formatQty(Math.max(perda, 0), alvo.unidade)}
              </span>
            </div>
            {perda < -0.001 && (
              <p className="text-xs text-red-700">
                Os potes receberam mais do que saiu das embalagens. Confira os pesos —
                falta bipar alguma embalagem, ou uma sobra está alta demais.
              </p>
            )}
            {respondidos.length < lotes.length && (
              <p className="text-xs text-gray-500">
                Falta responder {lotes.length - respondidos.length} embalagem
                {lotes.length - respondidos.length === 1 ? '' : 's'}.
              </p>
            )}
          </Card>

          {erro && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {erro}
            </div>
          )}

          <Button
            variant="danger" size="xl" fullWidth
            disabled={!podeFechar}
            loading={salvando}
            onClick={() => setConfirmar(true)}
          >
            REGISTRAR ABASTECIMENTO
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={() => setPasso('lotes')}>
            ← Voltar às embalagens
          </Button>
        </div>
      )}

      {/* ── Sucesso ── */}
      {passo === 'sucesso' && sucesso && (
        <Card className="p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-unno-text mb-1">Abastecimento registrado</h2>
          <p className="text-sm text-gray-500 dark:text-unno-muted mb-4">
            {sucesso.recipientes || 'Os recipientes foram atualizados.'}
          </p>
          <div className="text-sm text-left space-y-1 mb-6">
            <div className="flex justify-between">
              <span className="text-gray-500">Saiu do estoque central</span>
              <span className="font-semibold tabular-nums">{sucesso.consumido}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Entrou nos potes</span>
              <span className="font-semibold tabular-nums">{sucesso.colocado}</span>
            </div>
            {sucesso.perda > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">Perda registrada</span>
                <span className="font-semibold text-amber-700 tabular-nums">{sucesso.perda}</span>
              </div>
            )}
          </div>
          <Button size="xl" fullWidth onClick={recomecar}>
            Abastecer outro insumo
          </Button>
        </Card>
      )}

      <ConfirmModal
        open={confirmar}
        title="Registrar abastecimento?"
        description="Os potes passam a valer o peso declarado e as embalagens ficam com a sobra informada."
        variant="danger"
        confirmLabel="REGISTRAR"
        loading={salvando}
        summary={alvo ? (
          <div className="space-y-1">
            <p><strong>{alvo.nome}</strong></p>
            <p>
              {potesDeclarados.length} recipiente{potesDeclarados.length === 1 ? '' : 's'} ·{' '}
              {formatQty(colocado, alvo.unidade)} · {lotes.length} embalagem
              {lotes.length === 1 ? '' : 's'}
            </p>
            {perda > 0.001 && <p>Perda: {formatQty(perda, alvo.unidade)}</p>}
          </div>
        ) : undefined}
        onConfirm={confirmarAbastecimento}
        onCancel={() => setConfirmar(false)}
      />
    </div>
  )
}

import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Lote, Local } from '../../types/database.types'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { formatDate, formatQty, precisaReembalagem, precisaDestinoMultiplo } from '../../lib/utils'
import { parseQRLoteCodigo, qrDaEmbalagem } from '../../lib/qr'
import { ReembalagemNutella } from './components/ReembalagemNutella'
import { ReembalagemStikadinho } from './components/ReembalagemStikadinho'
import { ReembalagemDDL } from './components/ReembalagemDDL'

type Step = 'scan_lote' | 'scan_mais' | 'scan_local' | 'confirmar' | 'reembalagem'
  | 'mover_embalagem' | 'sucesso'

type ModoEp = 'recipiente' | 'embalagem_fornecedor' | 'porcionado' | 'escolher'

type LoteWithInsumo = Lote & {
  insumo: {
    nome: string; codigo: string; shelf_life_dias_pos_abertura: number | null
    armazenamento_config?: { passa_reembalagem: boolean; destino_multiplo: boolean; modo_ep?: ModoEp }
  }
  marca?: { nome: string } | null
}

/**
 * O pacote do fornecedor É o ponto de consumo (migration 073).
 *
 * Nesses insumos não existe recipiente para escanear: o balde sai da prateleira
 * e vai para a bancada inteiro, com a etiqueta de lote que já está colada nele.
 * O `insumos_armazenamento_config` pode vir como objeto ou como lista de um
 * elemento, dependendo de como o PostgREST resolve o embed.
 */
function modoEp(lote: LoteWithInsumo): ModoEp {
  const bruto = lote.insumo?.armazenamento_config as unknown
  const config = Array.isArray(bruto) ? bruto[0] : bruto
  return (config as { modo_ep?: ModoEp } | undefined)?.modo_ep ?? 'recipiente'
}

function ehEmbalagemDoFornecedor(lote: LoteWithInsumo): boolean {
  return modoEp(lote) === 'embalagem_fornecedor'
}
type LocalWithInsumo = Local & {
  insumo?: { nome: string; codigo: string }
  marca?: { nome: string } | null
  estado_atual?: { quantidade: number; lote_id?: string; unidade?: string }
}

export function TransferenciaPage() {
  const { profile } = useAuth()

  const [step, setStep] = useState<Step>('scan_lote')
  const [lotes, setLotes] = useState<LoteWithInsumo[]>([])
  const [local, setLocal] = useState<LocalWithInsumo | null>(null)
  const [ro003Error, setRo003Error] = useState('')
  // Retorno de validar_scan_lote: quanto ainda cabe nos recipientes deste
  // insumo e quanto já foi lido. É o que impede carregar peso à toa.
  const [validacao, setValidacao] = useState<{
    espaco_livre: number; ja_escaneado: number
    total_com_este: number; volta_ao_estoque: number
  } | null>(null)
  // Trava que pegou na leitura do QR, antes de o operador carregar nada.
  const [travaScan, setTravaScan] = useState<{
    qr: string; chave: string; modo: string; mensagem: string; loteEsperado?: string
  } | null>(null)
  const [justScan, setJustScan] = useState('')
  // Sobrou lote depois de encher um recipiente: dá para seguir para o próximo.
  const [sobras, setSobras] = useState<{ codigo: string; quantidade: number }[]>([])
  // Trava em modo "avisa": a ação é permitida, mas só depois de o operador
  // escrever por que está contrariando a regra.
  const [travaAviso, setTravaAviso] = useState<{ chave: string; mensagem: string } | null>(null)
  const [justificativa, setJustificativa] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [scanError, setScanError] = useState('')
  const [sucesso, setSucesso] = useState<{ codigos: string[] } | null>(null)

  // Alias for reembalagem compatibility
  const lote = lotes[0] ?? null

  // ── Helpers ───────────────────────────────────────────────

  /**
   * O QR lido é a etiqueta fixa de um recipiente?
   *
   * As duas etiquetas circulam pela mesma bancada e são bipadas em etapas
   * diferentes da mesma tela. Sem esta pergunta, bipar o pote na etapa do lote
   * caía num "QR não reconhecido" — tecnicamente verdade (o código do pote não
   * existe em `lotes`), mas que não dizia o que tinha acontecido.
   */
  async function recipienteDoQr(qr: string) {
    const { data } = await supabase
      .from('locais')
      .select('id, nome, ativo')
      .eq('qr_code_fixo', qr)
      .maybeSingle()
    return data as { id: string; nome: string; ativo: boolean } | null
  }

  async function erroLoteInativo(qr: string): Promise<string> {
    const codigoParseado = parseQRLoteCodigo(qr)
    const { data } = await supabase
      .from('lotes')
      .select('codigo, status')
      .eq('codigo', codigoParseado)
      .maybeSingle()

    // Debug: loga no console do celular (acessível via chrome://inspect)
    console.log('[TransferenciaPage] QR bruto:', JSON.stringify(qr))
    console.log('[TransferenciaPage] Código parseado:', JSON.stringify(codigoParseado))
    console.log('[TransferenciaPage] Lote encontrado:', data)

    if (!data) return `QR não reconhecido. Código buscado: "${codigoParseado}" (do QR: "${qr}")`

    const codigo = data.codigo
    if (data.status === 'esgotado')
      return `Este lote (${codigo}) já foi transferido para o EP — quantidade no EC zerada.`
    if (data.status === 'vencido')
      return `Este lote (${codigo}) está vencido e não pode ser transferido.`
    if (data.status === 'descartado')
      return `Este lote (${codigo}) foi descartado.`
    return `Lote ${codigo} inativo (status: ${data.status}).`
  }

  const SELECT_LOTE = `
    *,
    marca:marcas(nome),
    insumo:insumos(
      nome, codigo, shelf_life_dias_pos_abertura,
      armazenamento_config:insumos_armazenamento_config(passa_reembalagem, destino_multiplo, modo_ep)
    )
  `

  /**
   * Toda leitura de QR no estoque central passa por aqui.
   *
   * Quem decide se o lote entra é o banco (`validar_scan_lote`), porque são as
   * travas configuradas que mandam: obrigar a começar pelo lote que ficou
   * aberto, e não deixar escanear mais do que cabe nos recipientes daquele
   * insumo. A conta é feita antes de o operador carregar qualquer peso.
   */
  async function adicionarLote(qr: string, justificativa?: string) {
    setScanError('')

    const { data: loteData } = await supabase
      .from('lotes')
      .select(SELECT_LOTE)
      .eq('codigo', parseQRLoteCodigo(qr))
      .eq('status', 'ativo')
      .single()

    if (!loteData) {
      // Bipou a etiqueta do pote aqui. O aviso precisa dizer em que etapa a
      // tela está — é o que estava faltando: sem isso, quem bipa fora de ordem
      // fica procurando defeito na etiqueta.
      //
      // E não avança sozinho de propósito: numa transferência de vários lotes
      // para o mesmo pote, um bipe fora de ordem encerraria a coleta antes da
      // hora, e o operador só descobriria na confirmação.
      const recipiente = await recipienteDoQr(qr)
      if (recipiente) {
        setScanError(
          `Esta é a etapa de escanear LOTES, e "${recipiente.nome}" é um recipiente. `
          + (lotes.length === 0
            ? 'Bipe primeiro a etiqueta do lote que vai entrar nele.'
            : 'Termine de bipar os lotes e toque em "Continuar para o recipiente" — '
              + 'aí sim bipe esta etiqueta.'),
        )
        return
      }
      setScanError(await erroLoteInativo(qr))
      return
    }

    const novo = loteData as LoteWithInsumo

    if (lotes.some(l => l.id === novo.id)) {
      setScanError('Este lote já foi escaneado.')
      return
    }

    const { data, error } = await supabase.rpc('validar_scan_lote', {
      p_empresa_id:    profile!.empresa_id,
      p_lote_id:       novo.id,
      p_ja_escaneados: lotes.map(l => l.id),
      p_justificativa: justificativa?.trim() || null,
    })

    const resp = data as {
      ok: boolean; erro?: string; trava?: string; modo?: string
      mensagem?: string; lote_esperado?: string
      espaco_livre?: number; ja_escaneado?: number
      total_com_este?: number; volta_ao_estoque?: number
    } | null

    if (error) {
      setScanError(error.message)
      return
    }

    if (resp?.trava) {
      setTravaScan({
        qr,
        chave: resp.trava,
        modo: resp.modo ?? 'bloqueia',
        mensagem: resp.mensagem ?? '',
        loteEsperado: resp.lote_esperado,
      })
      return
    }

    if (!resp?.ok) {
      setScanError(resp?.erro ?? 'Não foi possível validar este lote.')
      return
    }

    setTravaScan(null)
    setJustScan('')
    setValidacao({
      espaco_livre:     Number(resp.espaco_livre ?? 0),
      ja_escaneado:     Number(resp.ja_escaneado ?? 0),
      total_com_este:   Number(resp.total_com_este ?? 0),
      volta_ao_estoque: Number(resp.volta_ao_estoque ?? 0),
    })
    setLotes(prev => [...prev, novo])

    // O pacote do fornecedor não tem recipiente de destino: ele É o destino.
    // Continua aceitando mais sublotes (duas garrafas de baunilha viram dois
    // pontos de consumo), mas nunca passa pela etapa de escanear recipiente.
    if (ehEmbalagemDoFornecedor(novo)) {
      setStep('scan_mais')
    } else if (lotes.length === 0 && precisaReembalagem(novo.insumo.codigo)) {
      setStep('scan_local')
    } else if (lotes.length === 0) {
      setStep('scan_mais')
    }
  }

  // ── Step 3: scan local EP QR ──────────────────────────────

  async function handleScanLocal(qr: string) {
    setScanError('')
    setRo003Error('')

    const { data: localData } = await supabase
      .from('locais')
      .select(`
        *,
        insumo:insumos(nome, codigo),
        marca:marcas(nome),
        estado_atual:locais_estado_atual(quantidade, lote_id, unidade)
      `)
      // Duas etiquetas servem: o QR próprio do pote da cozinha e o QR derivado
      // do lote, que é o que existe quando o ponto de consumo é a embalagem do
      // fornecedor (migration 073).
      .in('qr_code_fixo', [qr, qrDaEmbalagem(parseQRLoteCodigo(qr))])
      .eq('ativo', true)
      .limit(1)
      .maybeSingle()

    if (!localData) {
      // O contrário do caso acima: etiqueta de lote bipada na etapa do pote.
      const { data: loteQr } = await supabase
        .from('lotes')
        .select('codigo')
        .eq('codigo', parseQRLoteCodigo(qr))
        .maybeSingle()
      setScanError(
        loteQr
          ? `Esta é a etapa de escanear o RECIPIENTE, e ${loteQr.codigo} é um lote. `
            + 'Bipe a etiqueta colada no pote que vai receber o insumo.'
          : `Recipiente não encontrado: ${qr}`,
      )
      return
    }

    const loc = localData as LocalWithInsumo

    // RO-003 foi revogada (migration 035): o recipiente pode receber lote novo
    // mesmo com sobra dentro. O conteúdo atual vira informação, não bloqueio —
    // a tela de confirmação mostra que vai misturar.
    const estadoRaw = loc.estado_atual as unknown
    const estadoArray = Array.isArray(estadoRaw) ? estadoRaw as Array<{ quantidade: number; lote_id?: string; unidade?: string }> : null
    const estado = estadoArray ? estadoArray[0] : (estadoRaw as { quantidade: number; lote_id?: string; unidade?: string } | undefined)

    // Validação de marca
    const marcaLote = lote?.marca_id
    const marcaLocal = (localData as LocalWithInsumo).marca_id
    if (marcaLote && marcaLocal && marcaLote !== marcaLocal) {
      const nomeLote = (lote?.marca as { nome: string } | null)?.nome ?? marcaLote
      const nomeLocal = (localData as LocalWithInsumo & { marca?: { nome: string } | null }).marca?.nome ?? marcaLocal
      setScanError(`Marca incompatível: lote é ${nomeLote} mas o recipiente é para ${nomeLocal}.`)
      return
    }

    setLocal({ ...loc, estado_atual: estado as LocalWithInsumo['estado_atual'] })

    if (lote && precisaReembalagem(lote.insumo.codigo)) {
      setStep('reembalagem')
    } else {
      setStep('confirmar')
    }
  }

  // ── Confirm normal transfer ───────────────────────────────

  async function handleConfirmar() {
    if (!lote || !local || !profile) return
    setLoading(true)

    const { data, error } = await supabase.rpc('realizar_transferencia_multipla', {
      p_lote_ids:       lotes.map(l => l.id),
      p_local_id:       local.id,
      p_responsavel_id: profile.id,
      p_empresa_id:     profile.empresa_id,
      // vai preenchida na segunda tentativa, quando uma trava pediu explicação
      p_justificativa:  justificativa.trim() || null,
    })

    setLoading(false)

    // Trava disparou. Em "bloqueia" não há o que fazer; em "avisa" a tela pede
    // a justificativa e o operador confirma de novo.
    const resp = data as {
      ok: boolean; trava?: string; modo?: string
      mensagem?: string; requer_justificativa?: boolean; erro?: string
    } | null

    if (resp?.trava) {
      if (resp.modo === 'avisa') {
        // Mantém o modal aberto: ele se transforma, mostrando o motivo e o
        // campo de justificativa. Confirmar de novo reenvia com a explicação.
        setTravaAviso({ chave: resp.trava, mensagem: resp.mensagem ?? '' })
      } else {
        setShowConfirm(false)
        setScanError(resp.mensagem ?? 'Ação bloqueada pelas regras da empresa.')
        setStep('confirmar')
      }
      return
    }

    setShowConfirm(false)

    if (error || !resp?.ok) {
      setScanError(resp?.erro ?? error?.message ?? 'Erro na transferência.')
      setStep('confirmar')
      return
    }

    setTravaAviso(null)
    setJustificativa('')

    const r = data as {
      codigo?: string
      sobras?: { codigo: string; quantidade: number }[]
      volta_ao_estoque?: number
    }

    // O recipiente encheu antes de acabar o que foi escaneado. O operador está
    // com o resto na mão — em vez de encerrar, a tela pede o próximo recipiente.
    if (r.sobras && r.sobras.length > 0) {
      const { data: restantes } = await supabase
        .from('lotes')
        .select(SELECT_LOTE)
        .in('codigo', r.sobras.map(s => s.codigo))
        .eq('status', 'ativo')

      setSobras(r.sobras)
      setLotes((restantes ?? []) as unknown as LoteWithInsumo[])
      setLocal(null)
      setValidacao(null)
      setStep('scan_local')
      return
    }

    setSucesso({ codigos: [r.codigo ?? ''] })
    setStep('sucesso')
  }

  function handleReset() {
    setStep('scan_lote')
    setLotes([])
    setLocal(null)
    setRo003Error('')
    setScanError('')
    setSucesso(null)
    setShowConfirm(false)
    setValidacao(null)
    setTravaScan(null)
    setJustScan('')
    setSobras([])
  }

  /**
   * Move os pacotes do fornecedor inteiros para a produção.
   *
   * Um pacote vira um ponto de consumo, com o QR derivado do próprio lote — é
   * a RPC que cria o local, não o operador. Cada sublote é independente: se um
   * falhar, os outros já movidos continuam movidos, e a tela diz quais foram.
   */
  async function confirmarMoverEmbalagem() {
    if (!profile || lotes.length === 0) return
    setLoading(true)
    setScanError('')

    const movidos: string[] = []
    for (const l of lotes) {
      const { data, error } = await supabase.rpc('mover_embalagem_fornecedor', {
        p_lote_id:        l.id,
        p_responsavel_id: profile.id,
        p_empresa_id:     profile.empresa_id,
      })
      const resp = data as { ok: boolean; erro?: string } | null
      if (error || !resp?.ok) {
        setLoading(false)
        setScanError(
          (movidos.length > 0 ? `${movidos.join(', ')} já foram movidos. ` : '')
          + `Falhou em ${l.codigo}: ${resp?.erro ?? error?.message ?? 'erro desconhecido'}`,
        )
        return
      }
      movidos.push(l.codigo)
    }

    setLoading(false)
    setSucesso({ codigos: movidos })
    setStep('sucesso')
  }

  const totalQty = lotes.reduce((acc, l) => acc + (l.quantidade_disponivel ?? 0), 0)
  const unidade = lotes[0]?.unidade ?? ''

  /** Depois de juntar os lotes: bipar o recipiente, ou mover o pacote inteiro. */
  const passoDepoisDosLotes: Step = lote && ehEmbalagemDoFornecedor(lote)
    ? 'mover_embalagem'
    : 'scan_local'
  const rotuloDepoisDosLotes = passoDepoisDosLotes === 'mover_embalagem'
    ? 'Mover para a produção'
    : 'Continuar para o recipiente'

  // ── Render ────────────────────────────────────────────────

  const STEPS_NORMAL: Step[] = ['scan_lote', 'scan_mais', 'scan_local', 'confirmar']
  const stepIndex = STEPS_NORMAL.indexOf(step)

  const bloqueadoNoScan = travaScan?.modo === 'bloqueia'
  const faltaJustificarScan = !bloqueadoNoScan && justScan.trim().length < 5

  /**
   * O painel que aparece quando uma trava pega na leitura do QR.
   * Em `bloqueia` só há o caminho de volta; em `avisa`, o operador explica e
   * segue. É o mesmo desenho nos dois passos de leitura.
   */
  const painelTrava = travaScan && (
    <div className={`p-4 rounded-xl border space-y-3 ${
      bloqueadoNoScan
        ? 'bg-red-50 border-red-300'
        : 'bg-amber-50 border-amber-300'
    }`}>
      <div>
        <p className="font-semibold text-gray-900">
          {travaScan.chave === 'fefo'
            ? (bloqueadoNoScan ? 'Escaneie primeiro o lote aberto' : 'Há um lote aberto no estoque')
            : (bloqueadoNoScan ? 'Não cabe mais' : 'Isso é mais do que cabe')}
        </p>
        <p className="text-sm text-gray-700 mt-1">{travaScan.mensagem}</p>
      </div>

      {bloqueadoNoScan ? (
        <Button variant="secondary" size="sm" fullWidth onClick={() => setTravaScan(null)}>
          Entendi, vou pegar o certo
        </Button>
      ) : (
        <>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-600">
              Seguir mesmo assim? Explique por quê
            </label>
            <textarea
              rows={2}
              value={justScan}
              onChange={e => setJustScan(e.target.value)}
              placeholder={travaScan.chave === 'fefo'
                ? 'Ex: o lote aberto foi separado para descarte'
                : 'Ex: vou abastecer também o recipiente reserva'}
              className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
            />
            <p className="text-[0.7rem] text-gray-500 mt-1">
              {faltaJustificarScan
                ? `Faltam ${5 - justScan.trim().length} letra(s) para liberar o botão — o mínimo é 5.`
                : 'Fica registrado em Configurações → Travas.'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setTravaScan(null); setJustScan('') }}>
              Cancelar
            </Button>
            <Button
              size="sm"
              fullWidth
              disabled={faltaJustificarScan}
              onClick={() => adicionarLote(travaScan.qr, justScan)}
            >
              Escanear mesmo assim
            </Button>
          </div>
        </>
      )}
    </div>
  )

  /** Quanto ainda cabe nos recipientes deste insumo, somados. */
  const painelCabe = validacao && (
    <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm">
      <div className="flex justify-between">
        <span className="text-gray-500">Cabe nos recipientes</span>
        <span className="font-semibold text-gray-900 tabular-nums">
          {formatQty(validacao.espaco_livre, unidade)}
        </span>
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-gray-500">Escaneado até agora</span>
        <span className="font-semibold text-brand-700 tabular-nums">
          {formatQty(totalQty, unidade)}
        </span>
      </div>
      {validacao.volta_ao_estoque > 0 && (
        <p className="text-xs text-amber-700 mt-2">
          Sobram {formatQty(validacao.volta_ao_estoque, unidade)}, que voltam para o
          estoque e viram o próximo lote aberto.
        </p>
      )}
      {validacao.volta_ao_estoque === 0 && totalQty < validacao.espaco_livre && (
        <p className="text-xs text-gray-500 mt-2">
          Ainda dá para escanear {formatQty(validacao.espaco_livre - totalQty, unidade)}.
        </p>
      )}
    </div>
  )

  return (
    <div className="p-4 max-w-lg mx-auto min-h-screen">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Transferência EC → EP</h1>
        <p className="text-sm text-gray-500 mt-0.5">Estoque Central para Estoque Produtivo</p>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1.5 mb-6">
        {STEPS_NORMAL.map((s, i) => (
          <div
            key={s}
            className={`h-1.5 rounded-full flex-1 transition-colors ${
              stepIndex > i ? 'bg-brand-600' : stepIndex === i ? 'bg-brand-300' : 'bg-gray-200'
            }`}
          />
        ))}
      </div>

      {/* ── Step 1: Scan lote ── */}
      {step === 'scan_lote' && (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-gray-900 mb-1">Passo 1: Escanear lote (EC)</h2>
          <p className="text-sm text-gray-500 mb-4">Aponte para o QR Code colado na embalagem no Estoque Central</p>
          {travaScan ? painelTrava : (
            <QRScanner
              onScan={qr => adicionarLote(qr)}
              label="Escanear QR do lote"
            />
          )}
          {scanError && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {scanError}
            </div>
          )}
        </Card>
      )}

      {/* ── Step scan_mais: escanear sublotes adicionais ── */}
      {step === 'scan_mais' && lote && (
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium mb-2">SUBLOTES ESCANEADOS</p>
            <div className="space-y-1.5 mb-3">
              {lotes.map(l => (
                <div key={l.id} className="flex justify-between text-sm">
                  <span className="font-mono text-gray-700">{l.codigo}</span>
                  <span className="text-gray-600">{formatQty(l.quantidade_disponivel, l.unidade)}</span>
                </div>
              ))}
            </div>
            <div className="pt-2 border-t border-gray-100 flex justify-between text-sm font-semibold">
              <span className="text-gray-700">Total acumulado</span>
              <span className="text-brand-700">{formatQty(totalQty, unidade)}</span>
            </div>
          </Card>

          {painelCabe}

          <Card className="p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Escanear mais lotes</h2>
            <p className="text-sm text-gray-500 mb-4">
              Escaneie outros lotes do mesmo insumo, ou continue para escanear o recipiente
            </p>
            {travaScan ? painelTrava : (
              /* Contínuo: aqui a pessoa junta vários sublotes seguidos, e
                 fechar a câmera a cada um dobrava o trabalho. O painel mostra
                 o que já entrou e o total acumulado sem sair da leitura. */
              <QRScanner
                onScan={qr => adicionarLote(qr)}
                continuo
                titulo={lote.insumo.nome}
                label={`${lotes.length} sublote${lotes.length === 1 ? '' : 's'} · ${formatQty(totalQty, unidade)}`}
                acaoConcluir={{
                  rotulo: rotuloDepoisDosLotes,
                  onClick: () => { setScanError(''); setStep(passoDepoisDosLotes) },
                }}
                painel={
                  <div>
                    {scanError && (
                      <p className="text-xs font-semibold text-red-700 mb-2">{scanError}</p>
                    )}
                    <div className="space-y-1">
                      {lotes.map(l => (
                        <div key={l.id} className="flex justify-between gap-2 text-xs">
                          <span className="font-mono text-emerald-700 font-semibold truncate">✓ {l.codigo}</span>
                          <span className="text-gray-500 shrink-0">
                            {formatQty(l.quantidade_disponivel, l.unidade)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between text-xs font-semibold">
                      <span className="text-gray-700">Total na mão</span>
                      <span className="text-brand-700">{formatQty(totalQty, unidade)}</span>
                    </div>
                  </div>
                }
              />
            )}
            {scanError && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {scanError}
              </div>
            )}
          </Card>

          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => { setScanError(''); setStep(passoDepoisDosLotes) }}
          >
            Continuar → {passoDepoisDosLotes === 'mover_embalagem'
              ? 'Mover para a produção'
              : 'Escanear recipiente'}
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={handleReset}>
            ← Recomeçar
          </Button>
        </div>
      )}

      {/* ── Step scan_local ── */}
      {step === 'scan_local' && lote && (
        <div className="space-y-4">
          {/* Lote(s) info */}
          <Card className="p-4">
            <p className="text-xs text-gray-500 font-medium mb-1">
              {lotes.length > 1 ? `${lotes.length} SUBLOTES SELECIONADOS` : 'LOTE SELECIONADO'}
            </p>
            <p className="font-semibold text-gray-900">{lote.insumo.nome}</p>
            {lotes.length === 1 ? (
              <>
                <p className="font-mono text-sm text-gray-600">{lote.codigo}</p>
                <div className="flex gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                  <span>Disponível: {formatQty(lote.quantidade_disponivel, lote.unidade)}</span>
                  <span>Validade: {formatDate(lote.validade_pos_abertura)}</span>
                </div>
              </>
            ) : (
              <div className="mt-1 space-y-0.5">
                {lotes.map(l => (
                  <div key={l.id} className="flex justify-between text-xs text-gray-500">
                    <span className="font-mono">{l.codigo}</span>
                    <span>{formatQty(l.quantidade_disponivel, l.unidade)}</span>
                  </div>
                ))}
                <p className="text-sm font-semibold text-brand-700 pt-1">
                  Total: {formatQty(totalQty, unidade)}
                </p>
              </div>
            )}
          </Card>

          {/* Veio de um recipiente que encheu no meio do caminho */}
          {sobras.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-sm">
              <p className="font-medium text-gray-900">O recipiente anterior encheu</p>
              <p className="text-xs text-gray-700 mt-1">
                Ainda está com {formatQty(totalQty, unidade)} na mão. Escaneie outro
                recipiente deste insumo, ou finalize e devolva ao estoque central.
              </p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={handleReset}>
                Finalizar e devolver ao estoque
              </Button>
            </div>
          )}

          {/* RO-003 error */}
          {ro003Error && (
            <div className="p-3 bg-red-50 border border-red-300 rounded-lg text-sm text-red-800">
              🚫 {ro003Error}
            </div>
          )}

          <Card className="p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-1">
              Passo {lotes.length > 1 || !precisaReembalagem(lote.insumo.codigo) ? '3' : '2'}: Escanear recipiente (EP)
            </h2>
            <p className="text-sm text-gray-500 mb-4">Aponte para o QR Code fixo no balde, caixa ou garrafa</p>
            <QRScanner
              onScan={handleScanLocal}
              titulo={lote.insumo.nome}
              label={`${formatQty(totalQty, unidade)} na mão · escaneie o recipiente`}
              painel={
                <div className="text-xs">
                  {scanError && !ro003Error && (
                    <p className="font-semibold text-red-700 mb-2">{scanError}</p>
                  )}
                  <p className="text-gray-600">
                    Procure um recipiente de <strong className="text-gray-900">{lote.insumo.nome}</strong>
                  </p>
                  <p className="text-gray-500 mt-1">
                    {lotes.length} sublote{lotes.length === 1 ? '' : 's'} · {formatQty(totalQty, unidade)}
                  </p>
                </div>
              }
            />
            {scanError && !ro003Error && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {scanError}
              </div>
            )}
          </Card>

          <Button variant="ghost" size="lg" fullWidth onClick={handleReset}>
            ← Recomeçar
          </Button>
        </div>
      )}

      {/* ── Step confirmar ── */}
      {step === 'confirmar' && lote && local && (
        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Confirmar transferência</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between py-2 border-b border-gray-100">
                <span className="text-gray-500">Insumo</span>
                <span className="font-medium">{lote.insumo.nome}</span>
              </div>

              {lotes.length === 1 ? (
                <>
                  <div className="flex justify-between py-2 border-b border-gray-100">
                    <span className="text-gray-500">Lote</span>
                    <span className="font-mono font-medium">{lote.codigo}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-gray-100">
                    <span className="text-gray-500">Quantidade</span>
                    <span className="font-bold">{formatQty(lote.quantidade_disponivel, lote.unidade)}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-gray-100">
                    <span className="text-gray-500">Validade</span>
                    <span className="font-medium">{formatDate(lote.validade_pos_abertura)}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="py-2 border-b border-gray-100">
                    <span className="text-gray-500 block mb-1">Sublotes ({lotes.length})</span>
                    <div className="space-y-1">
                      {lotes.map(l => (
                        <div key={l.id} className="flex justify-between text-xs">
                          <span className="font-mono text-gray-700">{l.codigo}</span>
                          <span className="text-gray-600">{formatQty(l.quantidade_disponivel, l.unidade)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between py-2 border-b border-gray-100">
                    <span className="text-gray-500">Total transferido</span>
                    <span className="font-bold text-brand-700">{formatQty(totalQty, unidade)}</span>
                  </div>
                </>
              )}

              <div className="flex justify-between py-2">
                <span className="text-gray-500">Destino (EP)</span>
                <span className="font-medium">{local.nome}</span>
              </div>

              {/* O recipiente pode ter sobra de outro lote: não é mais bloqueio,
                  mas o operador precisa saber que vai misturar. */}
              {(local.estado_atual?.quantidade ?? 0) > 0 && (
                <div className="rounded-lg bg-unno-amber/10 border border-unno-amber/30 px-3 py-2.5 mt-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                    Vai misturar com o que já está no recipiente
                  </p>
                  <p className="text-xs text-gray-600 dark:text-unno-muted mt-1">
                    Já tem{' '}
                    <strong>
                      {formatQty(local.estado_atual!.quantidade, local.estado_atual!.unidade ?? unidade)}
                    </strong>{' '}
                    de outro lote. A partir daqui, as produções que usarem este recipiente
                    ficam ligadas aos dois lotes — até ele ser marcado como esgotado.
                  </p>
                </div>
              )}
            </div>

            {/* Quanto realmente entra aqui: o recipiente enche até a capacidade
                e o que passar disso continua no estoque central. */}
            {(() => {
              const jaTem = local.estado_atual?.quantidade ?? 0
              const cap = local.capacidade_max
              const cabe = cap == null ? totalQty : Math.max(cap - jaTem, 0)
              const entra = Math.min(totalQty, cabe)
              const volta = totalQty - entra
              return (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
                  <p>
                    Vai entrar <strong>{formatQty(entra, unidade)}</strong>
                    {cap != null && <> — o recipiente comporta {formatQty(cap, unidade)}</>}.
                  </p>
                  {volta > 0 && (
                    <p>
                      Os outros <strong>{formatQty(volta, unidade)}</strong> continuam no
                      estoque central. Na tela seguinte dá para levá-los a outro recipiente.
                    </p>
                  )}
                  <p>Esta operação não pode ser desfeita.</p>
                </div>
              )
            })()}
          </Card>

          {scanError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {scanError}
            </div>
          )}

          <Button
            variant="danger"
            size="xl"
            fullWidth
            loading={loading}
            onClick={() => setShowConfirm(true)}
          >
            CONFIRMAR TRANSFERÊNCIA
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={handleReset}>
            ← Cancelar
          </Button>
        </div>
      )}

      {/* ── Mover a embalagem do fornecedor inteira ──
          Sem escolher recipiente: o pacote É o recipiente. A tela existe só
          para a pessoa conferir o que vai sair da prateleira antes de confirmar. */}
      {step === 'mover_embalagem' && lote && (
        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-1">
              Mover para a produção
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {lote.insumo.nome} fica na embalagem do fornecedor — ela mesma vira o
              ponto de consumo, com a etiqueta que já está colada. Não há recipiente
              para escanear.
            </p>

            <div className="text-sm">
              <div className="py-2 border-b border-gray-100">
                <span className="text-gray-500 block mb-1">
                  {lotes.length === 1 ? 'Pacote' : `Pacotes (${lotes.length})`}
                </span>
                <div className="space-y-1">
                  {lotes.map(l => (
                    <div key={l.id} className="flex justify-between text-xs">
                      <span className="font-mono text-gray-700">{l.codigo}</span>
                      <span className="text-gray-600">
                        {formatQty(l.quantidade_disponivel, l.unidade)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-gray-500">Total</span>
                <span className="font-bold text-brand-700">{formatQty(totalQty, unidade)}</span>
              </div>
            </div>

            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
              <p>
                Sai <strong>tudo</strong>: a embalagem vai inteira para a produção e
                deixa de constar no estoque central.
              </p>
              <p>
                Quando esvaziar, marque como esgotada na tela de Recipientes — ela
                some sozinha da lista.
              </p>
              <p>Esta operação não pode ser desfeita.</p>
            </div>
          </Card>

          {scanError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {scanError}
            </div>
          )}

          <Button
            variant="danger" size="xl" fullWidth loading={loading}
            onClick={confirmarMoverEmbalagem}
          >
            CONFIRMAR — {lotes.length === 1 ? 'MOVER PACOTE' : `MOVER ${lotes.length} PACOTES`}
          </Button>
          <Button variant="ghost" size="lg" fullWidth onClick={handleReset}>
            ← Cancelar
          </Button>
        </div>
      )}

      {/* ── Reembalagem steps ── */}
      {step === 'reembalagem' && lote && local && (
        <>
          {precisaDestinoMultiplo(lote.insumo.codigo) && (
            <ReembalagemDDL lote={lote} local={local} onSuccess={handleReset} onCancel={handleReset} />
          )}
          {lote.insumo.codigo === 'INS027' && (
            <ReembalagemNutella lote={lote} local={local} onSuccess={handleReset} onCancel={handleReset} />
          )}
          {lote.insumo.codigo === 'INS023' && (
            <ReembalagemStikadinho lote={lote} local={local} onSuccess={handleReset} onCancel={handleReset} />
          )}
        </>
      )}

      {/* ── Success ── */}
      {step === 'sucesso' && (
        <Card className="p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-1">Transferência concluída!</h2>
          {sucesso && sucesso.codigos.length > 0 && (
            <div className="mb-4 space-y-0.5">
              {sucesso.codigos.map(c => (
                <p key={c} className="font-mono text-sm text-gray-500">{c}</p>
              ))}
            </div>
          )}
          <p className="text-sm text-gray-500 mb-6">
            {sucesso && sucesso.codigos.length > 1
              ? `${sucesso.codigos.length} sublotes foram baixados do EC e registrados no EP.`
              : 'O lote foi baixado do EC e registrado no EP.'}
          </p>
          <Button size="xl" fullWidth onClick={handleReset}>
            Nova transferência
          </Button>
        </Card>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        open={showConfirm}
        title={travaAviso ? 'Contrariar a regra?' : 'Confirmar transferência?'}
        description={travaAviso?.mensagem}
        variant="danger"
        confirmLabel={travaAviso ? 'CONFIRMAR MESMO ASSIM' : 'CONFIRMAR'}
        loading={loading}
        justificativa={
          travaAviso
            ? { valor: justificativa, onChange: setJustificativa }
            : undefined
        }
        summary={
          lote && local ? (
            <div className="space-y-1">
              <p><strong>{lote.insumo.nome}</strong></p>
              {lotes.length > 1 ? (
                <p>{lotes.length} sublotes · {formatQty(totalQty, unidade)} → {local.nome}</p>
              ) : (
                <p>{lote.codigo} · {formatQty(lote.quantidade_disponivel, lote.unidade)} → {local.nome}</p>
              )}
            </div>
          ) : undefined
        }
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

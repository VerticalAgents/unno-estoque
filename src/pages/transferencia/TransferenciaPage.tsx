import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Lote, Local } from '../../types/database.types'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { formatDate, formatQty, precisaReembalagem, precisaDestinoMultiplo } from '../../lib/utils'
import { parseQRLoteCodigo } from '../../lib/qr'
import { ReembalagemNutella } from './components/ReembalagemNutella'
import { ReembalagemStikadinho } from './components/ReembalagemStikadinho'
import { ReembalagemDDL } from './components/ReembalagemDDL'

type Step = 'scan_lote' | 'scan_mais' | 'scan_local' | 'confirmar' | 'reembalagem' | 'sucesso'

type LoteWithInsumo = Lote & {
  insumo: { nome: string; codigo: string; shelf_life_dias_pos_abertura: number | null; armazenamento_config?: { passa_reembalagem: boolean; destino_multiplo: boolean } }
  marca?: { nome: string } | null
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
  const [fifoWarning, setFifoWarning] = useState(false)
  const [ro003Error, setRo003Error] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [scanError, setScanError] = useState('')
  const [sucesso, setSucesso] = useState<{ codigos: string[] } | null>(null)

  // Alias for reembalagem compatibility
  const lote = lotes[0] ?? null

  // ── Helpers ───────────────────────────────────────────────

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

  // ── Step 1: scan primeiro sublote ────────────────────────

  async function handleScanLote(qr: string) {
    setScanError('')
    const { data: loteData } = await supabase
      .from('lotes')
      .select(`
        *,
        marca:marcas(nome),
        insumo:insumos(
          nome, codigo, shelf_life_dias_pos_abertura,
          armazenamento_config:insumos_armazenamento_config(passa_reembalagem, destino_multiplo)
        )
      `)
      .eq('codigo', parseQRLoteCodigo(qr))
      .eq('status', 'ativo')
      .single()

    if (!loteData) {
      setScanError(await erroLoteInativo(qr))
      return
    }

    const l = loteData as LoteWithInsumo

    // Check FIFO
    const { data: older } = await supabase
      .from('lotes')
      .select('data_recebimento')
      .eq('insumo_id', l.insumo_id)
      .eq('status', 'ativo')
      .lt('data_recebimento', l.data_recebimento)
      .limit(1)

    if (older && older.length > 0) {
      setFifoWarning(true)
    }

    setLotes([l])

    // Insumos com reembalagem pulam o fluxo multi-sublote
    if (precisaReembalagem(l.insumo.codigo)) {
      setStep('scan_local')
    } else {
      setStep('scan_mais')
    }
  }

  // ── Step scan_mais: escanear sublotes adicionais ──────────

  async function handleScanMais(qr: string) {
    setScanError('')

    const { data: loteData } = await supabase
      .from('lotes')
      .select(`
        *,
        marca:marcas(nome),
        insumo:insumos(
          nome, codigo, shelf_life_dias_pos_abertura,
          armazenamento_config:insumos_armazenamento_config(passa_reembalagem, destino_multiplo)
        )
      `)
      .eq('codigo', parseQRLoteCodigo(qr))
      .eq('status', 'ativo')
      .single()

    if (!loteData) {
      setScanError(await erroLoteInativo(qr))
      return
    }

    const novo = loteData as LoteWithInsumo

    if (lotes.some(l => l.id === novo.id)) {
      setScanError('Sublote já adicionado.')
      return
    }

    if (novo.lote_grupo_id !== lotes[0]?.lote_grupo_id) {
      setScanError('Este sublote pertence a um recebimento diferente.')
      return
    }

    setLotes(prev => [...prev, novo])
    setScanError('')
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
      .eq('qr_code_fixo', qr)
      .eq('ativo', true)
      .single()

    if (!localData) {
      setScanError(`Recipiente não encontrado: ${qr}`)
      return
    }

    const loc = localData as LocalWithInsumo

    // RO-003: recipiente deve estar vazio ou ter o mesmo lote
    const estadoRaw = loc.estado_atual as unknown
    const estadoArray = Array.isArray(estadoRaw) ? estadoRaw as Array<{ quantidade: number; lote_id?: string; unidade?: string }> : null
    const estado = estadoArray ? estadoArray[0] : (estadoRaw as { quantidade: number; lote_id?: string; unidade?: string } | undefined)
    if (estado && estado.quantidade > 0 && estado.lote_id && estado.lote_id !== lote?.id) {
      setRo003Error(
        `REGRA DE OURO VIOLADA (RO-003): este recipiente já tem um lote ativo (${estado.quantidade} ${estado.unidade ?? ''} restantes). Zere o recipiente antes de abastecer com novo lote.`
      )
      return
    }

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
    })

    setLoading(false)
    setShowConfirm(false)

    if (error || !(data as { ok: boolean })?.ok) {
      setScanError((data as { erro?: string })?.erro ?? error?.message ?? 'Erro na transferência.')
      setStep('confirmar')
      return
    }

    const codigos = (data as { codigos?: string[]; codigo?: string })?.codigos
      ?? [(data as { codigo?: string })?.codigo ?? '']

    setSucesso({ codigos })
    setStep('sucesso')
  }

  function handleReset() {
    setStep('scan_lote')
    setLotes([])
    setLocal(null)
    setFifoWarning(false)
    setRo003Error('')
    setScanError('')
    setSucesso(null)
    setShowConfirm(false)
  }

  const totalQty = lotes.reduce((acc, l) => acc + (l.quantidade_disponivel ?? 0), 0)
  const unidade = lotes[0]?.unidade ?? ''

  // ── Render ────────────────────────────────────────────────

  const STEPS_NORMAL: Step[] = ['scan_lote', 'scan_mais', 'scan_local', 'confirmar']
  const stepIndex = STEPS_NORMAL.indexOf(step)

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
          <QRScanner
            onScan={handleScanLote}
            label="Escanear QR do lote"
          />
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

          {/* FIFO warning */}
          {fifoWarning && (
            <div className="p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800">
              ⚠️ <strong>Atenção (FIFO):</strong> Existe um lote mais antigo deste insumo disponível. Use o lote mais antigo primeiro.
            </div>
          )}

          <Card className="p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Escanear mais sublotes</h2>
            <p className="text-sm text-gray-500 mb-4">
              Escaneie outros sublotes do mesmo recebimento, ou continue para escanear o recipiente
            </p>
            <QRScanner
              onScan={handleScanMais}
              label="Escanear sublote adicional"
            />
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
            onClick={() => { setScanError(''); setStep('scan_local') }}
          >
            Continuar → Escanear recipiente
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

          {/* FIFO warning (reembalagem flow) */}
          {fifoWarning && (
            <div className="p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800">
              ⚠️ <strong>Atenção (FIFO):</strong> Existe um lote mais antigo deste insumo disponível. Use o lote mais antigo primeiro.
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
              label="Escanear QR do recipiente EP"
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
            </div>

            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <strong>RO-002:</strong> {lotes.length > 1
                ? `Os ${lotes.length} sublotes (${formatQty(totalQty, unidade)} no total) serão transferidos de uma vez.`
                : `A embalagem inteira (${formatQty(lote.quantidade_disponivel, lote.unidade)}) será transferida de uma vez.`
              } Esta operação não pode ser desfeita.
            </div>
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
        title="Confirmar transferência?"
        variant="danger"
        confirmLabel="CONFIRMAR"
        loading={loading}
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

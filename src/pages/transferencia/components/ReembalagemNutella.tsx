import { useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../contexts/AuthContext'
import type { Lote, Local } from '../../../types/database.types'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { ConfirmModal } from '../../../components/ui/ConfirmModal'
import { calcSacos, formatDate } from '../../../lib/utils'

interface Props {
  lote: Lote & { insumo: { nome: string; codigo: string } }
  local: Local
  onSuccess: () => void
  onCancel: () => void
}

export function ReembalagemNutella({ lote, local, onSuccess, onCancel }: Props) {
  const { profile } = useAuth()
  const totalKg = lote.quantidade_disponivel
  const { qtd: sugestao } = calcSacos(totalKg, 625)

  const [qtdSacos, setQtdSacos] = useState(sugestao)
  const [registrarSobra, setRegistrarSobra] = useState(true)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const sobraAtual = totalKg * 1000 - qtdSacos * 625

  async function handleConfirmar() {
    if (!profile) return
    setLoading(true)
    setError('')

    const { data, error: err } = await supabase.rpc('realizar_reembalagem', {
      p_lote_id:          lote.id,
      p_tipo_resultado:   'saco_confeitar',
      p_tamanho_porcao:   625,
      p_qtd_unidades:     qtdSacos,
      p_quantidade_total: qtdSacos * 625 + (registrarSobra ? 0 : sobraAtual),
      p_responsavel_id:   profile.id,
      p_empresa_id:       profile.empresa_id,
      p_local_destino_id: local.id,
    })

    setLoading(false)
    if (err || !(data as { ok: boolean })?.ok) {
      setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro')
      setShowConfirm(false)
      return
    }
    onSuccess()
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Reembalagem — Nutella</h2>
        <p className="text-sm text-gray-500 mb-4">Porcionar em sacos de confeitar de 625g</p>

        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 mb-4">
          <p><strong>Balde:</strong> {lote.codigo} · {totalKg} kg = {(totalKg * 1000).toFixed(0)} g</p>
          <p><strong>Validade:</strong> {formatDate(lote.validade_pos_abertura)}</p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Número de sacos de 625g</label>
            <div className="flex items-center gap-3 mt-1">
              <button
                onClick={() => setQtdSacos(Math.max(1, qtdSacos - 1))}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-lg font-bold hover:bg-gray-50"
              >−</button>
              <span className="text-2xl font-bold w-12 text-center">{qtdSacos}</span>
              <button
                onClick={() => setQtdSacos(qtdSacos + 1)}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-lg font-bold hover:bg-gray-50"
              >+</button>
            </div>
          </div>

          <div className={`p-3 rounded-lg border text-sm ${sobraAtual > 0 ? 'bg-yellow-50 border-yellow-200 text-yellow-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
            <p><strong>Total porcionado:</strong> {qtdSacos * 625} g</p>
            <p><strong>Sobra:</strong> {sobraAtual.toFixed(0)} g</p>
          </div>

          {sobraAtual > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={registrarSobra}
                onChange={(e) => setRegistrarSobra(e.target.checked)}
                className="rounded"
              />
              Registrar {sobraAtual.toFixed(0)}g de sobra como perda
            </label>
          )}

          <p className="text-xs text-gray-400">Destino: {local.nome}</p>
        </div>
      </Card>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      <Button variant="danger" size="xl" fullWidth onClick={() => setShowConfirm(true)}>
        CONFIRMAR REEMBALAGEM
      </Button>
      <Button variant="ghost" size="lg" fullWidth onClick={onCancel}>← Cancelar</Button>

      <ConfirmModal
        open={showConfirm}
        title="Confirmar reembalagem?"
        variant="danger"
        confirmLabel="CONFIRMAR"
        loading={loading}
        summary={
          <div className="space-y-1">
            <p>Nutella {lote.codigo} → <strong>{qtdSacos} sacos × 625g</strong></p>
            {sobraAtual > 0 && <p>Sobra de {sobraAtual.toFixed(0)}g {registrarSobra ? '→ registrada como perda' : '→ não registrada'}</p>}
          </div>
        }
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

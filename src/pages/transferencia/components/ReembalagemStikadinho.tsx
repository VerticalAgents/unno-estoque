import { useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../contexts/AuthContext'
import type { Lote, Local } from '../../../types/database.types'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { ConfirmModal } from '../../../components/ui/ConfirmModal'

interface Props {
  lote: Lote & { insumo: { nome: string; codigo: string } }
  local: Local
  onSuccess: () => void
  onCancel: () => void
}

export function ReembalagemStikadinho({ lote, local, onSuccess, onCancel }: Props) {
  const { profile } = useAuth()
  const totalG = lote.quantidade_disponivel // already in g for Stikadinho
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleConfirmar() {
    if (!profile) return
    setLoading(true)

    const { data, error: err } = await supabase.rpc('realizar_reembalagem', {
      p_lote_id:          lote.id,
      p_tipo_resultado:   'porcionamento',
      p_tamanho_porcao:   null,
      p_qtd_unidades:     1,
      p_quantidade_total: totalG,
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
        <h2 className="text-base font-semibold text-gray-900 mb-1">Reembalagem — Stikadinho</h2>
        <p className="text-sm text-gray-500 mb-4">Abertura e corte do display antes de ir ao balde</p>

        <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-800 space-y-1">
          <p><strong>Display:</strong> {lote.codigo}</p>
          <p><strong>Conteúdo:</strong> {totalG}g (~32 barras de 12,3g)</p>
          <p><strong>Destino:</strong> {local.nome}</p>
        </div>

        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
          Abra todas as 32 barras e corte-as antes de confirmar. O conteúdo inteiro do display irá ao balde.
        </div>
      </Card>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      <Button variant="danger" size="xl" fullWidth onClick={() => setShowConfirm(true)}>
        CONFIRMAR ABERTURA E CORTE
      </Button>
      <Button variant="ghost" size="lg" fullWidth onClick={onCancel}>← Cancelar</Button>

      <ConfirmModal
        open={showConfirm}
        title="Confirmar corte do Stikadinho?"
        variant="danger"
        confirmLabel="CONFIRMAR"
        loading={loading}
        description="As barras já foram abertas e cortadas?"
        summary={<p>{totalG}g → balde {local.nome}</p>}
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

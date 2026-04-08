import { useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../contexts/AuthContext'
import type { Lote, Local } from '../../../types/database.types'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Input } from '../../../components/ui/Input'
import { ConfirmModal } from '../../../components/ui/ConfirmModal'
import { calcSacos, formatDate, formatQty } from '../../../lib/utils'

interface Props {
  lote: Lote & { insumo: { nome: string; codigo: string } }
  local: Local
  onSuccess: () => void
  onCancel: () => void
}

export function ReembalagemDDL({ lote, local, onSuccess, onCancel }: Props) {
  const { profile } = useAuth()
  const total = lote.quantidade_disponivel // kg

  const [kgMassa, setKgMassa] = useState('')
  const [kgTopping, setKgTopping] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const kgM = parseFloat(kgMassa) || 0
  const kgT = parseFloat(kgTopping) || 0
  const soma = kgM + kgT
  const diff = Math.abs(soma - total)
  const valid = diff < 0.001 && kgM >= 0 && kgT >= 0

  const { qtd: qtdSacos, sobra } = calcSacos(kgT, 600)

  async function handleConfirmar() {
    if (!profile || !valid) return
    setLoading(true)
    setError('')

    // 1. Transfer massa to balde
    if (kgM > 0) {
      const { data: t } = await supabase.rpc('realizar_transferencia', {
        p_lote_id:        lote.id,
        p_local_id:       local.id,
        p_quantidade:     kgM,
        p_responsavel_id: profile.id,
        p_empresa_id:     profile.empresa_id,
      })
      if (!(t as { ok: boolean })?.ok) {
        setError((t as { erro?: string })?.erro ?? 'Erro na transferência para balde de massa.')
        setLoading(false)
        setShowConfirm(false)
        return
      }
    }

    // 2. Reembalagem topping → sacos de confeitar
    if (kgT > 0 && qtdSacos > 0) {
      const { data: r } = await supabase.rpc('realizar_reembalagem', {
        p_lote_id:          lote.id,
        p_tipo_resultado:   'saco_confeitar',
        p_tamanho_porcao:   600,
        p_qtd_unidades:     qtdSacos,
        p_quantidade_total: kgT * 1000,
        p_responsavel_id:   profile.id,
        p_empresa_id:       profile.empresa_id,
        p_local_destino_id: null,
      })
      if (!(r as { ok: boolean })?.ok) {
        setError((r as { erro?: string })?.erro ?? 'Erro na reembalagem topping.')
        setLoading(false)
        setShowConfirm(false)
        return
      }
    }

    setLoading(false)
    onSuccess()
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Doce de Leite — Destino Duplo</h2>
        <p className="text-sm text-gray-500 mb-4">
          O balde de {formatQty(total, lote.unidade)} vai para dois destinos. Distribua a quantidade entre eles.
        </p>

        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 mb-4">
          <p><strong>Lote:</strong> {lote.codigo} · Total: {formatQty(total, 'kg')}</p>
          <p><strong>Validade:</strong> {formatDate(lote.validade_pos_abertura)}</p>
        </div>

        <div className="space-y-3">
          <Input
            label="Para balde de massa (kg)"
            type="number" step="0.001" min="0"
            value={kgMassa}
            onChange={(e) => setKgMassa(e.target.value)}
            placeholder="0.000"
          />
          <Input
            label="Para sacos de confeitar — topping (kg)"
            type="number" step="0.001" min="0"
            value={kgTopping}
            onChange={(e) => setKgTopping(e.target.value)}
            placeholder="0.000"
          />

          {/* Running total */}
          <div className={`p-3 rounded-lg border text-sm ${valid ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-yellow-50 border-yellow-200 text-yellow-800'}`}>
            <p>Total: {soma.toFixed(3)} kg / {total} kg</p>
            {!valid && soma > 0 && <p>Faltam {(total - soma).toFixed(3)} kg para fechar RO-002</p>}
            {valid && <p>✓ Soma fecha corretamente</p>}
            {kgT > 0 && <p className="mt-1">Topping → {qtdSacos} saco(s) × 600g {sobra > 0 ? `+ ${sobra.toFixed(0)}g sobra` : ''}</p>}
          </div>
        </div>
      </Card>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      <Button variant="danger" size="xl" fullWidth disabled={!valid} onClick={() => setShowConfirm(true)}>
        CONFIRMAR DISTRIBUIÇÃO
      </Button>
      <Button variant="ghost" size="lg" fullWidth onClick={onCancel}>← Cancelar</Button>

      <ConfirmModal
        open={showConfirm}
        title="Confirmar distribuição DDL?"
        variant="danger"
        confirmLabel="CONFIRMAR"
        loading={loading}
        summary={
          <div className="space-y-1">
            {kgM > 0 && <p>→ Balde de massa: {formatQty(kgM, 'kg')}</p>}
            {kgT > 0 && <p>→ Topping: {formatQty(kgT, 'kg')} = {qtdSacos} sacos de 600g{sobra > 0 ? ` + ${sobra.toFixed(0)}g sobra` : ''}</p>}
          </div>
        }
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

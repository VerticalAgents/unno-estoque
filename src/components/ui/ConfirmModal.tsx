import type { ReactNode } from 'react'
import { Button } from './Button'

interface ConfirmModalProps {
  open: boolean
  title: string
  description?: string
  summary?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  loading?: boolean
  /** Quando true, exige uma observação escrita antes de liberar o botão de
   *  confirmar. Usado pelas travas em modo "avisa": a ação passa, mas fica
   *  registrado por que a regra foi contrariada. */
  justificativa?: {
    valor: string
    onChange: (v: string) => void
    label?: string
  }
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  open,
  title,
  description,
  summary,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'default',
  loading = false,
  justificativa,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null

  const faltaJustificar = !!justificativa && justificativa.valor.trim().length < 5

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-white dark:bg-[#12121a] rounded-2xl shadow-xl z-10">
        {/* Icon */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-gray-100 dark:border-[#1a1a24]">
          {variant === 'danger' ? (
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
          ) : (
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-brand-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          )}
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
            {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
          </div>
        </div>

        {/* Summary */}
        {summary && (
          <div className="px-6 py-4 bg-gray-50 dark:bg-[#0a0a0f] border-b border-gray-100 dark:border-[#1a1a24] text-sm text-gray-700 dark:text-gray-300 space-y-1">
            {summary}
          </div>
        )}

        {/* Justificativa obrigatória (travas em modo avisa) */}
        {justificativa && (
          <div className="px-6 py-4 border-b border-gray-100 dark:border-white/[.08]">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
              {justificativa.label ?? 'Por que está fazendo isso?'}
            </label>
            <textarea
              autoFocus
              rows={2}
              value={justificativa.valor}
              onChange={e => justificativa.onChange(e.target.value)}
              placeholder="Ex: o lote antigo estava no fundo, sem acesso durante a produção"
              className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                         dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
            />
            <p className="text-[0.7rem] text-gray-400 dark:text-unno-dim mt-1">
              Fica registrado no histórico de exceções, com seu nome e a data.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 px-6 py-4">
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            size="lg"
            fullWidth
            loading={loading}
            disabled={faltaJustificar}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

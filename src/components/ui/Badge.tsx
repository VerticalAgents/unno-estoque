import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-yellow-100 text-yellow-700',
  danger:  'bg-red-100 text-red-700',
  info:    'bg-blue-100 text-blue-700',
  purple:  'bg-purple-100 text-purple-700',
}

interface BadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]} ${className}`}>
      {children}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, BadgeVariant> = {
    ativo:                 'success',
    esgotado:              'default',
    descartado:            'danger',
    vencido:               'danger',
    planejada:             'info',
    aberta:                'warning',
    fechada:               'success',
    cancelada:             'danger',
    no_estoque_central:    'info',
    no_estoque_produtivo:  'success',
    esgotada:              'default',
    descartada:            'danger',
  }
  const labels: Record<string, string> = {
    ativo:                 'Ativo',
    esgotado:              'Esgotado',
    descartado:            'Descartado',
    vencido:               'Vencido',
    planejada:             'Planejada',
    aberta:                'Aberta',
    fechada:               'Fechada',
    cancelada:             'Cancelada',
    no_estoque_central:    'EC',
    no_estoque_produtivo:  'EP',
    esgotada:              'Esgotada',
    descartada:            'Descartada',
  }
  return <Badge variant={map[status] ?? 'default'}>{labels[status] ?? status}</Badge>
}

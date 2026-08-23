import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'

// Espelha .tag-* do unno-design-system.html: fundo tingido + borda da
// mesma cor, texto em maiúsculas.
const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-areia-200 text-areia-700 border border-areia-300 dark:bg-white/[.04] dark:text-unno-muted dark:border-white/[.08]',
  success: 'bg-emerald-500/[.12] text-emerald-700 border border-emerald-500/20 dark:text-emerald-400',
  warning: 'bg-unno-amber/[.12] text-amber-700 border border-unno-amber/20 dark:text-unno-amber',
  danger:  'bg-unno-danger/[.12] text-red-700 border border-unno-danger/20 dark:text-unno-danger',
  info:    'bg-blue-500/[.12] text-blue-700 border border-blue-500/20 dark:text-blue-400',
  purple:  'bg-purple-500/[.12] text-purple-700 border border-purple-500/20 dark:text-purple-400',
}

interface BadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[0.7rem] font-semibold uppercase tracking-wide ${variantClasses[variant]} ${className}`}>
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

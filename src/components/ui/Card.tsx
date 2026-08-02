import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  accent?: string // hex color for left border
}

export function Card({ children, className = '', onClick, accent }: CardProps) {
  return (
    <div
      onClick={onClick}
      style={accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : undefined}
      className={[
        // .glass-card do design system: no escuro é vidro fosco sobre o fundo;
        // no claro segue cartão branco, para não prejudicar a leitura na cozinha.
        'rounded-2xl border transition-all duration-500 ease-out-expo',
        'bg-white border-gray-200 shadow-sm',
        'dark:bg-white/[.04] dark:border-white/10 dark:backdrop-blur-xl dark:shadow-none',
        accent ? 'border-l-4' : '',
        onClick
          ? 'cursor-pointer hover:-translate-y-1.5 hover:shadow-lg dark:hover:border-white/[.15] dark:hover:bg-white/[.06]'
          : '',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

interface CardHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export function CardHeader({ title, subtitle, action }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-gray-100 dark:border-[#1a1a24]">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 ml-3">{action}</div>}
    </div>
  )
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>
}

export function StatCard({
  label,
  value,
  sub,
  color = 'gray',
  accent,
}: {
  label: string
  value: string | number
  sub?: string
  color?: 'gray' | 'red' | 'yellow' | 'green' | 'blue'
  accent?: string
}) {
  const colorMap = {
    gray:   'text-gray-900',
    red:    'text-red-600',
    yellow: 'text-yellow-600',
    green:  'text-emerald-600',
    blue:   'text-blue-600',
  }
  return (
    <Card accent={accent} className="p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colorMap[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </Card>
  )
}

import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'

/**
 * A etiqueta de estado.
 *
 * CADA VARIANTE DECLARA OS DOIS TEMAS. A versão anterior só tingia o fundo a
 * 12% e trocava a cor do texto no escuro — o que produzia vermelho-escuro sobre
 * vermelho-escuro num "Vencido", ilegível a um metro da tela. No escuro a
 * fórmula se inverte: fundo cheio e escuro, texto claro.
 *
 * O `dark:` daqui manda mais que a rede de segurança do `index.css`. Isso não
 * era verdade até o bloco legado ser rebaixado de `html.dark .x` para
 * `.dark .x`: com a especificidade antiga, uma regra genérica de lá vencia o
 * escuro declarado aqui, e o componente não mandava na própria cor.
 */
const variantClasses: Record<BadgeVariant, string> = {
  default:
    'bg-muted text-muted-foreground border border-border',
  success:
    'bg-emerald-100 text-emerald-800 border border-emerald-300 ' +
    'dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800',
  warning:
    'bg-amber-100 text-amber-900 border border-amber-300 ' +
    'dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800',
  danger:
    'bg-red-100 text-red-800 border border-red-300 ' +
    'dark:bg-red-950 dark:text-red-200 dark:border-red-800',
  info:
    'bg-blue-100 text-blue-800 border border-blue-400 ' +
    'dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800',
  purple:
    'bg-purple-100 text-purple-800 border border-purple-300 ' +
    'dark:bg-purple-950 dark:text-purple-200 dark:border-purple-800',
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

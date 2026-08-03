import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'
type Size = 'sm' | 'md' | 'lg' | 'xl'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  children: ReactNode
  fullWidth?: boolean
}

// Variantes espelhando .btn-primary / .btn-secondary / .btn-ghost do
// unno-design-system.html. No escuro o hover ganha o brilho teal (shadow-glow).
const variantClasses: Record<Variant, string> = {
  primary:   'bg-brand-500 text-white hover:bg-brand-600 hover:shadow-glow focus:ring-brand-500 disabled:bg-brand-300 dark:text-unno-bg dark:disabled:bg-brand-800',
  secondary: 'bg-transparent text-brand-600 border border-brand-500 hover:bg-brand-50 hover:shadow-glow-sm focus:ring-brand-500 dark:text-brand-400 dark:hover:bg-brand-500/10',
  danger:    'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 disabled:bg-red-300 dark:bg-unno-danger dark:hover:brightness-110',
  ghost:     'bg-transparent text-gray-600 border border-gray-300 hover:bg-gray-100 hover:border-gray-400 focus:ring-gray-400 dark:text-unno-muted dark:border-white/[.08] dark:hover:text-unno-text dark:hover:border-white/[.15] dark:hover:bg-white/[.03]',
  success:   'bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500',
}

// O design system usa maiúsculas com espaçamento entre letras, então os
// tamanhos ganham um pouco mais de respiro horizontal.
//
// No celular nenhum botão desce de 44px, que é o alvo mínimo recomendado por
// Apple e Google — mão molhada de produção não acerta 32px. Do `sm:` para
// cima (tela de 640px, onde há mouse) valem as alturas compactas.
const sizeClasses: Record<Size, string> = {
  sm:  'px-3.5 py-1.5 text-[0.7rem] min-h-[44px] sm:min-h-[32px]',
  md:  'px-5 py-2 text-xs min-h-[44px] sm:min-h-[40px]',
  lg:  'px-6 py-3 text-sm min-h-[48px]',
  xl:  'px-8 py-4 text-base min-h-[56px]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  children,
  fullWidth = false,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center gap-2 rounded font-display font-semibold',
        'uppercase tracking-[1.5px]',
        'focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[#0a0a0f]',
        // O "levantar" no hover é para mouse. Em tela de toque não existe
        // hover de verdade: o iOS aplica o estado ao tocar e o deixa grudado
        // até o próximo toque em outro lugar.
        'transition-all duration-300 ease-out-expo [@media(hover:hover)]:hover:-translate-y-0.5',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
    >
      {loading ? (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
        </svg>
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  )
}

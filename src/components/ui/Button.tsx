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

/**
 * PRIMARY É LARANJA, e essa é a mudança que importa.
 *
 * O verde da marca diz quem o sistema é; o laranja diz o que ele está pedindo
 * que você faça. Antes as duas coisas eram a mesma cor, e numa tela com o menu
 * verde aceso ao lado de um botão verde nada chamava mais atenção que o resto.
 *
 * `success` continua verde-esmeralda, separado do verde da marca de propósito:
 * "deu certo" e "é o Unno" não podem ser o mesmo sinal.
 *
 * A SUPERFÍCIE É TÁCTIL. Luz interna no topo, sombra interna embaixo, sombra de
 * contato fora — e ao pressionar a luz some e a sombra interna se aprofunda, em
 * 80ms. É o que faz o botão parecer afundar em vez de piscar.
 */
const variantClasses: Record<Variant, string> = {
  primary:
    'bg-acao-500 text-white shadow-botao hover:bg-acao-600 focus:ring-acao-500 ' +
    'active:shadow-botao-press disabled:bg-acao-200 disabled:shadow-none ' +
    'dark:disabled:bg-acao-900 dark:disabled:text-white/40',
  secondary:
    'bg-transparent text-brand-700 border border-brand-500/60 hover:bg-brand-50 hover:border-brand-500 ' +
    'focus:ring-brand-500 dark:text-brand-400 dark:hover:bg-brand-500/10 dark:border-brand-500/40',
  danger:
    'bg-red-600 text-white shadow-botao hover:bg-red-700 focus:ring-red-500 ' +
    'active:shadow-botao-press disabled:bg-red-300 disabled:shadow-none ' +
    'dark:bg-unno-danger dark:hover:brightness-110',
  ghost:
    'bg-transparent text-areia-600 border border-areia-300 hover:bg-areia-100 hover:border-areia-400 ' +
    'hover:text-areia-950 focus:ring-areia-400 ' +
    'dark:text-unno-muted dark:border-white/[.08] dark:hover:text-unno-text ' +
    'dark:hover:border-white/[.15] dark:hover:bg-white/[.04]',
  success:
    'bg-emerald-600 text-white shadow-botao hover:bg-emerald-700 focus:ring-emerald-500 ' +
    'active:shadow-botao-press',
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
        'inline-flex items-center justify-center gap-2 rounded-controle font-display font-semibold',
        'uppercase tracking-[1.5px]',
        'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-areia-100 dark:focus:ring-offset-unno-bg',
        // O "levantar" no hover é para mouse. Em tela de toque não existe
        // hover de verdade: o iOS aplica o estado ao tocar e o deixa grudado
        // até o próximo toque em outro lugar.
        'transition-all duration-200 ease-out-expo [@media(hover:hover)]:hover:-translate-y-0.5',
        // O afundar, esse vale para os dois: no toque é o retorno imediato de
        // que o dedo foi registrado.
        'active:translate-y-px active:duration-press',
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

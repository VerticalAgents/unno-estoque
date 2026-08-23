import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'critico'
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
 * PRIMARY É A MENTA DO TEMA, com texto escuro por cima.
 *
 * Menta é cor clara: texto branco sobre ela não se lê. O tema já diz isso em
 * `--primary-foreground` (#1e2723), e é o que a variante usa. No escuro o
 * próprio tema inverte o peso — primary vira verde-escuro (#006239) e o texto
 * por cima clareia — então a mesma classe serve nos dois, sem `dark:`.
 *
 * `critico` é laranja e não pertence ao tema. Existe para ação irreversível que
 * não é destruição: importar, aplicar, fechar em definitivo. Vermelho já é de
 * `danger`, e usar o mesmo tom para "apaga" e para "não dá para voltar" apaga a
 * diferença entre os dois.
 *
 * `success` continua esmeralda, separado da menta da marca: "deu certo" e "é o
 * Unno" não podem ser o mesmo sinal.
 */
const variantClasses: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground shadow-tema hover:brightness-95 focus:ring-ring ' +
    'active:shadow-botao-press disabled:opacity-50 disabled:shadow-none',
  critico:
    'bg-acao-500 text-white shadow-tema hover:bg-acao-600 focus:ring-acao-500 ' +
    'active:shadow-botao-press disabled:bg-acao-200 disabled:shadow-none',
  secondary:
    'bg-secondary text-secondary-foreground border border-border shadow-tema ' +
    'hover:bg-accent hover:text-accent-foreground focus:ring-ring',
  danger:
    'bg-destructive text-destructive-foreground shadow-tema hover:brightness-110 ' +
    'focus:ring-destructive active:shadow-botao-press disabled:opacity-50 disabled:shadow-none',
  ghost:
    'bg-transparent text-muted-foreground border border-border hover:bg-accent ' +
    'hover:text-accent-foreground focus:ring-ring',
  success:
    'bg-emerald-600 text-white shadow-tema hover:bg-emerald-700 focus:ring-emerald-500 ' +
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
        'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ground',
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

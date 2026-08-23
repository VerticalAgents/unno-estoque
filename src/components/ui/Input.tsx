import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react'

interface FieldWrapperProps {
  label?: string
  error?: string
  hint?: string
  required?: boolean
  children: ReactNode
}

export function FieldWrapper({ label, error, hint, required, children }: FieldWrapperProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-xs font-semibold uppercase tracking-wide text-areia-600 dark:text-unno-muted">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-areia-500 dark:text-unno-dim">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

// .input-field do design system: cantos 8px, foco verde com halo suave.
const inputBase =
  'block w-full rounded-controle border px-4 py-2.5 text-sm text-areia-950 placeholder-areia-400 ' +
  'focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10 ' +
  'disabled:bg-areia-100 disabled:text-areia-500 transition-[border-color,box-shadow] duration-200 ' +
  'dark:text-unno-text dark:placeholder-unno-dim dark:disabled:bg-unno-sunken dark:disabled:text-unno-dim'

const inputNormal = 'border-areia-300 bg-white shadow-[inset_0_1px_2px_#281e160f] dark:border-white/[.08] dark:bg-unno-sunken dark:shadow-none'
const inputError  = 'border-red-400 bg-red-50 dark:bg-red-950 dark:border-red-800'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export function Input({ label, error, hint, required, className = '', ...props }: InputProps) {
  return (
    <FieldWrapper label={label} error={error} hint={hint} required={required}>
      <input
        {...props}
        required={required}
        className={`${inputBase} ${error ? inputError : inputNormal} ${className}`}
      />
    </FieldWrapper>
  )
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

export function Textarea({ label, error, hint, required, className = '', ...props }: TextareaProps) {
  return (
    <FieldWrapper label={label} error={error} hint={hint} required={required}>
      <textarea
        {...props}
        required={required}
        rows={props.rows ?? 3}
        className={`${inputBase} resize-none ${error ? inputError : inputNormal} ${className}`}
      />
    </FieldWrapper>
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  children: ReactNode
}

export function Select({ label, error, hint, required, children, className = '', ...props }: SelectProps) {
  return (
    <FieldWrapper label={label} error={error} hint={hint} required={required}>
      <select
        {...props}
        required={required}
        className={`${inputBase} ${error ? inputError : inputNormal} ${className}`}
      >
        {children}
      </select>
    </FieldWrapper>
  )
}

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
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground/70">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

// .input-field do design system: cantos 8px, foco verde com halo suave.
const inputBase =
  'block w-full rounded-controle border px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground/50 ' +
  'focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-brand-400/25 ' +
  'disabled:bg-muted disabled:text-muted-foreground/60 transition-[border-color,box-shadow] duration-200 ' +
  ''

const inputNormal = 'border-border bg-input'
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

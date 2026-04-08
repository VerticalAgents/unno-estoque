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
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

const inputBase =
  'block w-full rounded-lg border px-3 py-2 text-sm text-gray-900 placeholder-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 ' +
  'disabled:bg-gray-50 disabled:text-gray-500 transition-colors ' +
  'dark:text-gray-100 dark:placeholder-gray-500 dark:disabled:bg-[#12121a] dark:disabled:text-gray-600'

const inputNormal = 'border-gray-300 bg-white dark:border-[#2a2a34] dark:bg-[#1a1a24]'
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

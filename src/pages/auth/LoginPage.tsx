import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { LogoUnno } from '../../components/ui/LogoUnno'
import { useAuth } from '../../contexts/AuthContext'

export function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Quando a sessão cai sozinha — acesso desativado, por exemplo — a pessoa
  // volta para cá sem saber por quê. Este é o único lugar onde dá para contar.
  const { motivoSaida, limparMotivoSaida } = useAuth()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    limparMotivoSaida()
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    if (authError) {
      setError(
        authError.message === 'Invalid login credentials'
          ? 'Email ou senha incorretos.'
          : authError.message
      )
      setLoading(false)
      return
    }

    navigate('/dashboard')
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-brand-50 to-emerald-50 dark:from-[#0a0a0f] dark:to-[#0a0a0f] flex items-center justify-center p-4">
      {/* Halos do design system (.hero-gradient-*) — só no escuro */}
      <div className="pointer-events-none absolute -top-32 -left-32 h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle,rgba(0,212,170,.35)_0%,transparent_70%)] blur-3xl opacity-0 dark:opacity-100" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-[500px] w-[500px] rounded-full bg-[radial-gradient(circle,rgba(245,166,35,.3)_0%,transparent_70%)] blur-3xl opacity-0 dark:opacity-100" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <LogoUnno className="inline-block w-16 h-16 mb-4" />
          <h1 className="font-display text-3xl font-extrabold uppercase tracking-[6px] text-gray-900 dark:text-unno-text">
            Unno
          </h1>
          <p className="text-gray-500 dark:text-unno-muted text-xs uppercase tracking-[2px] mt-2">
            Controle de Estoque
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-white/[.04] dark:backdrop-blur-xl">
          <h2 className="font-display text-lg font-semibold text-gray-900 dark:text-unno-text mb-5">Entrar</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              required
              autoComplete="email"
              autoFocus
            />
            <Input
              label="Senha"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />

            {motivoSaida && !error && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 dark:bg-unno-amber/10 dark:border-unno-amber/30 dark:text-unno-amber">
                {motivoSaida}
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 dark:bg-unno-danger/10 dark:border-unno-danger/30 dark:text-unno-danger">
                {error}
              </div>
            )}

            <Button type="submit" size="lg" fullWidth loading={loading}>
              Entrar
            </Button>
          </form>
        </div>

        <p className="text-center text-[0.7rem] uppercase tracking-[2px] text-gray-400 dark:text-unno-dim mt-6">
          Porto Alegre · RS
        </p>
      </div>
    </div>
  )
}

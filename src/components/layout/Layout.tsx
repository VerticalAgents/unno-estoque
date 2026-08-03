import { useState } from 'react'
import { Outlet, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { useDarkMode } from '../../hooks/useDarkMode'
import { canAccess } from '../../lib/permissions'

export function Layout() {
  const { user, profile, permissoes, loading } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const darkMode = useDarkMode()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#0a0a0f]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Carregando...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // Route guard: redirect to dashboard if user can't access current route
  if (profile && !canAccess(profile.papel, location.pathname, permissoes)) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    // h-screen (100vh) no celular conta a faixa que fica atrás da barra de
    // endereço: o rodapé da tela nasce cortado e pula quando a barra some.
    // 100dvh acompanha a altura que de fato sobra. O h-screen fica de
    // reserva para navegador antigo que não conheça dvh.
    <div className="flex h-screen h-[100dvh] overflow-hidden bg-gray-50 dark:bg-[#0a0a0f]">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onMenuToggle={() => setSidebarOpen(true)} darkMode={darkMode} />

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

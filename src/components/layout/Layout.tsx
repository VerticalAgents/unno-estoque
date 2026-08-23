import { useState } from 'react'
import { Outlet, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { BarraInferior } from './BarraInferior'
import { MenuInferior } from './MenuInferior'
import { useDarkMode } from '../../hooks/useDarkMode'
import { useMenuColapsado } from '../../hooks/useMenuColapsado'
import { canAccess } from '../../lib/permissions'

export function Layout() {
  const { user, profile, permissoes, loading } = useAuth()
  const [menuAberto, setMenuAberto] = useState(false)
  const darkMode = useDarkMode()
  const { colapsado, alternar } = useMenuColapsado()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-areia-100 dark:bg-unno-bg">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-areia-600 dark:text-unno-muted">Carregando...</p>
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
    // O fundo é areia e não branco: os blocos flutuantes precisam de um chão
    // mais escuro que eles para a sombra ter onde cair.
    <div className="flex h-screen h-[100dvh] overflow-hidden bg-areia-100 dark:bg-unno-bg">
      {/* Recolhido, o menu não é renderizado: quem navega é a tira do
          cabeçalho. Esconder por CSS deixaria os links no caminho do Tab. */}
      {!colapsado && <Sidebar onRecolher={alternar} />}

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header
          onMenuToggle={() => setMenuAberto(true)}
          darkMode={darkMode}
          colapsado={colapsado}
          onExpandir={alternar}
        />

        {/* A barra flutua por cima; a folga aqui é o que faz a rolagem
            terminar acima dela em vez de esconder o fim de cada tela. */}
        <main className="flex-1 overflow-y-auto espaco-barra-flutuante">
          <Outlet />
        </main>

        <BarraInferior onAbrirMenu={() => setMenuAberto(true)} />
      </div>

      <MenuInferior aberto={menuAberto} onFechar={() => setMenuAberto(false)} />
    </div>
  )
}

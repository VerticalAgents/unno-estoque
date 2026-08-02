import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'

interface HeaderProps {
  onMenuToggle: () => void
  darkMode: { isDark: boolean; toggle: () => void }
}

export function Header({ onMenuToggle, darkMode }: HeaderProps) {
  const { profile, logout } = useAuth()
  const navigate = useNavigate()
  const [showMenu, setShowMenu] = useState(false)

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  const papelLabels: Record<string, string> = {
    admin: 'Administrador',
    gestao: 'Gestão',
    producao: 'Produção',
    compras: 'Compras',
  }

  // .ds-nav do design system: barra translúcida com desfoque
  return (
    <header className="h-14 bg-white/80 dark:bg-unno-bg/70 backdrop-blur-xl border-b border-gray-200 dark:border-white/[.08] flex items-center justify-between px-4 shrink-0">
      {/* Mobile menu toggle */}
      <button
        onClick={onMenuToggle}
        className="lg:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[.03] text-gray-600 dark:text-unno-muted"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Logo (mobile) */}
      <div className="lg:hidden flex items-center gap-2">
        <span className="font-display text-sm font-extrabold uppercase tracking-[3px] text-brand-600 dark:text-brand-400">Unno</span>
        <span className="text-[0.65rem] uppercase tracking-[1.5px] text-gray-400 dark:text-unno-dim">Estoque</span>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        {/* Dark mode toggle */}
        <button
          onClick={darkMode.toggle}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[.03] text-gray-500 dark:text-gray-400 transition-colors"
          title={darkMode.isDark ? 'Modo claro' : 'Modo escuro'}
        >
          {darkMode.isDark ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          )}
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[.03] transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-brand-500/15 border border-brand-500/25 flex items-center justify-center">
              <span className="font-display text-xs font-bold text-brand-700 dark:text-brand-400">
                {profile?.nome?.[0]?.toUpperCase() ?? '?'}
              </span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-gray-900 dark:text-unno-text leading-none">{profile?.nome ?? '—'}</p>
              <p className="text-[0.65rem] uppercase tracking-[1px] text-gray-400 dark:text-unno-dim mt-0.5">
                {papelLabels[profile?.papel ?? ''] ?? profile?.papel}
              </p>
            </div>
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-unno-elevated border border-gray-200 dark:border-white/10 rounded-2xl shadow-lg dark:backdrop-blur-xl z-20 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-white/[.08]">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">{profile?.nome}</p>
                  <p className="text-xs text-gray-500 dark:text-unno-muted">{profile?.email}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-4 py-3 text-[0.7rem] font-semibold uppercase tracking-[1px] text-red-600 dark:text-unno-danger hover:bg-red-50 dark:hover:bg-unno-danger/10 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
                  </svg>
                  Sair
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

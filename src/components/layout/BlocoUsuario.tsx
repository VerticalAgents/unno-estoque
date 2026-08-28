import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

/**
 * Quem está usando o sistema, e como sair dele.
 *
 * Mora em dois lugares e é o mesmo componente nos dois: no rodapé do menu
 * lateral quando ele está aberto, e no canto do cabeçalho quando o menu está
 * recolhido. Duas cópias divergiriam no primeiro ajuste.
 *
 * A DIFERENÇA ENTRE OS DOIS É PARA ONDE O MENU ABRE. No rodapé do menu não há
 * espaço abaixo — abrir para baixo jogaria as opções para fora da tela.
 */

// Rótulos curtos: no rodapé do menu sobram uns 110px depois do avatar, da seta
// e do botão de tema. "Administrador" não cabe e vira "ADMINISTRA…", que informa
// menos que "Admin" e ainda parece defeito.
const PAPEIS: Record<string, string> = {
  admin: 'Admin',
  gestao: 'Gestão',
  producao: 'Produção',
  compras: 'Compras',
}

/** Só o primeiro nome. O nome inteiro está no painel que abre. */
const primeiroNome = (nome?: string) => (nome ?? '').trim().split(/\s+/)[0] || '—'

interface Props {
  darkMode: { isDark: boolean; toggle: () => void }
  /** No rodapé do menu lateral o painel sobe; no cabeçalho, desce. */
  paraCima?: boolean
  /** Ocupa a largura toda (menu lateral) ou só o necessário (cabeçalho). */
  largo?: boolean
  className?: string
}

export function BlocoUsuario({ darkMode, paraCima = false, largo = false, className = '' }: Props) {
  const { profile, logout } = useAuth()
  const navigate = useNavigate()
  const [aberto, setAberto] = useState(false)
  const caixa = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!aberto) return
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [aberto])

  async function sair() {
    await logout()
    navigate('/login')
  }

  return (
    <div className={`relative ${largo ? 'w-full' : ''} ${className}`} ref={caixa}>
      <div className={`flex items-center gap-1 ${largo ? 'w-full' : ''}`}>
        <button
          type="button"
          onClick={() => setAberto(a => !a)}
          // Em tela menor que 640px sobra só a inicial num círculo: sem rótulo,
          // ninguém adivinha que dali se sai do sistema. No celular a saída de
          // verdade é a do menu de baixo; aqui o rótulo é o mínimo.
          aria-label="Sua conta e sair"
          title="Sua conta"
          className={[
            'flex items-center gap-2 pl-1.5 pr-2 py-1.5 rounded-full min-w-0 h-10',
            'hover:bg-accent hover:text-accent-foreground transition-colors',
            largo ? 'flex-1' : '',
          ].join(' ')}
        >
          <span className="w-7 h-7 rounded-full bg-brand-400/20 border border-brand-400/30 flex items-center justify-center shrink-0">
            <span className="font-display text-xs font-bold text-brand-700 dark:text-brand-300">
              {profile?.nome?.[0]?.toUpperCase() ?? '?'}
            </span>
          </span>
          <span className="hidden sm:block text-left min-w-0">
            <span className="block text-sm font-medium text-foreground leading-none truncate">
              {primeiroNome(profile?.nome)}
            </span>
            <span className="block text-[0.65rem] uppercase tracking-[1px] text-muted-foreground mt-0.5 truncate">
              {PAPEIS[profile?.papel ?? ''] ?? profile?.papel}
            </span>
          </span>
          <svg
            className={['w-4 h-4 text-muted-foreground/60 shrink-0 ml-auto transition-transform duration-200',
                        aberto ? 'rotate-180' : ''].join(' ')}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Claro ou escuro fica ao lado do usuário: as duas coisas são "sobre
            mim", não sobre a página. */}
        <button
          onClick={darkMode.toggle}
          title={darkMode.isDark ? 'Modo claro' : 'Modo escuro'}
          aria-label={darkMode.isDark ? 'Modo claro' : 'Modo escuro'}
          className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center
                     text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
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
      </div>

      {aberto && (
        <div
          className={[
            'absolute right-0 z-30 w-52 overflow-hidden',
            paraCima ? 'bottom-full mb-2' : 'top-full mt-2',
            'rounded-bloco bg-popover border border-border shadow-bloco',
          ].join(' ')}
        >
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-medium text-foreground truncate">{profile?.nome}</p>
            <p className="text-xs text-muted-foreground truncate">{profile?.email}</p>
          </div>
          <button
            onClick={sair}
            className="w-full flex items-center gap-2 px-4 py-3 text-[0.7rem] font-semibold uppercase
                       tracking-[1px] text-destructive hover:bg-accent transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
            Sair
          </button>
        </div>
      )}
    </div>
  )
}

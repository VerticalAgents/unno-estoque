import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { canAccess } from '../../lib/permissions'
import {
  mainNavItems, estoqueItems, cadastrosItems,
  estoqueRoutes, cadastrosRoutes,
  type NavItem,
} from './Sidebar'

/**
 * O cabeçalho — e, quando o menu está recolhido, também a navegação.
 *
 * A ideia é do usuário: recolher o menu lateral não deve esconder para onde ir,
 * deve mudar a orientação. O que era coluna vira tira horizontal aqui em cima,
 * e a tela ganha os 240px de largura de volta. Num notebook de 13", numa tabela
 * de relatório, essa largura é a diferença entre ler e rolar para o lado.
 *
 * OS GRUPOS VIRAM MENUS SUSPENSOS. Estoque e Cadastros têm filhos; deitados na
 * horizontal eles ocupariam a tira inteira. Recolhidos num botão que abre para
 * baixo, ocupam um item cada.
 *
 * A TIRA ROLA e não quebra em duas linhas: cabeçalho que muda de altura conforme
 * a rota empurra o conteúdo da página para baixo a cada navegação.
 */

interface HeaderProps {
  onMenuToggle: () => void
  darkMode: { isDark: boolean; toggle: () => void }
  colapsado: boolean
  onExpandir: () => void
}

const CLASSE_ITEM =
  'flex items-center gap-2 px-3 h-9 rounded-controle text-[0.7rem] font-semibold uppercase ' +
  'tracking-[1px] whitespace-nowrap transition-all duration-200 ease-out-expo shrink-0'

const CLASSE_ATIVO =
  'bg-brand-500/12 text-brand-700 shadow-[inset_0_1px_0_#ffffffb3] ' +
  'dark:text-brand-400 dark:shadow-[inset_0_1px_0_#ffffff0f]'

const CLASSE_INATIVO =
  'text-areia-600 hover:bg-areia-100 hover:text-areia-950 ' +
  'dark:text-unno-muted dark:hover:bg-white/[.04] dark:hover:text-unno-text'

/** Um grupo (Estoque, Cadastros) recolhido num botão que abre para baixo. */
function GrupoSuspenso({
  rotulo, icone, itens, ativo,
}: {
  rotulo: string
  icone: React.ReactNode
  itens: NavItem[]
  ativo: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const location = useLocation()
  const caixa = useRef<HTMLDivElement>(null)

  // Fecha ao navegar: sem isto o menu fica aberto por cima da página nova.
  useEffect(() => { setAberto(false) }, [location.pathname])

  useEffect(() => {
    if (!aberto) return
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [aberto])

  return (
    <div className="relative shrink-0" ref={caixa}>
      <button
        type="button"
        onClick={() => setAberto(a => !a)}
        className={[CLASSE_ITEM, ativo ? CLASSE_ATIVO : CLASSE_INATIVO].join(' ')}
      >
        <span className={ativo ? 'text-brand-600 dark:text-brand-400' : 'text-areia-400 dark:text-unno-dim'}>
          {icone}
        </span>
        {rotulo}
        <svg
          className={['w-3.5 h-3.5 transition-transform duration-200', aberto ? 'rotate-180' : ''].join(' ')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {aberto && (
        <div className="absolute left-0 top-full mt-2 w-56 z-30 p-1.5 overflow-hidden
                        rounded-bloco bg-white border border-areia-200 shadow-bloco
                        dark:bg-unno-elevated dark:border-white/[.08] dark:shadow-tactil-escuro">
          {itens.map(item => {
            const aceso = location.pathname.startsWith(item.to)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={[
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-controle text-[0.7rem] font-semibold',
                  'uppercase tracking-[1px] transition-colors duration-200',
                  aceso ? CLASSE_ATIVO : CLASSE_INATIVO,
                ].join(' ')}
              >
                <span className={aceso ? 'text-brand-600 dark:text-brand-400' : 'text-areia-400 dark:text-unno-dim'}>
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Header({ onMenuToggle, darkMode, colapsado, onExpandir }: HeaderProps) {
  const { profile, logout, permissoes } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [showMenu, setShowMenu] = useState(false)
  const tira = useRef<HTMLDivElement>(null)

  const papel = profile?.papel ?? 'producao'
  const principais = mainNavItems.filter(i => canAccess(papel, i.to, permissoes))
  const doEstoque = estoqueItems.filter(i => canAccess(papel, i.to, permissoes))
  const deCadastros = cadastrosItems.filter(i => canAccess(papel, i.to, permissoes))
  const podeConfig = canAccess(papel, '/configuracoes', permissoes)
  const estoqueAtivo = estoqueRoutes.some(r => location.pathname.startsWith(r))
  const cadastrosAtivo = cadastrosRoutes.some(r => location.pathname.startsWith(r))

  // Traz o item aceso para dentro da vista: numa tira que rola, chegar numa
  // rota do fim do menu deixaria o indicador de posição fora da tela.
  useEffect(() => {
    if (!colapsado) return
    const aceso = tira.current?.querySelector('[data-aceso="sim"]')
    aceso?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [colapsado, location.pathname])

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

  return (
    <header className="shrink-0 px-3 pt-3">
      <div className="flex items-center gap-2 h-14 px-2.5 rounded-bloco
                      bg-white/85 backdrop-blur-xl border border-areia-200 shadow-bloco
                      dark:bg-unno-raised/85 dark:border-white/[.06] dark:shadow-tactil-escuro">

        {/* Abrir o menu de baixo — só no celular. */}
        <button
          onClick={onMenuToggle}
          aria-label="Abrir o menu"
          className="lg:hidden shrink-0 w-10 h-10 rounded-controle flex items-center justify-center
                     text-areia-600 hover:bg-areia-100 dark:text-unno-muted dark:hover:bg-white/[.04]"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Logo: sempre no celular; no computador só quando o menu está
            recolhido, senão apareceria duas vezes na mesma tela. */}
        <div className={[
          'flex items-center gap-2 shrink-0 pl-1',
          colapsado ? 'flex' : 'lg:hidden',
        ].join(' ')}>
          <div className="hidden lg:flex w-8 h-8 rounded-controle bg-brand-500 items-center justify-center shadow-botao">
            <span className="font-display text-white text-sm font-extrabold">U</span>
          </div>
          <span className="font-display text-sm font-extrabold uppercase tracking-[3px] text-brand-600 dark:text-brand-400 lg:hidden">
            Unno
          </span>
          <span className="text-[0.65rem] uppercase tracking-[1.5px] text-areia-500 dark:text-unno-dim lg:hidden">
            Estoque
          </span>
        </div>

        {/* Expandir de volta para coluna. */}
        {colapsado && (
          <button
            type="button"
            onClick={onExpandir}
            title="Abrir o menu lateral"
            aria-label="Abrir o menu lateral"
            className="hidden lg:flex shrink-0 w-9 h-9 rounded-controle items-center justify-center
                       text-areia-500 hover:text-areia-950 hover:bg-areia-100
                       dark:text-unno-dim dark:hover:text-unno-text dark:hover:bg-white/[.04]
                       transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 4.5l7.5 7.5-7.5 7.5M12.75 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )}

        {/* A navegação, deitada. Só existe no computador com o menu recolhido. */}
        {colapsado && (
          <nav
            ref={tira}
            className="hidden lg:flex items-center gap-1 flex-1 min-w-0 overflow-x-auto tira-rolavel
                       border-l border-areia-200 dark:border-white/[.06] pl-2 ml-1"
          >
            {principais.map(item => {
              const aceso = item.exact
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to) &&
                  !(item.exceto ?? []).some(p => location.pathname.startsWith(p))
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  data-aceso={aceso ? 'sim' : 'nao'}
                  className={[CLASSE_ITEM, aceso ? CLASSE_ATIVO : CLASSE_INATIVO].join(' ')}
                >
                  <span className={aceso ? 'text-brand-600 dark:text-brand-400' : 'text-areia-400 dark:text-unno-dim'}>
                    {item.icon}
                  </span>
                  {item.label}
                </NavLink>
              )
            })}

            {doEstoque.length > 0 && (
              <GrupoSuspenso
                rotulo="Estoque"
                ativo={estoqueAtivo}
                itens={doEstoque}
                icone={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                  </svg>
                }
              />
            )}

            {deCadastros.length > 0 && (
              <GrupoSuspenso
                rotulo="Cadastros"
                ativo={cadastrosAtivo}
                itens={deCadastros}
                icone={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                }
              />
            )}

            {podeConfig && (
              <NavLink
                to="/configuracoes"
                data-aceso={location.pathname.startsWith('/configuracoes') ? 'sim' : 'nao'}
                className={[
                  CLASSE_ITEM,
                  location.pathname.startsWith('/configuracoes') ? CLASSE_ATIVO : CLASSE_INATIVO,
                ].join(' ')}
              >
                <span className={location.pathname.startsWith('/configuracoes')
                  ? 'text-brand-600 dark:text-brand-400' : 'text-areia-400 dark:text-unno-dim'}>
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </span>
                Config
              </NavLink>
            )}
          </nav>
        )}

        <div className="flex items-center gap-1 ml-auto shrink-0">
          {/* Claro ou escuro */}
          <button
            onClick={darkMode.toggle}
            className="w-10 h-10 rounded-controle flex items-center justify-center
                       text-areia-500 hover:bg-areia-100 hover:text-areia-950
                       dark:text-unno-muted dark:hover:bg-white/[.04] dark:hover:text-unno-text
                       transition-colors"
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

          {/* Quem está usando */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-controle
                         hover:bg-areia-100 dark:hover:bg-white/[.04] transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-brand-500/15 border border-brand-500/25 flex items-center justify-center shrink-0">
                <span className="font-display text-xs font-bold text-brand-700 dark:text-brand-400">
                  {profile?.nome?.[0]?.toUpperCase() ?? '?'}
                </span>
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-sm font-medium text-areia-950 dark:text-unno-text leading-none whitespace-nowrap">
                  {profile?.nome ?? '—'}
                </p>
                <p className="text-[0.65rem] uppercase tracking-[1px] text-areia-500 dark:text-unno-dim mt-0.5 whitespace-nowrap">
                  {papelLabels[profile?.papel ?? ''] ?? profile?.papel}
                </p>
              </div>
              <svg className="w-4 h-4 text-areia-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-2 w-52 z-20 overflow-hidden
                                rounded-bloco bg-white border border-areia-200 shadow-bloco
                                dark:bg-unno-elevated dark:border-white/[.08] dark:shadow-tactil-escuro">
                  <div className="px-4 py-3 border-b border-areia-200 dark:border-white/[.06]">
                    <p className="text-sm font-medium text-areia-950 dark:text-unno-text">{profile?.nome}</p>
                    <p className="text-xs text-areia-500 dark:text-unno-muted">{profile?.email}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-4 py-3 text-[0.7rem] font-semibold uppercase
                               tracking-[1px] text-acao-700 hover:bg-acao-50
                               dark:text-unno-danger dark:hover:bg-unno-danger/10 transition-colors"
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
      </div>
    </header>
  )
}

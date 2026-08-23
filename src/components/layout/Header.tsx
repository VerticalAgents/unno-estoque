import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { canAccess } from '../../lib/permissions'
import { BlocoUsuario } from './BlocoUsuario'
import { LogoUnno } from '../ui/LogoUnno'
import {
  gruposNav, itemDashboard, itemConfiguracoes,
  grupoAceso, itemAceso,
  type GrupoNav,
} from './Sidebar'

/**
 * O cabeçalho — e, quando o menu está recolhido, também a navegação.
 *
 * A ideia é do usuário: recolher o menu lateral não deve esconder para onde ir,
 * deve mudar a orientação. O que era coluna vira tira horizontal aqui em cima,
 * e a tela ganha os 240px de largura de volta. Num notebook de 13", numa tabela
 * de relatório, essa largura é a diferença entre ler e rolar para o lado.
 *
 * SEIS ITENS, SEM ROLAGEM. Dashboard, os quatro grupos e Configurações. Os
 * dezenove destinos moram dentro dos grupos, que abrem para baixo — deitados por
 * extenso não caberiam, e cabeçalho que rola para o lado esconde metade do
 * caminho sem avisar que existe metade escondida.
 *
 * Também não quebra em duas linhas: cabeçalho que muda de altura conforme a rota
 * empurra o conteúdo da página para baixo a cada navegação.
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
  'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground'

/** Um grupo (Estoque, Cadastros) recolhido num botão que abre para baixo. */
function GrupoSuspenso({ grupo, ativo }: { grupo: GrupoNav; ativo: boolean }) {
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
        <span className={ativo ? 'text-brand-600 dark:text-brand-400' : 'text-muted-foreground/60'}>
          {grupo.icone}
        </span>
        {grupo.titulo}
        <svg
          className={['w-3.5 h-3.5 transition-transform duration-200', aberto ? 'rotate-180' : ''].join(' ')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {aberto && (
        <div className="absolute left-0 top-full mt-2 w-56 z-30 p-1.5 overflow-hidden
                        rounded-bloco bg-popover border border-border shadow-bloco">
          {grupo.itens.map(item => {
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
                <span className={aceso ? 'text-brand-600 dark:text-brand-400' : 'text-muted-foreground/60'}>
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
  const { profile, permissoes } = useAuth()
  const location = useLocation()
  const tira = useRef<HTMLDivElement>(null)

  const papel = profile?.papel ?? 'producao'
  const grupos = gruposNav
    .map(g => ({ ...g, itens: g.itens.filter(i => canAccess(papel, i.to, permissoes)) }))
    .filter(g => g.itens.length > 0)
  const mostrarDashboard = canAccess(papel, itemDashboard.to, permissoes)
  const mostrarConfig = canAccess(papel, itemConfiguracoes.to, permissoes)
  const configAcesa = location.pathname.startsWith(itemConfiguracoes.to)

  return (
    <header className={[
        'shrink-0 px-3 pt-3',
        // Com o menu aberto no computador ele nao tem funcao: a navegacao esta
        // na coluna e o usuario, no rodape dela. Barra vazia rouba altura da
        // tela para nao dizer nada.
        colapsado ? '' : 'lg:hidden',
      ].join(' ')}>
      <div className="flex items-center gap-2 h-14 px-2.5 rounded-bloco
                      bg-card border border-border shadow-bloco">

        {/* Abrir o menu de baixo — só no celular. */}
        <button
          onClick={onMenuToggle}
          aria-label="Abrir o menu"
          className="lg:hidden shrink-0 w-10 h-10 rounded-controle flex items-center justify-center
                     text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
          <LogoUnno className="hidden lg:block w-8 h-8" />
          <span className="font-display text-sm font-extrabold uppercase tracking-[3px] text-brand-600 dark:text-brand-400 lg:hidden">
            Unno
          </span>
          <span className="text-[0.65rem] uppercase tracking-[1.5px] text-muted-foreground/70 lg:hidden">
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
                       text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 4.5l7.5 7.5-7.5 7.5M12.75 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )}

        {/* A navegação, deitada. Só existe no computador com o menu recolhido.
            São seis itens — Dashboard, quatro grupos e Configurações — porque
            os dezenove destinos moram dentro dos grupos. Deitados por extenso
            eles não caberiam, e cabeçalho que rola para o lado esconde metade
            do caminho sem avisar que existe metade escondida. */}
        {colapsado && (
          <nav
            ref={tira}
            className="hidden lg:flex items-center gap-1 flex-1 min-w-0
                       border-l border-border pl-2 ml-1"
          >
            {mostrarDashboard && (
              <NavLink
                to={itemDashboard.to}
                className={[
                  CLASSE_ITEM,
                  itemAceso(itemDashboard, location.pathname) ? CLASSE_ATIVO : CLASSE_INATIVO,
                ].join(' ')}
              >
                <span className={itemAceso(itemDashboard, location.pathname)
                  ? 'text-brand-600 dark:text-brand-400' : 'text-muted-foreground/60'}>
                  {itemDashboard.icon}
                </span>
                {itemDashboard.label}
              </NavLink>
            )}

            {grupos.map(grupo => (
              <GrupoSuspenso
                key={grupo.chave}
                grupo={grupo}
                ativo={grupoAceso(grupo, location.pathname)}
              />
            ))}

            {mostrarConfig && (
              <NavLink
                to={itemConfiguracoes.to}
                className={[CLASSE_ITEM, configAcesa ? CLASSE_ATIVO : CLASSE_INATIVO].join(' ')}
              >
                <span className={configAcesa
                  ? 'text-brand-600 dark:text-brand-400' : 'text-muted-foreground/60'}>
                  {itemConfiguracoes.icon}
                </span>
                Config
              </NavLink>
            )}
          </nav>
        )}

        <BlocoUsuario darkMode={darkMode} className="ml-auto shrink-0" />
      </div>
    </header>
  )
}

import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { canAccess } from '../../lib/permissions'

/**
 * A barra de baixo do celular.
 *
 * O menu tem 19 itens atrás de um hambúrguer no alto da tela. Quem trabalha
 * em pé faz sempre as mesmas quatro coisas, e para cada uma pagava três
 * toques — abrir o menu, procurar na lista, tocar — com a mão esticada até
 * o topo do aparelho. Aqui elas ficam a um toque, na parte da tela que o
 * polegar alcança sem trocar a mão de posição.
 *
 * O hambúrguer continua existindo para o resto; é o que "Mais" abre.
 *
 * Some a partir de `lg`, onde a barra lateral já está sempre visível.
 */

type Item = { to: string; label: string; icone: JSX.Element }

/**
 * As quatro do dia a dia, escolhidas por quem usa: levar insumo para a
 * produção, receber mercadoria, contar prateleira e conferir o que tem.
 */
const ITENS: Item[] = [
  {
    to: '/transferencia',
    label: 'Transferir',
    icone: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    ),
  },
  {
    to: '/recebimento',
    label: 'Receber',
    icone: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 3.75H6.912a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H15M2.25 13.5h3.86a2.251 2.251 0 011.591.659l.182.182a2.251 2.251 0 001.591.659h2.052a2.252 2.252 0 001.591-.659l.182-.182a2.251 2.251 0 011.591-.659h3.86M12 3v8.25m0 0l-3-3m3 3l3-3" />
    ),
  },
  {
    to: '/contagem',
    label: 'Contagem',
    icone: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    ),
  },
  {
    to: '/estoque/insumos',
    label: 'Estoque',
    icone: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    ),
  },
]

export function BarraInferior({ onAbrirMenu }: { onAbrirMenu: () => void }) {
  const { profile, permissoes } = useAuth()
  const { pathname } = useLocation()

  // Um usuário da produção não vê Recebimento; a barra segue a mesma regra
  // do menu, senão oferece caminho que leva a "acesso negado".
  const visiveis = profile
    ? ITENS.filter(i => canAccess(profile.papel, i.to, permissoes))
    : []

  return (
    <nav
      className="lg:hidden shrink-0 border-t border-gray-200 dark:border-white/[.08]
                 bg-white/90 dark:bg-unno-bg/85 backdrop-blur-xl"
      // No iPhone sem botão físico, a faixa do gesto de home fica por cima
      // de tudo. Sem esta folga, o último item nasce embaixo do risquinho.
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-stretch">
        {visiveis.map(item => {
          const ativo = pathname === item.to || pathname.startsWith(item.to + '/')
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={[
                // min-w-0 é o que permite o item encolher: sem ele o rótulo
                // define a largura mínima, "TRANSFERIR" empurra os vizinhos
                // e o quinto item sai da tela num aparelho de 360px.
                'flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px]',
                'text-[0.55rem] font-semibold uppercase transition-colors',
                ativo
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-gray-400 dark:text-unno-dim',
              ].join(' ')}
            >
              <svg
                className="w-6 h-6 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={ativo ? 2 : 1.6}
              >
                {item.icone}
              </svg>
              <span className="w-full text-center truncate px-0.5">{item.label}</span>
            </NavLink>
          )
        })}

        <button
          onClick={onAbrirMenu}
          className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px]
                     text-[0.55rem] font-semibold uppercase
                     text-gray-400 dark:text-unno-dim"
        >
          <svg className="w-6 h-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
          <span className="w-full text-center truncate px-0.5">Mais</span>
        </button>
      </div>
    </nav>
  )
}

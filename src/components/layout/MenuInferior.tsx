import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { canAccess } from '../../lib/permissions'
import { mainNavItems, estoqueItems, cadastrosItems, type NavItem } from './Sidebar'

/**
 * O "Mais" da barra de baixo.
 *
 * Antes abria a gaveta lateral, que vinha da esquerda — o dedo tocava no
 * canto inferior direito e a tela nascia do outro lado. Aqui o painel sobe
 * de onde o toque aconteceu, e as opções chegam perto do polegar em vez de
 * no topo do aparelho.
 *
 * Fecha de três jeitos: tocando fora, no X, ou arrastando para baixo — este
 * último acompanhando o dedo, como qualquer painel de celular.
 *
 * Traz TUDO, inclusive as quatro que já estão na barra. A primeira versão
 * escondia essas quatro — "Mais" seria o resto — e o efeito foi procurar
 * Transferência no menu e não achar. Menu que às vezes tem o item e às
 * vezes não custa mais do que a linha a mais que ele economiza.
 */

const CONFIGURACOES: NavItem = {
  to: '/configuracoes',
  label: 'Configurações',
  icon: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
}

const DEV: NavItem = {
  to: '/dev',
  label: 'Dev Tools',
  icon: (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
    </svg>
  ),
}

/** Passado este ponto da altura do painel, soltar fecha em vez de voltar. */
const FRACAO_PARA_FECHAR = 0.3
/** px por ms. Um arremesso rápido fecha mesmo tendo andado pouco. */
const VELOCIDADE_PARA_FECHAR = 0.5

export function MenuInferior({ aberto, onFechar }: { aberto: boolean; onFechar: () => void }) {
  const { profile, permissoes } = useAuth()
  const { pathname } = useLocation()
  const painelRef = useRef<HTMLDivElement>(null)
  const fundoRef = useRef<HTMLDivElement>(null)

  /**
   * Arrastar para baixo fecha, acompanhando o dedo.
   *
   * Antes só dava para fechar tocando fora, e arrastar mexia na página de
   * trás — o painel parecia colado na tela. Aqui ele anda junto com o toque e
   * o fundo clareia na mesma proporção, então dá para desistir no meio do
   * caminho e ver o menu voltar.
   *
   * Duas escolhas que valem explicação:
   *
   * O listener é nativo, e não `onTouchMove` do React: o React registra
   * touchmove como passivo, e listener passivo não pode chamar
   * `preventDefault()` — que é justamente o que impede a página de trás de
   * rolar junto.
   *
   * Só começa a arrastar com a lista no topo (`scrollTop === 0`). Numa lista
   * rolada, o dedo para baixo é de quem quer voltar ao começo dela, não de
   * quem quer fechar o menu.
   *
   * O movimento é escrito direto no elemento em vez de virar estado do React:
   * são dezenas de eventos por segundo, e um `setState` por evento faz o
   * painel sacudir em aparelho modesto.
   */
  useEffect(() => {
    const painel = painelRef.current
    if (!aberto || !painel) return

    let inicioY = 0
    let inicioTempo = 0
    let arrastando = false
    let deslocamento = 0

    const aplicar = (y: number) => {
      painel.style.transform = y > 0 ? `translateY(${y}px)` : ''
      if (fundoRef.current) {
        const altura = painel.offsetHeight || 1
        fundoRef.current.style.opacity = String(Math.max(0, 1 - y / altura))
      }
    }

    const comecar = (e: TouchEvent) => {
      if (painel.scrollTop > 0) return
      inicioY = e.touches[0].clientY
      inicioTempo = e.timeStamp
      deslocamento = 0
      arrastando = true
      painel.style.transition = 'none'
    }

    const mover = (e: TouchEvent) => {
      if (!arrastando) return
      deslocamento = e.touches[0].clientY - inicioY
      // Para cima não estica: o painel já está encostado no topo do gesto.
      if (deslocamento <= 0) { aplicar(0); return }
      if (e.cancelable) e.preventDefault()
      aplicar(deslocamento)
    }

    const soltar = (e: TouchEvent) => {
      if (!arrastando) return
      arrastando = false
      painel.style.transition = 'transform 0.24s cubic-bezier(0.16, 1, 0.3, 1)'

      const tempo = Math.max(e.timeStamp - inicioTempo, 1)
      const velocidade = deslocamento / tempo
      const longe = deslocamento > painel.offsetHeight * FRACAO_PARA_FECHAR
      const rapido = velocidade > VELOCIDADE_PARA_FECHAR

      if (!longe && !rapido) { aplicar(0); return }

      painel.style.transform = 'translateY(100%)'
      if (fundoRef.current) {
        fundoRef.current.style.transition = 'opacity 0.2s ease-out'
        fundoRef.current.style.opacity = '0'
      }
      // Desmonta só quando a animação termina, senão o painel some de repente
      // no meio do movimento que a pessoa acabou de fazer.
      window.setTimeout(onFechar, 200)
    }

    painel.addEventListener('touchstart', comecar, { passive: true })
    painel.addEventListener('touchmove', mover, { passive: false })
    painel.addEventListener('touchend', soltar)
    painel.addEventListener('touchcancel', soltar)
    return () => {
      painel.removeEventListener('touchstart', comecar)
      painel.removeEventListener('touchmove', mover)
      painel.removeEventListener('touchend', soltar)
      painel.removeEventListener('touchcancel', soltar)
    }
  }, [aberto, onFechar])

  if (!aberto) return null

  const papel = profile?.papel ?? 'producao'
  const podeVer = (item: NavItem) => canAccess(papel, item.to, permissoes)

  const grupos: { titulo: string; itens: NavItem[] }[] = [
    { titulo: 'Operação', itens: mainNavItems },
    { titulo: 'Estoque', itens: estoqueItems },
    { titulo: 'Cadastros', itens: cadastrosItems },
    { titulo: 'Sistema', itens: profile?.papel === 'admin' ? [CONFIGURACOES, DEV] : [CONFIGURACOES] },
  ]
    .map(g => ({ ...g, itens: g.itens.filter(podeVer) }))
    .filter(g => g.itens.length > 0)

  return (
    <div className="lg:hidden fixed inset-0 z-40">
      {/* Toque fora fecha. O desfoque separa o painel do que está atrás sem
          apagar a tela — a pessoa não perde de vista onde estava. */}
      <div
        ref={fundoRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-surgir"
        onClick={onFechar}
      />

      <div
        ref={painelRef}
        // `overscroll-contain`: chegando ao fim da lista, o embalo morre aqui
        // em vez de passar para a página de trás.
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain animate-subir
                   rounded-t-3xl bg-white dark:bg-unno-raised
                   border-t border-gray-200 dark:border-white/[.08]
                   shadow-[0_-8px_32px_rgba(0,0,0,0.18)] folga-segura-baixo"
      >
        {/* Cabeçalho gruda no topo: em lista longa, o jeito de fechar
            continua à mão sem precisar rolar de volta. */}
        <div className="sticky top-0 bg-white dark:bg-unno-raised pt-2.5 pb-3 px-4
                        border-b border-gray-100 dark:border-white/[.06] z-10">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
          <div className="flex items-center justify-between">
            <p className="font-display text-sm font-bold uppercase tracking-[2px] text-gray-900 dark:text-unno-text">
              Menu
            </p>
            <button
              onClick={onFechar}
              className="p-2 -mr-2 rounded-lg text-gray-400 dark:text-unno-dim"
              aria-label="Fechar"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-4 pt-3 pb-2 space-y-5">
          {grupos.map(grupo => (
            <div key={grupo.titulo}>
              <p className="text-[0.6rem] font-semibold uppercase tracking-[1.5px] text-gray-400 dark:text-unno-dim mb-2">
                {grupo.titulo}
              </p>
              {/* Grade de três: cabe o rótulo inteiro em tela de 360px e
                  evita a lista comprida que o menu lateral tinha. */}
              <div className="grid grid-cols-3 gap-2">
                {grupo.itens.map(item => {
                  const ativo = pathname === item.to || pathname.startsWith(item.to + '/')
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={onFechar}
                      className={[
                        'flex flex-col items-center justify-center gap-1.5 rounded-2xl px-1.5 py-3 min-h-[76px]',
                        'text-[0.62rem] font-semibold uppercase leading-tight text-center',
                        ativo
                          ? 'bg-brand-500/10 text-brand-700 dark:text-brand-400'
                          : 'bg-gray-50 dark:bg-white/[.04] text-gray-600 dark:text-unno-muted',
                      ].join(' ')}
                    >
                      <span className={ativo ? 'text-brand-600 dark:text-brand-400' : 'text-gray-400 dark:text-unno-dim'}>
                        {item.icon}
                      </span>
                      <span className="w-full break-words">{item.label}</span>
                    </NavLink>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

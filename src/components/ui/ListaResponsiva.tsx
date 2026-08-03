import type { ReactNode } from 'react'

/**
 * Tabela no computador, cartões no celular.
 *
 * Ler tabela de oito colunas arrastando de lado num aparelho de 390px é o
 * tipo de coisa que faz a pessoa desistir e ir olhar na prateleira. Mas
 * tabela continua sendo a forma certa numa tela larga, onde comparar linha
 * com linha é o ponto.
 *
 * Então as duas convivem, e a decisão de o que cabe no cartão é de cada
 * tela: no celular não dá para mostrar oito colunas, e escolher quais três
 * importam é editorial, não automático. O que este arquivo padroniza é a
 * ANATOMIA do cartão, para as listas não ficarem cada uma de um jeito.
 *
 * O corte é em `sm` (640px) — o mesmo das outras regras de celular.
 */

export function ListaResponsiva({ tabela, cartoes }: { tabela: ReactNode; cartoes: ReactNode }) {
  return (
    <>
      <div className="hidden sm:block overflow-x-auto">{tabela}</div>
      <div className="sm:hidden divide-y divide-gray-100 dark:divide-white/[.06]">{cartoes}</div>
    </>
  )
}

/**
 * Um item da lista no celular.
 *
 * Anatomia: título em cima (com marcadores ao lado), uma linha de apoio, e
 * embaixo os campos que importam em duas colunas. O toque na área inteira
 * abre o detalhe — alvo grande, não um link de 12px.
 */
export function CartaoLista({
  titulo,
  subtitulo,
  marcadores,
  campos,
  destaque,
  alerta,
  acoes,
  onClick,
}: {
  titulo: ReactNode
  subtitulo?: ReactNode
  /** Selos curtos ao lado do título (⚠ comprar, sem etiqueta…). */
  marcadores?: ReactNode
  /** Os poucos números que valem no celular. */
  campos?: { rotulo: string; valor: ReactNode }[]
  /** O número principal, à direita do título. */
  destaque?: ReactNode
  /** Fundo âmbar: algo nesta linha pede atenção. */
  alerta?: boolean
  /** Botões da linha. Não combine com `onClick`: botão dentro de botão. */
  acoes?: ReactNode
  onClick?: () => void
}) {
  const Elemento = onClick ? 'button' : 'div'

  return (
    <Elemento
      onClick={onClick}
      className={[
        'w-full text-left px-4 py-3.5 flex flex-col gap-2',
        alerta ? 'bg-amber-50 dark:bg-unno-amber/[.07]' : '',
        onClick ? 'active:bg-gray-50 dark:active:bg-white/[.04]' : '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* items-start, e não center: com nome de duas linhas o marcador
              de categoria ficava numa linha sozinha acima do texto. */}
          <div className="flex items-start gap-1.5 min-w-0">{titulo}</div>
          {subtitulo && (
            <p className="text-xs text-gray-400 dark:text-unno-dim mt-0.5">{subtitulo}</p>
          )}
        </div>
        {destaque && (
          <div className="shrink-0 text-right font-semibold text-gray-900 dark:text-unno-text">
            {destaque}
          </div>
        )}
      </div>

      {marcadores && <div className="flex flex-wrap gap-1.5">{marcadores}</div>}

      {campos && campos.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {campos.map(c => (
            <div key={c.rotulo} className="flex items-baseline justify-between gap-2 min-w-0">
              <span className="text-[0.65rem] uppercase tracking-wide text-gray-400 dark:text-unno-dim shrink-0">
                {c.rotulo}
              </span>
              <span className="text-sm text-gray-700 dark:text-unno-muted truncate">{c.valor}</span>
            </div>
          ))}
        </div>
      )}

      {acoes && (
        <div className="flex items-center justify-end gap-2 pt-1">{acoes}</div>
      )}
    </Elemento>
  )
}

/** Mensagem de lista vazia, com o mesmo respiro do cartão. */
export function ListaVazia({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-gray-400 dark:text-unno-dim">{children}</p>
  )
}

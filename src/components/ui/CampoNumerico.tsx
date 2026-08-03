import { useEffect, useRef } from 'react'

/**
 * Campo numérico com as setas do lado de fora.
 *
 * As setas nativas são miúdas, só aparecem no hover e andam sempre de 1 em 1.
 * Aqui o passo é definido por quem usa o campo (uma forma, um por cento), e
 * segurar o botão acelera — meio segundo parado, depois cada vez mais rápido.
 * Sem isso, sair de zero a seis mil é clicar cem vezes.
 */
export function CampoNumerico({
  valor, onDigitar, onPasso, onSair, sufixo,
  passo = 1, min = 0, max, largura = 'w-24', desabilitado = false,
}: {
  valor: string
  onDigitar: (v: string) => void
  onPasso: (delta: -1 | 1) => void
  onSair?: () => void
  /** Rótulo à direita. Omitido quando a unidade já está clara pelo contexto. */
  sufixo?: string
  passo?: number
  min?: number
  max?: number
  largura?: string
  desabilitado?: boolean
}) {
  const rep = useRef<{ espera?: number; timer?: number; repetiu?: boolean }>({})

  function parar() {
    window.clearTimeout(rep.current.espera)
    window.clearTimeout(rep.current.timer)
    rep.current.espera = undefined
    rep.current.timer = undefined
  }

  function segurar(delta: -1 | 1) {
    parar()
    rep.current.espera = window.setTimeout(() => {
      let ritmo = 140
      const bater = () => {
        rep.current.repetiu = true
        onPasso(delta)
        ritmo = Math.max(45, ritmo - 10)
        rep.current.timer = window.setTimeout(bater, ritmo)
      }
      bater()
    }, 450)
  }

  // Soltar fora da tela ou sair da página não pode deixar o contador correndo.
  useEffect(() => () => parar(), [])

  const numero = parseFloat((valor ?? '').replace(',', '.')) || 0

  const botao = (delta: -1 | 1, rotulo: string, off: boolean) => (
    <button
      type="button"
      disabled={desabilitado || off}
      title={delta < 0 ? 'Diminuir' : 'Aumentar'}
      // O clique dá o passo simples; segurar entra em repetição. Quando a
      // repetição rodou, o clique da soltura é descartado para não somar
      // um passo a mais no fim.
      onClick={() => {
        if (rep.current.repetiu) { rep.current.repetiu = false; return }
        onPasso(delta)
      }}
      onPointerDown={() => segurar(delta)}
      onPointerUp={parar}
      onPointerLeave={parar}
      onPointerCancel={parar}
      className="w-8 h-9 shrink-0 rounded-lg border border-gray-300 text-gray-600 text-lg leading-none
                 hover:bg-gray-50 disabled:opacity-30
                 dark:border-white/[.08] dark:text-unno-muted"
    >
      {rotulo}
    </button>
  )

  return (
    <div className="flex items-center gap-1">
      {botao(-1, '−', numero <= min)}
      <input
        type="number"
        min={min}
        max={max}
        step={passo}
        inputMode="decimal"
        value={valor}
        disabled={desabilitado}
        onChange={e => onDigitar(e.target.value)}
        onBlur={onSair}
        placeholder="0"
        className={`${largura} rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                   focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                   disabled:bg-gray-50 disabled:text-gray-400
                   dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text
                   [appearance:textfield]
                   [&::-webkit-outer-spin-button]:appearance-none
                   [&::-webkit-inner-spin-button]:appearance-none`}
      />
      {botao(1, '+', max != null && numero >= max)}
      {sufixo && <span className="text-xs text-gray-400 w-14 shrink-0">{sufixo}</span>}
    </div>
  )
}

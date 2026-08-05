/**
 * A fila de insumos da contagem, para andar para frente e para trás.
 *
 * Antes a contagem só andava num sentido: a tela pulava para o primeiro insumo
 * não finalizado e não havia volta. Quem finalizasse um insumo e achasse a
 * embalagem cinco minutos depois ficava sem saída — e a contagem inteira
 * carregava um "faltante" que não era verdade.
 *
 * Cada botão leva `shrink-0`: sem isso o flex encolhe abaixo da largura do
 * texto e os nomes se sobrepõem (foi o que aconteceu nas abas de
 * Configurações).
 */

type ItemContagem = {
  id: string
  status: string
  insumo: { nome: string; codigo: string }
}

export function NavegadorInsumos({
  itens,
  atual,
  bloqueado,
  onIr,
}: {
  itens: ItemContagem[]
  atual: number
  /** Contagem já aplicada não se reabre: o estoque já foi mexido. */
  bloqueado?: boolean
  onIr: (idx: number) => void
}) {
  if (itens.length === 0) return null

  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Insumos</p>
        <p className="text-xs text-gray-400">
          {itens.filter(i => i.status === 'finalizado').length} de {itens.length} conferidos
        </p>
      </div>
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1">
        {itens.map((item, idx) => {
          const feito = item.status === 'finalizado'
          const eAtual = idx === atual
          return (
            <button
              key={item.id}
              onClick={() => onIr(idx)}
              disabled={bloqueado && !eAtual}
              title={item.insumo.nome}
              className={[
                'shrink-0 whitespace-nowrap rounded-full px-3 py-2 text-xs font-medium transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                eAtual
                  ? 'bg-brand-600 text-white'
                  : feito
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-gray-100 text-gray-600 border border-gray-200',
              ].join(' ')}
            >
              {feito && !eAtual ? '✓ ' : ''}{item.insumo.codigo}
            </button>
          )
        })}
      </div>
    </div>
  )
}

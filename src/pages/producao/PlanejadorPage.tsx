import { useState } from 'react'
import { PlanejadorSemanaPage } from './PlanejadorSemanaPage'
import { PlanejadorRecipientesPage } from './PlanejadorRecipientesPage'

/**
 * Dois níveis de zoom do mesmo planejamento, num item de menu só:
 *
 *   Semana — a meta da semana repartida em dias
 *   Dia    — quais recipientes encher e quais lotes buscar para um dia
 *
 * Trocar de aba levando as formas de um dia é mudança de estado, não
 * navegação: as duas abas vivem na mesma página. Por isso as formas passam por
 * prop e não pelo `state` da rota.
 */
export function PlanejadorPage() {
  const [aba, setAba] = useState<'semana' | 'dia'>('semana')
  const [formasDoDia, setFormasDoDia] = useState<Record<string, string> | undefined>()

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Planejador</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-1">
          {aba === 'semana'
            ? 'A meta da semana repartida em dias de produção.'
            : 'Quantos recipientes precisam estar abastecidos antes de a produção começar.'}
        </p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-white/[.08] mb-5">
        {([['semana', 'Semana'], ['dia', 'Dia']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setAba(key)}
            className={[
              'px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors -mb-px',
              aba === key
                ? 'border-brand-600 text-brand-700 dark:text-brand-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-unno-muted',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* As duas ficam montadas: alternar não pode perder o que foi digitado
          na outra. `hidden` em vez de desmontar. */}
      <div className={aba === 'semana' ? '' : 'hidden'}>
        <PlanejadorSemanaPage
          onVerAbastecimento={formas => {
            setFormasDoDia(formas)
            setAba('dia')
          }}
        />
      </div>
      <div className={aba === 'dia' ? '' : 'hidden'}>
        <PlanejadorRecipientesPage formasIniciais={formasDoDia} />
      </div>
    </div>
  )
}

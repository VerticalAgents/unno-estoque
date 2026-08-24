import { useState } from 'react'
import { PlanejadorMesPage } from './PlanejadorMesPage'
import { PlanejadorSemanaPage } from './PlanejadorSemanaPage'
import { PlanejadorRecipientesPage } from './PlanejadorRecipientesPage'

/**
 * Três níveis de zoom do mesmo planejamento, num item de menu só:
 *
 *   Mês    — o calendário inteiro, para enxergar
 *   Semana — a meta da semana repartida em dias, para planejar
 *   Dia    — quais recipientes encher e quais lotes buscar, para executar
 *
 * Trocar de aba levando dados de uma para a outra é mudança de estado, não
 * navegação: as três vivem na mesma página. Por isso as formas de um dia e a
 * semana escolhida passam por prop, e não pelo `state` da rota.
 */
export function PlanejadorPage() {
  const [aba, setAba] = useState<'mes' | 'semana' | 'dia'>('semana')
  const [formasDoDia, setFormasDoDia] = useState<Record<string, string> | undefined>()
  // O contador faz o clique valer mesmo quando é a mesma semana de antes:
  // sem ele, escolher de novo a semana que já está na prop não dispararia nada.
  const [semanaAlvo, setSemanaAlvo] = useState<{ iso: string; n: number }>()

  const descricao = {
    mes: 'O mês inteiro, semana a semana.',
    semana: 'A meta da semana repartida em dias de produção.',
    dia: 'Quantos recipientes precisam estar abastecidos antes de a produção começar.',
  }[aba]

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Planejador</h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-1">{descricao}</p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-white/[.08] mb-5">
        {([['mes', 'Mês'], ['semana', 'Semana'], ['dia', 'Dia']] as const).map(([key, label]) => (
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

      {/* As três ficam montadas: alternar não pode perder o que foi digitado
          na outra. `hidden` em vez de desmontar. */}
      <div className={aba === 'mes' ? '' : 'hidden'}>
        <PlanejadorMesPage
          onAbrirSemana={segunda => {
            setSemanaAlvo(a => ({ iso: segunda, n: (a?.n ?? 0) + 1 }))
            setAba('semana')
          }}
        />
      </div>
      <div className={aba === 'semana' ? '' : 'hidden'}>
        <PlanejadorSemanaPage
          semanaInicial={semanaAlvo}
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

import { useEffect, useState } from 'react'

const CHAVE = 'mischaos:menu-colapsado'

/**
 * O menu lateral recolhido ou não, lembrado entre sessões.
 *
 * Quem trabalha em tela pequena de notebook recolhe uma vez e quer assim para
 * sempre; quem tem monitor grande nunca recolhe. Perguntar de novo a cada
 * carregamento seria um atrito diário por uma decisão que muda uma vez ao ano.
 *
 * A leitura acontece na inicialização do estado, não num efeito: fazendo por
 * efeito, o menu aberto apareceria por um quadro antes de recolher, e o
 * conteúdo da página pularia para o lado.
 */
export function useMenuColapsado() {
  const [colapsado, setColapsado] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CHAVE) === '1'
    } catch {
      return false          // navegador com armazenamento bloqueado
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(CHAVE, colapsado ? '1' : '0')
    } catch {
      // Sem armazenamento a escolha vale só para esta sessão. Não é motivo
      // para quebrar a tela.
    }
  }, [colapsado])

  return { colapsado, alternar: () => setColapsado(c => !c) }
}

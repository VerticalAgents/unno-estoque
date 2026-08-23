import logo from '../../assets/logo-unno.png'

/**
 * A marca do Unno.
 *
 * UM arquivo, com transparência de verdade.
 *
 * A primeira versão usava os dois PNGs originais — um de fundo branco, outro de
 * fundo quase preto — trocados por CSS. Não funcionou: fundo opaco vira
 * ladrilho, e ladrilho nunca assenta sobre a superfície do cartão. No claro
 * sobrava um contorno em volta do quadrado; no escuro, o quadrado inteiro
 * destoava do cartão.
 *
 * A transparência não foi recortada no olho. Como a mesma marca existia sobre
 * dois fundos conhecidos, o alfa saiu por álgebra — subtraindo uma imagem da
 * outra, o desenho se cancela e sobra exatamente quanto de fundo havia em cada
 * pixel. Isso preserva os meio-tons da borda curva, que qualquer limiar teria
 * transformado em degrau.
 *
 * Sem fundo, a marca assenta em qualquer superfície e o tema deixa de importar.
 */
export function LogoUnno({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <img
      src={logo}
      alt="Unno"
      className={`${className} shrink-0 object-contain select-none`}
      draggable={false}
    />
  )
}

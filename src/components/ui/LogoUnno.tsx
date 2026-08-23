import claro from '../../assets/logo-unno-claro.png'
import escuro from '../../assets/logo-unno-escuro.png'

/**
 * A marca do Unno.
 *
 * São dois arquivos e não um: os PNGs vêm com fundo sólido, sem transparência
 * — branco na versão clara, quase preto na escura. Um só deles apareceria como
 * um retângulo da cor errada metade do tempo.
 *
 * A troca é por CSS (`dark:hidden` / `hidden dark:block`) e não por estado de
 * React. O tema já vive na classe `dark` do <html>; ler isso em JavaScript
 * significaria renderizar a versão errada por um quadro no primeiro
 * carregamento, e piscar branco num sistema que fica aberto o dia todo numa
 * cozinha escura é pior do que qualquer ganho de organização.
 *
 * O `scale-125` dentro de um recorte: o arquivo original tem margem larga em
 * volta da marca, feita para post de rede social. Em 32px essa margem come um
 * terço do espaço e sobra um desenho minúsculo. Ampliar dentro do recorte
 * aperta a margem sem precisar reexportar o arquivo.
 */
export function LogoUnno({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <span
      className={`${className} shrink-0 block overflow-hidden rounded-controle
                  ring-1 ring-border shadow-tema`}
    >
      <img
        src={claro}
        alt="Unno"
        className="w-full h-full object-cover scale-125 dark:hidden"
      />
      <img
        src={escuro}
        alt=""
        aria-hidden="true"
        className="w-full h-full object-cover scale-125 hidden dark:block"
      />
    </span>
  )
}

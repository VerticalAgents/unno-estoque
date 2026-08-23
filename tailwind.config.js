/** @type {import('tailwindcss').Config} */

/**
 * O sistema visual.
 *
 * As cores vivem como variáveis CSS no `index.css` (`:root` e `.dark`) e são
 * apontadas daqui. É o equivalente, no Tailwind 3, ao `@theme inline` que o
 * Tailwind 4 traz — mesma ideia, sintaxe da versão que este projeto usa.
 *
 * DOIS RAIOS, DE PROPÓSITO. Painel e cartão em 28px; botão, campo e chip no
 * `--radius` do tema, 8px. O contraste entre o bloco muito redondo e o controle
 * quase reto é o que faz o bloco parecer solto — se tudo tem o mesmo canto, o
 * painel vira só um retângulo grande.
 *
 * DUAS FAMÍLIAS DE COR, e a diferença importa na hora de escrever classe:
 *
 *   • SEMÂNTICAS (`bg-card`, `text-foreground`, `border-border`) apontam para
 *     variável e trocam sozinhas entre claro e escuro. **Não aceitam opacidade**
 *     — `bg-primary/50` não funciona, porque a variável guarda hexadecimal e
 *     não os canais separados. Para transparência, use a escala numérica.
 *
 *   • ESCALAS (`brand-500`, `areia-200`, `acao-500`) são hexadecimais fixos e
 *     aceitam `/10`, `/12`, `/25`. `brand` é a mesma menta do tema, em rampa.
 *
 * O LARANJA (`acao-*`) não pertence ao tema. Ficou reservado para ação
 * irreversível — decisão do usuário quando o menta virou a cor primária.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Outfit para títulos, botões e números; Inter para o corpo do texto.
        // O tema pede Outfit como `--font-sans`; mantivemos Inter no corpo
        // porque é ela que segura texto pequeno de tabela sem cansar.
        display: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      colors: {
        // ── Semânticas: trocam sozinhas entre claro e escuro ──
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        /** O chão da aplicação. Meio tom abaixo do cartão, para o bloco
         *  flutuante ter de onde descolar. Ver a nota no index.css. */
        ground: 'var(--app-ground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          border: 'var(--sidebar-border)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          primary: 'var(--sidebar-primary)',
          'primary-foreground': 'var(--sidebar-primary-foreground)',
          ring: 'var(--sidebar-ring)',
        },
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
          5: 'var(--chart-5)',
        },

        // ── Escalas: hexadecimal fixo, aceitam opacidade ──
        //
        // `brand` é a menta do tema em rampa. O 400 é exatamente o --primary
        // claro (#25d98d) e o 900 é o --primary escuro (#006239): os dois
        // extremos do tema são pontos reais da escala, não aproximações.
        //
        // Menta é clara: superfície de menta pede texto ESCURO, nunca branco.
        // É o que o tema diz em --primary-foreground (#1e2723).
        brand: {
          50:  '#e8fbf2',
          100: '#c7f5e0',
          200: '#93ecc4',
          300: '#57e2a5',
          400: '#25d98d',
          500: '#16bd79',
          600: '#0f9d64',
          700: '#0b7d50',
          800: '#097046',
          900: '#006239',
        },

        // Laranja: fora do tema, reservado para ação irreversível.
        acao: {
          50:  '#fff4f0',
          100: '#ffe4da',
          200: '#ffb89e',
          300: '#ff9873',
          400: '#ff7a52',
          500: '#ff5524',
          600: '#e04415',
          700: '#b8350f',
          800: '#8f2a0c',
          900: '#6b2009',
        },

        // Neutros do tema — cinza puro, sem viés de cor. O nome `areia` ficou
        // do sistema anterior; renomear custaria varrer todas as telas para
        // ganhar só o nome certo.
        areia: {
          50:  '#fdfdfd',
          100: '#f6f6f6',
          200: '#ededed',
          300: '#dfdfdf',
          400: '#c4c4c4',
          500: '#909090',
          600: '#707070',
          700: '#525252',
          800: '#3a3a3a',
          900: '#202020',
          950: '#171717',
        },

        // Superfícies do tema escuro. Nomes antigos, valores do tema novo:
        // `dark:bg-unno-raised` aparece em centenas de lugares, e trocar o
        // hexadecimal vira o tema escuro inteiro sem tocar em nenhuma tela.
        unno: {
          bg: '#121212',
          raised: '#171717',
          elevated: '#242424',
          sunken: '#0d0d0d',
          text: '#e2e8f0',
          muted: '#a2a2a2',
          dim: '#898989',
          amber: '#fbbf24',
          danger: '#ca3214',
          lime: '#4ade80',
        },
      },

      borderRadius: {
        // O bloco flutuante: menu, cabeçalho, cartão, painel suspenso.
        bloco: '28px',
        // Botão, campo, chip — segue o `--radius` do tema.
        controle: 'var(--radius)',
      },

      boxShadow: {
        // A sombra do tema: deslocamento 0 1px, desfoque 3px, opacidade .17.
        tema: '0 1px 3px 0 rgb(0 0 0 / 0.17)',
        'tema-md': '0 2px 6px -1px rgb(0 0 0 / 0.17), 0 1px 3px -1px rgb(0 0 0 / 0.12)',
        // O bloco flutuante precisa de mais alcance que a sombra base para
        // descolar de um chão que está a meio tom de distância.
        bloco: '0 1px 3px 0 rgb(0 0 0 / 0.14), 0 12px 28px -12px rgb(0 0 0 / 0.22)',
        // Herdadas: telas que ainda não foram revisadas usam estes nomes.
        tactil: '0 1px 3px 0 rgb(0 0 0 / 0.17)',
        'tactil-hover': '0 2px 6px -1px rgb(0 0 0 / 0.2), 0 8px 20px -8px rgb(0 0 0 / 0.18)',
        'tactil-escuro': '0 1px 3px 0 rgb(0 0 0 / 0.5)',
        botao: '0 1px 2px 0 rgb(0 0 0 / 0.14)',
        'botao-press': 'inset 0 1px 2px 0 rgb(0 0 0 / 0.2)',
        glow: '0 0 30px rgb(37 217 141 / 0.28)',
        'glow-sm': '0 0 20px rgb(37 217 141 / 0.14)',
        'glow-amber': '0 0 30px rgb(251 191 36 / 0.3)',
      },

      letterSpacing: {
        tema: 'var(--letter-spacing)',
      },

      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(.16, 1, .3, 1)',
        'out-quart': 'cubic-bezier(.25, 1, .5, 1)',
        mola: 'cubic-bezier(.34, 1.56, .64, 1)',
      },

      transitionDuration: {
        press: '80ms',
      },
    },
  },
  plugins: [],
}

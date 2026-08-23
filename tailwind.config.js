/** @type {import('tailwindcss').Config} */

/**
 * O sistema visual, depois da virada de 23/08/2026.
 *
 * A referência é o design system do HYVE Lab (lab.hyve.company), do qual saem
 * três ideias e não a paleta inteira:
 *
 * 1. NEUTRO QUENTE. Nenhum cinza é neutro de verdade — todos puxam para o
 *    oliva/areia, e o "preto" é #1a1a17. Cinza puro ao lado disso parece
 *    descolorido, então a escala `areia` substitui o `gray` onde encostamos.
 * 2. CANTO GRANDE. 28px em painel e cartão. É o que faz um bloco parecer
 *    flutuar em vez de estar encaixado na borda da tela.
 * 3. SUPERFÍCIE TÁCTIL. Luz interna em cima, sombra interna embaixo, sombra de
 *    contato fora. Dá volume ao objeto sem depender de borda desenhada.
 *
 * DUAS CORES, DOIS PAPÉIS. O verde continua sendo quem o sistema é — logo,
 * item aceso no menu. O laranja é o que o sistema pede que você faça — botão
 * principal, chamada. Eles nunca disputam o mesmo lugar. E o verde de "deu
 * certo" (emerald) segue separado do verde da marca, senão sucesso e
 * identidade viram a mesma coisa.
 *
 * A paleta `unno` teve os VALORES trocados e os NOMES mantidos de propósito:
 * `dark:bg-unno-raised` aparece em centenas de lugares, e reescrever o hex
 * esquenta o tema escuro inteiro sem tocar em nenhuma tela.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Outfit para títulos, botões e números; Inter para o corpo do texto.
        display: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // ── Identidade: quem o sistema é ──────────────────────
        brand: {
          50: '#e8f7ef',
          100: '#c9edda',
          200: '#95dcb8',
          300: '#5fc994',
          400: '#34b877',
          500: '#17a860',
          600: '#128a4f',
          700: '#0e6d3f',
          800: '#0a5030',
          900: '#073622',
        },

        // ── Ação: o que o sistema pede que você faça ──────────
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

        // ── Neutro quente: substitui o `gray` onde encostamos ─
        areia: {
          50:  '#fbfcf3',
          100: '#f7f7f2',
          200: '#eeede5',
          300: '#dddcd2',
          400: '#c4c3b8',
          500: '#a09f95',
          600: '#7a7970',
          700: '#5a594f',
          800: '#3d3c35',
          900: '#2a2a24',
          950: '#1a1a17',
        },

        // ── Superfícies do tema escuro (nomes antigos, tons quentes) ──
        unno: {
          bg: '#131311',
          raised: '#1a1a17',
          elevated: '#22221e',
          sunken: '#0e0e0c',
          text: '#e8e6df',
          muted: '#a09f95',
          dim: '#5a594f',
          amber: '#e8a317',
          danger: '#d93025',
          lime: '#7ba656',
        },
      },

      borderRadius: {
        // Painel e cartão: o canto que faz o bloco flutuar.
        bloco: '28px',
        // Botão, campo e chip: grande o bastante para conversar com o bloco,
        // pequeno o bastante para não virar cápsula num campo de texto.
        controle: '14px',
      },

      boxShadow: {
        // Superfície táctil no claro: luz em cima, contato embaixo.
        tactil: 'inset 0 1px 0 #ffffffeb, inset 0 -1px 0 #281e161a, 0 1px 2px #281e1614, 0 6px 18px -6px #281e1629',
        'tactil-hover': 'inset 0 1px 0 #fffffff5, inset 0 -1px 0 #281e1624, 0 2px 6px #281e161a, 0 12px 28px -8px #281e1633',
        // O bloco flutuante do menu, que precisa descolar do fundo.
        bloco: '0 4px 10px #281e161a, 0 18px 40px -12px #281e1629',
        // Botão: a luz interna é mais forte porque a superfície é colorida.
        botao: 'inset 0 1px 0 #ffffff4d, inset 0 -1px 0 #0000002e, 0 1px 2px #281e1626',
        'botao-press': 'inset 0 2px 4px #0000004d, inset 0 1px 1px #0003',
        // O escuro não usa luz branca — usa uma quente, quase imperceptível.
        'tactil-escuro': 'inset 0 1px 0 #ffc8a014, inset 0 -1px 0 #0000004d, 0 2px 16px #0000005c',
        // Herdados do tema antigo, ainda usados em telas que não tocamos.
        glow: '0 0 30px rgba(23, 168, 96, 0.28)',
        'glow-sm': '0 0 20px rgba(23, 168, 96, 0.14)',
        'glow-amber': '0 0 30px rgba(232, 163, 23, 0.3)',
      },

      transitionTimingFunction: {
        // A curva do HYVE: sai rápido, chega devagar. Dá peso ao movimento.
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

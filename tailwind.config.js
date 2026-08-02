/** @type {import('tailwindcss').Config} */
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
        // Escala construída em torno do verde do design system (--unno-accent).
        brand: {
          50: '#e8f7ef',
          100: '#c9edda',
          200: '#95dcb8',
          300: '#5fc994',
          400: '#34b877',
          500: '#17a860', // --unno-accent
          600: '#128a4f',
          700: '#0e6d3f',
          800: '#0a5030',
          900: '#073622',
        },
        // Superfícies e textos do design system (modo escuro).
        unno: {
          bg: '#0a0a0f',
          raised: '#111118',
          elevated: '#1a1a24',
          text: '#eef0f4',
          muted: '#8a8fa0',
          dim: '#4a4e5c',
          amber: '#f5a623', // --unno-accent2
          danger: '#ff4d6a',
          // Meio-termo entre o verde da marca e o âmbar, para escalas de
          // "quase lá". O ponto médio puro (#86a742) fica oliva; este é o
          // mesmo tom com um pouco mais de saturação.
          lime: '#8cbf3f',
        },
      },
      boxShadow: {
        // Brilho teal do design system (--unno-accent-glow).
        glow: '0 0 30px rgba(0, 212, 170, 0.35)',
        'glow-sm': '0 0 20px rgba(0, 212, 170, 0.15)',
        'glow-amber': '0 0 30px rgba(245, 166, 35, 0.3)',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(.16, 1, .3, 1)',
        'out-quart': 'cubic-bezier(.25, 1, .5, 1)',
      },
    },
  },
  plugins: [],
}

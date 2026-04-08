/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#e6faf5',
          100: '#ccf5eb',
          200: '#99ebd7',
          300: '#66e0c3',
          400: '#33d6af',
          500: '#00d4aa',
          600: '#00b38d',
          700: '#008f71',
          800: '#006b55',
          900: '#004838',
        },
      },
    },
  },
  plugins: [],
}

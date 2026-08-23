/// <reference types="vite/client" />

// Sem isto o TypeScript recusa `import logo from './x.png'` — ele não sabe que
// o Vite transforma o arquivo numa URL. Faltava porque, até a logo entrar,
// nenhum import de imagem existia no projeto.

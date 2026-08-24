# Sistema visual — regras para reaplicar em outro projeto

Documento de referência do desenho de interface do MischaOS/Unno. Serve para
reproduzir a mesma linguagem visual em outro sistema sem ter de garimpar o
código. Cada regra vem com o motivo — regra sem motivo é a primeira a ser
quebrada por engano.

Base técnica: **React + TypeScript + Vite + TailwindCSS 3.4**, tema escuro por
classe (`darkMode: 'class'`). Nada aqui depende de biblioteca de componentes.

---

## 1. A regra que mais define o visual: dois raios

**Bloco = 28px. Controle = 8px.** Nunca o mesmo raio para os dois.

| Papel | Raio | Onde |
|---|---|---|
| Bloco | `28px` (`rounded-bloco`) | menu lateral, cabeçalho, cartão, painel suspenso, barra inferior |
| Controle | `8px` (`rounded-controle`, o `--radius` do tema) | botão, campo, chip, item de menu |

O contraste entre o bloco muito redondo e o controle quase reto é o que faz o
bloco **parecer solto na tela**. Se tudo tem o mesmo canto, o painel vira só um
retângulo grande e a hierarquia some.

Exceção deliberada: o **badge** é pílula (`rounded-full`) — é rótulo, não bloco
nem controle.

---

## 2. O chão e o bloco flutuante

O segundo pilar. A aplicação inteira é composta de **blocos que flutuam sobre um
chão mais escuro que eles**.

```
chão da aplicação  →  --app-ground   (meio tom abaixo)
bloco              →  --card         (mais claro) + borda + sombra
```

No tema original que serviu de base, fundo, cartão e barra lateral eram todos
`#fcfcfc`. Com o chão igual ao bloco **nada flutua**, e quem separa passa a ser
só a borda. Por isso o chão usa o `--muted` (`#ededed`), meio tom abaixo. No
escuro o próprio tema já separa (`#121212` de fundo, `#171717` de cartão).

**Consequência prática:** o menu lateral e o cabeçalho **não encostam na borda da
tela**. Há um respiro (`py-3 pl-3`) entre eles e a janela. Um painel colado na
borda mostra só dois cantos arredondados e a sombra não tem para onde cair.

```tsx
{/* casca que dá o respiro */}
<aside className="hidden lg:flex flex-col shrink-0 h-full py-3 pl-3">
  {/* o bloco em si */}
  <nav className="flex flex-col h-full w-60 overflow-hidden rounded-bloco
                  bg-card border border-border shadow-bloco">
    …
  </nav>
</aside>
```

A borda quase não aparece — **quem separa o bloco do fundo é a sombra**.

---

## 3. Cores

### Duas famílias, e a diferença importa na hora de escrever a classe

**Semânticas** (`bg-card`, `text-foreground`, `border-border`) apontam para
variável CSS e trocam sozinhas entre claro e escuro. **Não aceitam opacidade** —
`bg-primary/50` não funciona, porque a variável guarda hexadecimal e não os
canais separados.

**Escalas** (`brand-500`, `areia-200`, `acao-500`) são hexadecimais fixos e
aceitam `/10`, `/12`, `/25`. É delas que se tira transparência.

### Tokens — tema claro

```css
:root {
  --card: #fcfcfc;
  --ring: #25d98d;
  --input: #f6f6f6;
  --muted: #ededed;
  --accent: #ededed;
  --border: #dfdfdf;
  --radius: 0.5rem;
  --popover: #fcfcfc;
  --primary: #25d98d;
  --sidebar: #fcfcfc;
  --secondary: #fdfdfd;
  --background: #fcfcfc;
  --foreground: #171717;
  --destructive: #ca3214;
  --letter-spacing: 0.025em;
  --sidebar-accent: #ededed;
  --sidebar-border: #dfdfdf;
  --card-foreground: #171717;
  --sidebar-primary: #25d98d;
  --muted-foreground: #202020;
  --accent-foreground: #202020;
  --popover-foreground: #525252;
  --primary-foreground: #1e2723;
  --sidebar-foreground: #707070;
  --secondary-foreground: #171717;
  --destructive-foreground: #fffcfc;
  --sidebar-accent-foreground: #202020;
  --sidebar-primary-foreground: #1e2723;

  /* Fora do tema: o chão precisa ficar abaixo do bloco. Ver seção 2. */
  --app-ground: var(--muted);

  /* Gráficos */
  --chart-1: #25d98d;  --chart-2: #3b82f6;  --chart-3: #8b5cf6;
  --chart-4: #f59e0b;  --chart-5: #10b981;
}
```

### Tokens — tema escuro

```css
.dark {
  --card: #171717;
  --ring: #4ade80;
  --input: #242424;
  --muted: #1f1f1f;
  --accent: #313131;
  --border: #292929;
  --popover: #242424;
  --primary: #006239;
  --sidebar: #121212;
  --secondary: #242424;
  --background: #121212;
  --foreground: #e2e8f0;
  --destructive: #541c15;
  --sidebar-accent: #313131;
  --sidebar-border: #292929;
  --card-foreground: #e2e8f0;
  --sidebar-primary: #006239;
  --muted-foreground: #a2a2a2;
  --accent-foreground: #fafafa;
  --popover-foreground: #a9a9a9;
  --primary-foreground: #dde8e3;
  --sidebar-foreground: #898989;
  --secondary-foreground: #fafafa;
  --destructive-foreground: #ede9e8;
  --sidebar-accent-foreground: #fafafa;
  --sidebar-primary-foreground: #dde8e3;

  --app-ground: var(--background);

  --chart-1: #4ade80;  --chart-2: #60a5fa;  --chart-3: #a78bfa;
  --chart-4: #fbbf24;  --chart-5: #2dd4bf;
}
```

### A escala da marca (menta)

O `400` é exatamente o `--primary` claro e o `900` é o `--primary` escuro: os
dois extremos do tema são **pontos reais da escala**, não aproximações.

```js
brand: {
  50: '#e8fbf2', 100: '#c7f5e0', 200: '#93ecc4', 300: '#57e2a5', 400: '#25d98d',
  500: '#16bd79', 600: '#0f9d64', 700: '#0b7d50', 800: '#097046', 900: '#006239',
}
```

**Menta é cor clara: superfície de menta pede texto ESCURO, nunca branco.** É o
que o token `--primary-foreground` (`#1e2723`) diz. Errar isso é o defeito mais
comum ao aplicar esta paleta.

### O laranja não pertence ao tema

`acao-*` (`500: #ff5524`) fica **reservado para ação irreversível**. Não é cor
decorativa e não entra em gráfico, badge nem destaque. Se tudo pode ser laranja,
o laranja não avisa mais nada.

```js
acao: {
  50: '#fff4f0', 100: '#ffe4da', 200: '#ffb89e', 300: '#ff9873', 400: '#ff7a52',
  500: '#ff5524', 600: '#e04415', 700: '#b8350f', 800: '#8f2a0c', 900: '#6b2009',
}
```

### Neutros

Cinza puro, sem viés de cor: `50 #fdfdfd`, `100 #f6f6f6`, `200 #ededed`,
`300 #dfdfdf`, `400 #c4c4c4`, `500 #909090`, `600 #707070`, `700 #525252`,
`800 #3a3a3a`, `900 #202020`, `950 #171717`.

Superfícies do escuro: `bg #121212`, `raised #171717`, `elevated #242424`,
`sunken #0d0d0d`; texto `#e2e8f0`, apagado `#a2a2a2`, fraco `#898989`.

---

## 4. Tipografia

| Papel | Fonte | Onde |
|---|---|---|
| Títulos, botões, números | **Outfit** (`font-display`) | h1–h4, `Button`, valores de destaque |
| Corpo | **Inter** (`font-sans`) | texto, tabelas, formulários |

**Espaçamento entre letras é assinatura desta identidade.** O corpo inteiro
carrega `letter-spacing: 0.025em`, e os elementos de navegação vão muito além:

```
Navegação / botão:  uppercase + tracking-[1px] a [1.5px] + text-[0.7rem] + font-semibold
Logotipo:           uppercase + tracking-[3px] + font-extrabold
Legenda de logo:    uppercase + tracking-[1.5px] + text-[0.65rem]
Rótulo de campo:    uppercase + tracking-wide + text-xs + font-semibold
```

Regra prática: **tudo que é rótulo de interface vai em maiúsculas espaçadas;
tudo que é conteúdo vai em caixa normal.** É o que distingue o esqueleto do
recheio sem precisar de linha divisória.

Cuidado que isso cria: maiúscula espaçada ocupa mais largura. O menu lateral é
`w-60` e não `w-56` por causa disso.

---

## 5. Sombras

```js
tema:      '0 1px 3px 0 rgb(0 0 0 / 0.17)'
tema-md:   '0 2px 6px -1px rgb(0 0 0 / 0.17), 0 1px 3px -1px rgb(0 0 0 / 0.12)'
bloco:     '0 1px 3px 0 rgb(0 0 0 / 0.14), 0 12px 28px -12px rgb(0 0 0 / 0.22)'
glow:      '0 0 30px rgb(37 217 141 / 0.28)'
glow-sm:   '0 0 20px rgb(37 217 141 / 0.14)'
```

- **`shadow-tema`** — cartão parado. Sombra curta, quase um contato.
- **`shadow-tema-md`** — cartão clicável no hover.
- **`shadow-bloco`** — menu, cabeçalho, painel suspenso. Precisa de mais alcance
  que a sombra base **porque o chão está a apenas meio tom de distância**.
- **`glow`** — só no escuro, no hover de botão primário.

---

## 6. Menu lateral (sidebar)

**Bloco flutuante, não coluna colada.** `w-60`, `rounded-bloco`, `bg-card`,
`border-border`, `shadow-bloco`, dentro de uma casca com `py-3 pl-3`.

Estrutura de cima para baixo:

1. **Cabeçalho do bloco** — logo + legenda, `px-5 py-5 border-b border-border`
2. **Navegação** — `flex-1 px-3 py-4 space-y-1 overflow-y-auto`
3. **Rodapé** — bloco do usuário dentro de `rounded-bloco bg-muted p-1.5`

### O item de menu

```tsx
const classeLinha = (aceso: boolean) => [
  'flex items-center gap-3 px-3 py-2.5 rounded-controle text-[0.7rem] font-semibold',
  'uppercase tracking-[1px] transition-all duration-200 ease-out-expo',
  aceso
    ? 'bg-brand-500/12 text-brand-700 shadow-[inset_0_1px_0_#ffffffb3] ' +
      'dark:text-brand-400 dark:shadow-[inset_0_1px_0_#ffffff0f]'
    : 'text-sidebar-foreground hover:bg-accent hover:text-accent-foreground',
].join(' ')

const classeIcone = (aceso: boolean) =>
  aceso ? 'text-brand-600 dark:text-brand-400' : 'text-muted-foreground/60'
```

Três coisas a copiar daqui:

- **O item aceso usa a marca a 12%**, não a marca cheia. Fundo cheio de menta num
  item de menu grita mais que o conteúdo da página.
- **A luz interna no topo** (`inset 0 1px 0 branco`) é o que dá relevo ao item
  aceso — é o mesmo truque de superfície táctil usado no cartão.
- **O ícone acompanha o estado**, e apagado fica em `muted-foreground/60`: ícone
  na mesma força do texto compete com ele.

Ícones: SVG traçado, `w-5 h-5`, `strokeWidth={1.8}`, `currentColor`. Nos
submenus, `w-4 h-4`.

### Grupos

Dezenove destinos não cabem numa coluna sem rolagem. Eles moram em **quatro
grupos que abrem para baixo**; soltos ficam só Dashboard (no topo) e
Configurações (no fim).

- O corte **não é por o que a coisa é, e sim por quando se usa**. Foi assim que
  16 linhas viraram 6.
- A ordem segue **o caminho físico** do trabalho, não o alfabeto. Menu que
  acompanha o processo real se aprende uma vez.
- O grupo da rota atual **nasce aberto**; os outros, fechados. Depois disso a
  escolha é de quem clica — não reabrir nada ao navegar, senão um grupo fechado
  de propósito volta sozinho a cada página.
- Submenu recua com `ml-4 pl-3 border-l border-border`.
- Grupo fechado com filho ativo mostra um ponto: `w-1.5 h-1.5 rounded-full
  bg-brand-500`.
- A seta gira: `transition-transform duration-200` + `rotate-180`.

---

## 7. Cabeçalho

**A mesma cápsula do menu, deitada:** `h-14 px-2.5 rounded-bloco bg-card border
border-border shadow-bloco`, dentro de `px-3 pt-3`.

A regra de comportamento que vale a pena copiar: **recolher o menu lateral não
esconde para onde ir — muda a orientação.** A coluna vira tira horizontal no
cabeçalho e a tela ganha 240px de largura de volta. Num notebook de 13", numa
tabela larga, é a diferença entre ler e rolar para o lado.

Duas restrições que mantêm isso honesto:

- **Seis itens, sem rolagem.** Cabeçalho que rola para o lado esconde metade do
  caminho sem avisar que existe metade escondida.
- **Nunca quebra em duas linhas.** Cabeçalho que muda de altura conforme a rota
  empurra o conteúdo da página para baixo a cada navegação.

Com o menu aberto no computador, o cabeçalho **não é renderizado** (`lg:hidden`):
a navegação está na coluna e o usuário no rodapé dela; barra vazia rouba altura
para não dizer nada.

Painel suspenso de grupo: `rounded-bloco bg-popover border border-border
shadow-bloco p-1.5 w-56`, fecha ao navegar e ao clicar fora.

---

## 8. Barra inferior (celular)

Cápsula flutuante presa acima da faixa do gesto de *home*, com desfoque:

```tsx
className="lg:hidden fixed left-3 right-3 z-30 barra-flutuante
           rounded-[28px] border border-black/[.06] dark:border-white/[.08]
           bg-white/85 dark:bg-unno-elevated/85 backdrop-blur-xl
           shadow-[0_6px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_6px_24px_rgba(0,0,0,0.5)]"
```

```css
.barra-flutuante        { bottom: max(env(safe-area-inset-bottom, 0px), 10px); }
.espaco-barra-flutuante { padding-bottom: calc(78px + max(env(safe-area-inset-bottom, 0px), 10px)); }
.folga-segura-baixo     { padding-bottom: max(env(safe-area-inset-bottom, 0px), 12px); }
```

**As duas primeiras andam juntas:** a barra flutua por cima do conteúdo, então a
área que rola precisa terminar acima dela. Mudou a altura de uma, muda a da
outra. E elas moram em folha de estilo, **não em estilo em linha** — o WebKit do
iOS descarta `env()` aplicado por JavaScript, e foi assim que a faixa do gesto de
home acabou desenhada por cima dos rótulos.

Item: `flex-1 min-w-0` (sem o `min-w-0` o rótulo define a largura e o quinto item
sai da tela num aparelho de 360px), `min-h-[52px]`, `rounded-[22px]`, ícone
`w-6 h-6` com traço `2` quando ativo e `1.6` quando não. **A pílula marca onde
você está sem depender só da cor** — com a tela suja, a forma se lê antes.

---

## 9. Botões

```tsx
'inline-flex items-center justify-center gap-2 rounded-controle font-display font-semibold'
'uppercase tracking-[1.5px]'
'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-ground'
'transition-all duration-200 ease-out-expo [@media(hover:hover)]:hover:-translate-y-0.5'
'active:translate-y-px active:duration-press'
'disabled:cursor-not-allowed disabled:opacity-60'
```

**O detalhe que quase ninguém acerta:** o "levantar" no hover fica atrás de
`[@media(hover:hover)]`. Em tela de toque não existe hover de verdade — o iOS
aplica o estado ao tocar e o **deixa grudado** até o próximo toque em outro
lugar. Já o "afundar" (`active`) vale para os dois: no toque é o retorno
imediato de que o dedo foi registrado, em 80ms.

Variantes:

| Nome | Uso |
|---|---|
| `primary` | `bg-brand-500 text-white`, hover `brand-600` + `shadow-glow`; **no escuro o texto vira escuro** (`dark:text-unno-bg`) |
| `secondary` | fundo `secondary` + borda; hover vira `accent` |
| `ghost` | transparente com borda; ação terciária |
| `danger` | `bg-destructive`; hover por `brightness-110` |
| `success` | esmeralda; confirmação positiva |

Tamanhos — repare no piso de 44px no celular:

```js
sm: 'px-3.5 py-1.5 text-[0.7rem] min-h-[44px] sm:min-h-[32px]'
md: 'px-5   py-2   text-xs        min-h-[44px] sm:min-h-[40px]'
lg: 'px-6   py-3   text-sm        min-h-[48px]'
xl: 'px-8   py-4   text-base      min-h-[56px]'
```

---

## 10. Campos

```
block w-full rounded-controle border px-4 py-2.5 text-sm
focus:outline-none focus:border-ring focus:ring-[3px] focus:ring-brand-400/25
transition-[border-color,box-shadow] duration-200
```

Normal: `border-border bg-input`. Erro: `border-red-400 bg-red-50
dark:bg-red-950 dark:border-red-800`.

O foco é **borda verde + halo de 3px a 25%** — não o anel padrão do navegador.
Note que o halo usa a escala (`brand-400/25`) e não a semântica, justamente
porque precisa de opacidade.

Rótulo acima, em maiúscula espaçada; dica e erro abaixo, em `text-xs`.

---

## 11. Cartão

```tsx
'rounded-bloco border transition-all duration-300 ease-out-expo'
'bg-card border-border shadow-tema'
// clicável:
'cursor-pointer hover:-translate-y-1 hover:shadow-tema-md'
```

Cabeçalho `px-5 pt-5 pb-3 border-b border-border`, corpo `px-5 py-4`. Um
`accent` opcional pinta uma borda esquerda de 4px para categorizar sem
introduzir cor de fundo.

**Badge**: pílula `px-3 py-0.5 text-[0.7rem] font-semibold uppercase
tracking-wide`, e **cada variante declara os dois temas** — ver a seção 12 para
entender por quê.

---

## 12. Tema escuro — a estratégia inteira

Três camadas, nesta ordem de força:

1. **Tokens** (`.dark { --card: … }`) — resolvem tudo que usa classe semântica.
2. **Rede de segurança** no CSS global: um bloco de `.dark .bg-white { … }`,
   `.dark .text-gray-900 { … }`, `.dark .bg-red-50 { … }` que conserta telas
   escritas com cores cruas do Tailwind.
3. **O `dark:` escrito no componente** — que precisa vencer as duas anteriores.

**A lição que custou caro:** a rede de segurança estava escrita como
`html.dark .bg-red-50` (especificidade 0,2,1) e **vencia** o `dark:bg-red-950`
declarado no componente (0,2,0). Resultado: componente que não mandava na
própria cor — o badge "Vencido" saía vermelho sobre vermelho, ilegível a um
metro da tela.

A correção foi rebaixar tudo para `.dark .x`: continua ganhando da classe crua,
mas **perde** para um `dark:` explícito. É a ordem certa — quem declarou o
escuro de propósito manda mais do que a rede de segurança. Se você copiar a
rede, copie com esta especificidade.

Regra de cor que decorre disso: **texto escuro sobre tinta clara vira texto claro
sobre tinta escura.** No claro, `bg-red-100 + text-red-800`. No escuro,
`bg-red-950 + text-red-200`. Não basta trocar o fundo.

E: `html.dark { color-scheme: dark; }` — sem isso as barras de rolagem e os
seletores nativos continuam brancos.

---

## 13. Toque e celular

- **Alvo mínimo de 44px** (recomendação de Apple e Google) para `input`, `select`
  e `button` abaixo de 640px. Mão molhada e apressada não acerta 32px.
- **Campo com 16px de fonte abaixo de 640px, com `!important`.** O Safari do
  iPhone dá zoom automático em qualquer campo menor que 16px **e não volta
  sozinho**. O `!important` é necessário porque quase todo campo carrega
  `text-sm`, e classe ganha de seletor de elemento na disputa do CSS. Sem ele a
  regra existe e não vale nada.
- **`h-[100dvh]`, não `h-screen`.** `100vh` no celular conta a faixa atrás da
  barra de endereço: o rodapé nasce cortado e pula quando a barra some. Deixe
  `h-screen` antes como reserva para navegador antigo.
- **Botão de concluir grudado no fim da tela** (`position: sticky; bottom: 0`)
  num formulário longo — e **volta a ser estático a partir de `lg`**, onde a tela
  é alta e barra grudada só rouba espaço.
- `-webkit-tap-highlight-color: transparent` no `html`.

---

## 14. Movimento

```js
transitionTimingFunction: {
  'out-expo':  'cubic-bezier(.16, 1, .3, 1)',   // padrão da casa
  'out-quart': 'cubic-bezier(.25, 1, .5, 1)',
  mola:        'cubic-bezier(.34, 1.56, .64, 1)',
}
transitionDuration: { press: '80ms' }
```

- Transição de estado: **200ms**. Cartão: **300ms**. Toque afundando: **80ms**.
- Painel que sobe de baixo: `translateY(100%) → 0` em **260ms** com `out-expo` —
  **o movimento é o que diz de onde a coisa veio.**
- **`prefers-reduced-motion: reduce` zera as animações.** Quem pediu para o
  sistema não animar não recebe animação.

---

## 15. Para portar — a ordem que funciona

1. Copie as variáveis de `:root` e `.dark` (seção 3).
2. Copie o `theme.extend` do Tailwind: `borderRadius` (`bloco`/`controle`),
   `boxShadow`, `fontFamily`, as escalas `brand`/`acao`/neutros, e o mapeamento
   das semânticas para as variáveis.
3. Carregue **Outfit** e **Inter**; aplique `letter-spacing` no `body` e
   `font-display` em `h1–h4`.
4. Defina `--app-ground` **meio tom abaixo do cartão** e pinte o `body` com ele.
5. Monte a casca: chão + menu como bloco flutuante com respiro + cabeçalho como
   cápsula.
6. Só então construa botão, campo, cartão e badge com os dois raios.

### Os cinco erros mais fáceis de cometer

1. Usar o **mesmo raio** para bloco e controle — mata o efeito inteiro.
2. Deixar o **chão igual ao cartão** — nada flutua e a borda vira a única
   separação.
3. **Texto branco sobre menta.** A menta é clara; o texto é escuro.
4. Escrever a rede de segurança do escuro com **especificidade alta demais**, e
   descobrir meses depois que os componentes não mandam na própria cor.
5. Deixar o **hover de "levantar" sem `@media(hover:hover)`** — no iPhone ele
   gruda.

---

## Anexo — `tailwind.config.js`, o trecho que importa

```js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        display: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        ground: 'var(--app-ground)',
        card:      { DEFAULT: 'var(--card)',      foreground: 'var(--card-foreground)' },
        popover:   { DEFAULT: 'var(--popover)',   foreground: 'var(--popover-foreground)' },
        primary:   { DEFAULT: 'var(--primary)',   foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted:     { DEFAULT: 'var(--muted)',     foreground: 'var(--muted-foreground)' },
        accent:    { DEFAULT: 'var(--accent)',    foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          border: 'var(--sidebar-border)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
        },
        // + as escalas brand / acao / neutros da seção 3
      },
      borderRadius: {
        bloco: '28px',
        controle: 'var(--radius)',
      },
      boxShadow: {
        tema: '0 1px 3px 0 rgb(0 0 0 / 0.17)',
        'tema-md': '0 2px 6px -1px rgb(0 0 0 / 0.17), 0 1px 3px -1px rgb(0 0 0 / 0.12)',
        bloco: '0 1px 3px 0 rgb(0 0 0 / 0.14), 0 12px 28px -12px rgb(0 0 0 / 0.22)',
        glow: '0 0 30px rgb(37 217 141 / 0.28)',
        'glow-sm': '0 0 20px rgb(37 217 141 / 0.14)',
      },
      letterSpacing: { tema: 'var(--letter-spacing)' },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(.16, 1, .3, 1)',
        'out-quart': 'cubic-bezier(.25, 1, .5, 1)',
        mola: 'cubic-bezier(.34, 1.56, .64, 1)',
      },
      transitionDuration: { press: '80ms' },
    },
  },
}
```

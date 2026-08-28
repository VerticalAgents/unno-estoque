# Impressão de etiquetas na Zebra TLP 2844 — o que já está resolvido

> Documento para levar a **outro projeto**. Descreve a impressão de etiquetas do
> MischaFlex, que está em produção desde 03/08/2026 e usa uma impressora já
> instalada e calibrada na máquina do Lucca.
>
> **Nada aqui precisa ser descoberto de novo.** Cada número tem um motivo, e a
> maioria custou uma sessão inteira de tentativa e erro. Ler antes de mexer.

---

## 1. O hardware, e por que ele manda no resto

**Zebra TLP 2844**, driver `ZDesigner TLP 2844`, USB, 203 dpi.

O rolo em uso: **111 mm de largura, 3 colunas** de etiquetas de **34 × 65 mm**,
vão de ~2,5 mm entre colunas e **3 mm entre linhas**.

Dois fatos do hardware que decidem o desenho inteiro:

- **A cabeça térmica imprime só os 104 mm centrais.** O driver declara 3,5 mm
  de área não-imprimível de cada lado. As colunas 1 e 3 perdem ~1,5 mm na borda
  externa — só margem, porque a etiqueta tem 1,5 mm de padding interno.
- **O rolo tem uma picotada a 18,5 mm do topo.** No layout retrato do MischaFlex,
  tudo o que precisa sobreviver ao destaque (nome do insumo, nome da empresa,
  tarja de validade) cabe acima dela: o bloco termina em ~16,9 mm. Se o novo
  sistema usar o mesmo rolo, essa conta tem de ser refeita para o novo desenho.

**Térmica não tem meio-tom.** Cinza vira pontilhado e some em corpo pequeno.
Todo texto é preto; hierarquia por tamanho e peso, nunca por cor.

---

## 2. As três impressoras instaladas no Windows

A impressora física está instalada **três vezes**, todas na porta `USB010` do
mesmo aparelho:

| Nome no Windows | Papel | Para quê |
|---|---|---|
| **Lote** | **111 × 65 mm** | o rolo de 3 colunas — **é esta** |
| Recipiente | 100 × 50 mm | rolo de 1 coluna, usado ao comprar recipiente novo |
| ZDesigner TLP 2844 | 76,2 × 50,8 mm (fábrica) | instalação original, não usar |

**Isso existe porque o Windows guarda um tamanho de papel por impressora
instalada, não por documento.** Com uma instalação só, trocar de rolo obrigava a
reconfigurar o driver toda vez. Agora basta escolher o nome certo no diálogo de
impressão.

**O novo sistema não precisa fazer nada para "usar o driver Lote".** Ele não
escolhe a impressora — quem escolhe é a pessoa, no diálogo do Chrome. O papel de
o sistema é só **emitir uma página do tamanho exato que a "Lote" espera**:
111 × 65 mm. Se a página bater com o papel, sai alinhado.

### O papel 111 × 65 é calculado, não escolhido

```
largura = 2 × margem + colunas × largura_etiqueta + (colunas − 1) × vão
        = 2 × 2     + 3       × 34               + 2             × 2,5   = 111 mm

altura  = altura_etiqueta + vão_entre_linhas
        = 65              + 0                                            = 65 mm
```

**O "vão entre linhas" é 0 de propósito.** O driver já sabe do vão de 3 mm
(Gap/Mark Height) e o sensor cuida do avanço. Somar de novo faz a impressão
escorregar 3 mm por linha.

### Se precisar conferir ou recriar o papel da "Lote"

O tamanho **não** está numa lista de formulários do Windows — a ZDesigner não
publica nenhum. Ele vive dentro do DEVMODE binário (`dmPaperLength`/
`dmPaperWidth`, em décimos de mm, offsets 80 e 82, mais uma cópia em 1220/1224
na área privada do driver). Foi editado por PowerShell decodificando o
`PrintTicketXml`. Três armadilhas:

- **`Set-PrintConfiguration -PaperSize` não funciona nessa impressora.**
- **A cópia que manda é a do sistema**
  (`HKLM\SYSTEM\CurrentControlSet\Control\Print\Printers\<nome>\Default DevMode`).
  Gravar só a do usuário (`HKCU\Printers\DevModes2`) não muda nada na impressão.
- **Reiniciar o spooler** depois de gravar, senão só vale no próximo login.
  Escrever no HKLM exige elevação — o terminal do Claude não tem; o caminho é um
  `.ps1` no scratchpad e `Start-Process -Verb RunAs`.

### Preferências de impressão do driver (já configuradas)

- **Options:** Size 11,10 × 6,50 cm · Speed 8.3 cm/s · Darkness 15
- **Advanced Setup:** Media type `Label with gaps` · Gap/Mark Height 0,30 cm ·
  **"Top of form backup" MARCADO**

Desmarcar o "Top of form backup" **não** elimina a pausa entre linhas e estraga o
posicionamento. Já foi tentado.

---

## 3. A pegadinha do Chrome que reaparece sempre

A cabeça tem 104 mm úteis e o rolo declara 111 mm de papel. Vendo uma página de
111 que não cabe nos 104, **o Chrome encolhe tudo para 93,7%** — a etiqueta de
34 mm sai com 31,9 mm e a arte fica afastada das bordas, simetricamente, nas três
colunas.

**Conserto no diálogo de impressão: escala/margem em 100% (ou "Nenhuma").** Aí a
arte cai 1:1 sobre as etiquetas físicas.

Como isso depende de alguém lembrar de marcar uma caixinha, **a saída definitiva
(ainda não feita, e vale a pena no sistema novo): gerar a página com 104 mm e
deslocar o conteúdo 3,5 mm para a esquerda.** As etiquetas caem no mesmo lugar
físico e não há o que encolher. Exige o app saber a área imprimível, que hoje ele
não sabe.

Para descobrir a área útil sem chutar, é `PrinterSettings.DefaultPageSettings`
via PowerShell. Medido em 09/08: a "Lote" declara papel 111 mm e área útil de
**103,98 mm começando em x = 3,5 mm**; a "Recipiente" declara 100 e 100, e por
isso nunca sofreu disso.

---

## 4. As duas armadilhas de CSS que já mandaram rolo para o lixo

Estas duas são a razão de o código ter a forma que tem. Copiar o layout sem
copiar isto resulta em impressão errada de um jeito difícil de diagnosticar.

**1. Páginas na quantidade certa, do tamanho certo — e em branco.**
O `index.css` do MischaFlex tem um `@media print { body * { visibility: hidden } }`
global. Sem restaurar `visibility: visible` na área de impressão, sai papel
branco. Foi exatamente o bug que chegou até a impressora.

**2. Páginas em branco entre as etiquetas.**
Esconder a tela com `visibility: hidden` em vez de `display: none` mantém a altura
no fluxo, e o navegador emite páginas vazias entre as etiquetas. Numa página de
65 mm, isso é rolo jogado fora.

Por isso a área de impressão vai para **filha direta do `body` via portal**, e
todo o resto sai com `display: none`.

**Ao testar:** a página de teste tem de importar o CSS do app e ser vista com o
navegador em modo de impressão (CDP `Emulation.setEmulatedMedia`), senão os dois
bugs passam batido — foi o que aconteceu na primeira vez. **Conferir o PDF pelo
tamanho e número de páginas não prova nada:** o PDF em branco tinha os dois
certos.

---

## 5. A arquitetura, em quatro peças

Tudo vive em `src/lib/etiquetas.tsx` (447 linhas, no repo público
`VerticalAgents/unno-estoque`). As peças:

### `dimsLinha(config)` — a página é uma LINHA do rolo, não uma etiqueta

Rolo de térmica avança a linha inteira. Então o que o navegador imprime como
"página" são as 3 etiquetas lado a lado.

```ts
export function dimsLinha(config: EtiquetaConfig): EtiquetaDims {
  return {
    largura: 2 * config.margem
           + config.colunas * config.largura
           + (config.colunas - 1) * config.espaco,
    altura: config.altura + config.espacoLinha,
  }
}
```

### `etiquetaPrintStyles(config)` — o CSS de impressão

É aqui que as duas armadilhas da seção 4 estão resolvidas:

```ts
export function etiquetaPrintStyles(config: EtiquetaConfig): string {
  const linha = dimsLinha(config)
  return `
  .etiqueta-print-target { display: none; }

  @page { size: ${linha.largura}mm ${linha.altura}mm; margin: 0; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }

    body > *:not(.etiqueta-print-target) { display: none !important; }

    .etiqueta-print-target { display: block !important; }
    .etiqueta-print-target,
    .etiqueta-print-target * { visibility: visible !important; }
    .etiqueta-page-break { page-break-after: always; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`
}
```

### `EtiquetaFolhaImpressao` — o portal para fora do app

```tsx
export function EtiquetaFolhaImpressao({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="etiqueta-print-target">{children}</div>,
    document.body,
  )
}
```

Existe para que nenhuma margem, padding ou altura das telas do app entre na conta
da página impressa.

### `EtiquetaCanvas` — o desenho encolhe inteiro, nada estica

O conteúdo é desenhado num **tamanho-base fixo** e escalado até caber no papel,
mantendo a proporção. Dois desenhos-base, escolhidos pelo formato:

- `paisagem` (deitado) — base 100 × 75 mm
- `retrato` (em pé) — base **34 × 65 mm**, que é o caso do rolo "Lote"

O retrato existe porque um papel de 34 × 65 usando o desenho deitado
desperdiçava **61% da etiqueta**.

```ts
export function escalaEtiqueta(dims: EtiquetaDims): number {
  const base = baseDoLayout(dims)
  return Math.min(dims.largura / base.largura, dims.altura / base.altura)
}
```

O `EtiquetaCanvas` recorta na medida configurada e centra o desenho-base na maior
escala que couber, com `transform: scale()` e `transformOrigin: 'top left'`.

### `EtiquetaLinhaRolo` — o ajuste fino

Monta as etiquetas lado a lado com `gap: espaço` e `padding: 0 margem`, e aplica
`translate(deslocarX, deslocarY)`. **O ajuste fino move o conteúdo dentro da
página, não a página** — serve para alinhar com a etiqueta física, e não conserta
papel errado no driver.

---

## 6. A configuração, e onde ela mora

No MischaFlex é uma linha por empresa em `configuracoes_sistema` (migrations
063/064/067). Os valores em produção para o rolo de lote:

| Campo | Valor |
|---|---|
| largura × altura | 34 × 65 mm |
| colunas | 3 |
| espaço entre colunas | 2,5 mm |
| margem | 2 mm |
| espaço entre linhas | **0** (o driver já sabe) |
| deslocar Y | **−1 mm** |

O sistema novo não precisa da mesma tabela — mas precisa dos **mesmos números**,
porque eles descrevem o rolo físico. Se forem constantes no código em vez de
configuração, tudo bem; só deixe num lugar só.

---

## 7. Papel errado no driver: como reconhecer

Foi o defeito de 08/08 e vale a pena saber diagnosticar, porque parece outra
coisa. Sintoma: **a arte sai centralizada e invade a etiqueta seguinte** (página
de 50 mm mandada numa folha maior → arte 9 mm abaixo do topo, rodapé caindo na
próxima etiqueta).

**Diagnóstico que funciona: medir onde a arte COMEÇA.** O recuo revela a altura
que a folha realmente tem. Quantas etiquetas saem **não diz nada**, porque a
impressora sempre avança até o próximo vão.

Calibrar a mídia não conserta isso. O "ajuste fino" do app também não, porque ele
move a arte dentro da página, não a página.

---

## 8. A pausa de 1 segundo, e por que não foi resolvida

A impressora **pausa ~1 s entre cada linha** do rolo, e não há configuração de
driver que resolva. A causa: o navegador manda a etiqueta como **imagem**
(111 × 65 mm a 203 dpi ≈ 887 × 519 pontos), e a TLP 2844, de 2003, leva esse
tempo para receber e processar o bitmap.

**A saída, se um dia valer: falar ZPL direto com a impressora via Zebra Browser
Print** (programa gratuito da Zebra que expõe um endpoint local para o
navegador). O software da Zebra não pausa porque manda comandos ZPL — alguns
kilobytes de texto, desenhados pelo processador da impressora. Ganha-se impressão
contínua e QR mais nítido.

**Adiado em 03/08/2026, com razão:** a pausa é de ~1 s por linha de 3 etiquetas.
Um recebimento de 12 sublotes = 3 pausas. Segundos, num fluxo que já tem
conferência e colagem manual. **Critério para retomar: dias de imprimir 50–100
etiquetas de uma vez.** Custa algumas horas e **refazer todo o ajuste de posição**
que levou uma sessão inteira para acertar.

Tentativas que **não** funcionam e não devem ser repetidas: desmarcar "Top of
form backup"; trocar o modo de operação no driver (esta versão do ZDesigner não
tem "Operation Mode").

---

## 9. Se o sistema novo tiver rolo diferente

Só três coisas mudam, nesta ordem:

1. **Instalar mais uma vez a impressora no Windows**, com nome próprio e o papel
   calculado pela fórmula da seção 2. Não reaproveitar a "Lote" — foi para evitar
   reconfigurar driver que existem três.
2. **Definir os números da seção 6** para o rolo novo.
3. **Escolher o desenho-base.** Papel mais largo que alto → deitado; em pé →
   retrato. E, se o rolo tiver picotada, refazer a conta da seção 1.

O resto — o CSS, o portal, a escala, a linha do rolo — é o mesmo e pode ser
copiado como está.

---

## 10. Arquivos para copiar

Todos no repo público `VerticalAgents/unno-estoque`:

| Arquivo | O que tem |
|---|---|
| `src/lib/etiquetas.tsx` | o motor inteiro: geometria, CSS, portal, canvas |
| `src/components/etiqueta/EtiquetaLote.tsx` | o desenho retrato 34 × 65, já medido contra a picotada |
| `src/pages/recebimento/ImpressaoLotesPage.tsx` | a tela que dispara o `window.print()` |
| `src/pages/configuracoes/EtiquetasTab.tsx` | a tela de configuração dos números da seção 6 |

**Um defeito conhecido para não copiar junto:** `ImpressaoLotesPage.tsx:125`
grava `etiqueta_impressa = true` **ao clicar**, antes de chamar `window.print()`.
Se a impressão não sai (celular sem impressora, papel picotando errado), as
etiquetas somem da fila sem terem saído no papel. No sistema novo, marcar depois
de um passo explícito ("saiu tudo certo?") ou oferecer um botão de desmarcar.

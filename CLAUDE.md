# MischaFlex — regras da casa

Sistema de estoque e rastreabilidade da Mischa's Bakery. **É uma fábrica, não
uma padaria** (correção do Lucca em 02/08/2026 — migrations antigas ainda dizem
"padaria" nos comentários e não são editadas por já estarem aplicadas).

Este arquivo é só o que **não muda**. O estado do projeto — o que foi feito,
o que falta — mora em `HANDOFF.md`.

## Onde as coisas estão

| O quê | Onde |
|---|---|
| Código | esta pasta (`...\IA\Projetos\MischaFlex`) |
| Repositório | https://github.com/VerticalAgents/unno-estoque — **é público** |
| Supabase | projeto `axwepvqpzsrfhrigryqt`, região sa-east-1 |
| Dev server | `npm run dev` |

Stack: React 18 + TypeScript + Vite + Tailwind **3.4** + Supabase.

## Como trabalhar com o Lucca

- **Ele é leigo em tecnologia.** Não lê código, não roda SQL, não abre terminal.
  Explicar sem jargão. Pedido que envolva painel precisa de passo a passo
  clique a clique.
- **Toda operação no Supabase é feita pelo agente**, nunca por ele na mão.
- **Uma coisa de cada vez.** Três assuntos numa mensagem só perdem ele.
- **Medir, não deduzir.** Quando ele mandar print de defeito visual, amostrar
  os pixels da imagem em vez de raciocinar a partir do código. Deduzir já errou
  três vezes seguidas; medir acertou nas três.
- **Não inventar dado que ele não deu.** "Não sei" fica registrado como `NULL`,
  nunca como zero — zero é uma afirmação.
- Ele é bom revisor de produto. Quando aponta um defeito, o defeito existe;
  o erro costuma estar no diagnóstico, não na observação dele.

## Banco de dados

**Aplicar migration:** os dois MCPs do Supabase e o `supabase db push` estão
quebrados (o histórico remoto usa timestamp, o local usa `NNN_`). O caminho que
funciona é o cliente `pg` do node contra a **Session pooler URL**, com a senha
passada por variável de ambiente — **nunca escrita em arquivo do repositório**.

Se o classificador de permissões bloquear o `node` que escreve no banco, passar
o comando para o Lucca rodar com `!`. O `!` roda **Bash**, não PowerShell:
`DBURL="..." node script.mjs`, e não `$env:DBURL=...`.

**Antes de `CREATE OR REPLACE` numa função que já existe, parta do banco:**

```sql
select pg_get_functiondef(oid) from pg_proc where proname = 'nome_da_funcao';
```

Migration antiga é o *passado* da função, não o presente. Copiar o texto da
migration antiga já desfez em silêncio duas correções posteriores — o defeito
apareceu meses depois, com o sistema pedindo 1.445 recipientes (migration 081).

**View nova nasce insegura.** Tabela com RLS recusa leitura anônima; view não —
ela roda com as permissões de quem a criou, e dono de tabela ignora RLS. Sempre
`ALTER VIEW ... SET (security_invoker = true)`. E **recriar a view apaga a
opção** — repetir a linha em toda migration que mexer nela (migrations 050/051).

**Função `SECURITY DEFINER` nova precisa de grant explícito.** O padrão do
Postgres é `EXECUTE` para `PUBLIC`, o que inclui visitante sem login. Revogar de
`PUBLIC, anon` e conceder a `authenticated, service_role` (migration 098).

**Antes de chutar nome de coluna, olhar o `information_schema`.** Chutar já
custou quatro erros seguidos numa sessão só.

## Convenção das fichas técnicas

`fichas_tecnicas_itens.quantidade` = consumo **por fornada**, na unidade de
medida do próprio insumo. Nas fichas Odara, **1 fornada = 1 forma = 60 unidades**
de ~67,5 g.

**Esta convenção já se perdeu duas vezes**, sempre do mesmo jeito: alguém
multiplica também pelo rendimento e a demanda sai 60× maior. Se o planejador
pedir centenas de potes, é isto.

## Regras de negócio

- **Marca é a trava que ficou.** Não se mistura marcas no mesmo recipiente —
  validado contra a marca do recipiente e contra a do conteúdo atual.
  (Transferência total e recipiente-vazio foram **revogadas** na migration 035.)
- **Mistura:** `locais_lotes` guarda o conteúdo lote a lote; `locais_estado_atual`
  é o resumo mantido por trigger. **Nunca escrever no resumo direto.**
- **Rateio:** a balança pesa o pote, não cada lote. O consumo é dividido entre os
  lotes na proporção do que cada um tinha.
- **Duas balanças nunca fecham no grama.** Toda comparação entre duas medições
  precisa de folga.
- **A reposição dos baldes acontece DURANTE a produção**, um a um, não depois.
  Qualquer tela que compare sistema × balança precisa do número atualizado no
  meio da sessão.
- **O estoque soma EC + EP.** O açúcar que está no pote da produção é açúcar que
  a fábrica tem.
- **`NULL` ≠ zero** em `formas_realizadas`, `quantidade_perdida` e afins. NULL é
  "ainda não aconteceu" ou "não sei"; zero afirma que aconteceu e deu nada.
- **A embalagem externa do fardo só vai para o lixo quando o fardo zera.**
  O fardo é o lote e o QR colado nele é o nome do lote; enquanto sobrar
  conteúdo, o plástico precisa existir para haver o que escanear. Prática do
  Lucca, descoberta por ele na bancada em 23/08/2026 depois de sofrer o
  problema oposto — pacotes de 1 kg órfãos na prateleira.
- **O que é durável leva etiqueta; quantos cabem dentro é conta, não cadastro**
  (migration 074). A tabela `lotes_unidades` existe e está **vazia de
  propósito**: granel se controla por peso. Antes de propor rastreio por
  sub-unidade, lembrar que 15 "recipientes" de saco de confeitar já foram
  criados e desfeitos por esse motivo.

## Datas

Sempre string `YYYY-MM-DD`, montada componente a componente.
`new Date('2026-08-03')` é meia-noite **UTC** e no Brasil cai no dia 2.

## Visual

Detalhe completo na memória `project_design_system.md`. O essencial:

- **Dois raios.** `rounded-bloco` (28px) em painel, cartão e menu;
  `rounded-controle` (8px) em botão, campo e chip. Dentro de um bloco de 28px,
  controle de 8px briga — ali usar pílula ou círculo.
- **Menta é a primária e é clara: pede texto escuro.** Laranja (`acao-*`) é só
  para ação irreversível.
- **Cor semântica não aceita opacidade.** `bg-primary/50` não gera classe e o
  elemento fica sem fundo. Para transparência, usar a escala numérica
  (`brand-500/12`).
- **`divide-*` tem especificidade (0,3,0).** Sobrescrever com `> * + *` não
  funciona — copiar a forma do seletor.
- **Tokens em formato Tailwind 4 (`@theme inline`) não colam aqui.** Traduzir
  para `theme.extend.colors` no `tailwind.config.js`.
- **Mudança em `tailwind.config.js` não chega em dev server já rodando** — o
  Tailwind guarda a config em memória no processo. Avisar para reiniciar, senão
  o próximo print vira caça a um bug que não existe.

## Segurança

O repositório é **público**. Nunca commitar senha, token ou chave de serviço —
já aconteceu uma vez (`apply_migrations.ps1`, com PAT em texto puro).

**Pendência de fundo:** nenhuma função `SECURITY DEFINER` confere se quem chama
pertence à empresa que veio no parâmetro. Teórico com uma empresa só, real no
primeiro cliente novo.

# MischaFlex — Handoff de Contexto

Arquivo atualizado ao fim de cada sessão. Sempre leia antes de continuar.

---

## Stack
- React 18 + TypeScript + Vite + TailwindCSS
- Supabase (projeto `axwepvqpzsrfhrigryqt` — "Rastreabilidade Mischas", org "Mischas Org", região sa-east-1)
- Caminho local: `C:\Users\lucca\OneDrive\Área de Trabalho\IA\Projetos\MischaFlex`

---

## ⚠️ Migração de conta Supabase (01/08/2026)

O projeto antigo (`outunfdtwgsmdqtphzgf`) foi pausado — o plano grátis permite
apenas 2 projetos ativos por conta. O banco foi **recriado do zero** numa conta
Supabase nova, a partir das migrations. Nenhum dado antigo foi trazido (era teste).

Como aplicar migrations hoje (a `apply_migrations.ps1` está obsoleta):
```
npx supabase@2.111.0 db push --db-url "postgresql://postgres.axwepvqpzsrfhrigryqt:<SENHA>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"
```
A senha do banco fica em *Settings → Database*. Use `--include-seed` para rodar
também o `supabase/seed.sql`.

Bugs corrigidos durante a recriação (existiam desde sempre e nunca tinham
sido exercitados num banco limpo):

| Arquivo | Problema | Correção |
|---|---|---|
| `001_schema.sql` | `mi.rowid` não existe no Postgres (view `v_estoque_consolidado`) | trocado por `mi.id`; a view é reescrita pela 004 de qualquer forma |
| `006_ec_ep_limites.sql` | `CREATE POLICY IF NOT EXISTS` não é sintaxe válida | `DROP POLICY IF EXISTS` + `CREATE POLICY` |
| `014_rls_yield_perdas.sql` | recriava policy de `movimentacoes_itens` já criada na 005/006 | idem |
| `seed.sql` | `v_ins` declarada dentro do 1º bloco → invisível nos 22 seguintes | declarada no bloco externo |
| `seed.sql` | INS023 Stikadinho violava `chk_reembalagem` (`tamanho_porcao` NULL) | `12.3 g` (uma barra do display) |
| `025` (nova) | `empresas` e `configuracoes_sistema` com RLS ligado e sem policy | policies criadas |

O `seed.sql` agora insere **apenas o admin**. Demais funcionários devem ser
criados em Configurações → Funcionários (usa a edge function `manage-user`).

Permissões: a 020 popula `permissoes_papel` só para empresas já existentes.
Como a empresa nasce depois, rode `select inicializar_permissoes_padrao(id) from empresas;`
ao criar uma empresa nova. (O front tem fallback em `src/lib/permissions.ts`.)

---

## Convenção das fichas técnicas (importante)

`fichas_tecnicas_itens.quantidade` = consumo **por fornada**, na **unidade de
medida do próprio insumo** (kg, ml…). Padronizado na migration 029.

O banco tinha duas convenções conflitantes: a migration 023 gravou por
*unidade* enquanto `abrir_sessao_producao` (016) sempre leu por *fornada* —
o que faria o consumo teórico sair 60× menor. Ao criar ficha nova, seguir a 029.

Nas fichas Odara, **1 fornada = 1 forma = 60 unidades** de ~67,5 g.

---

## Planejamento (migrations 028-030)

- `planejar_recipientes(empresa, [{ficha_id, formas}])` — substitui a planilha
  "Planejador de Recipientes". **A demanda é somada entre as fichas antes de
  dividir pela capacidade**: os recipientes são um pool único, o açúcar das
  duas receitas vai nos mesmos potes.
- `abrir_sessao_producao_v2(..., p_plano)` — sessão com várias fichas. A v1
  continua existindo. O consumo teórico é somado por insumo entre as fichas
  antes de vincular os recipientes (senão violaria
  `UNIQUE(sessao_id, local_id, lote_id)`).
- Tela: `src/pages/producao/PlanejadorRecipientesPage.tsx` (`/producao/planejador`).

## ⚠️ Views vazavam sem login (migration 050)

Tabela com RLS recusa leitura anônima; **view não**. No Postgres a view roda com
as permissões de quem a criou (postgres), e dono de tabela ignora RLS. Bastava a
chave publicável — que vai no JavaScript da tela — para ler estoque, fichas e
plano de produção **sem login**. Verificado com `curl` sem token.

Corrigido com `security_invoker = true` nas 7 views. **Ao criar view nova,
repetir a linha** — o padrão do Postgres é o inseguro.

Testado depois com papel `authenticated` simulado: as views e as RPCs
(`planejar_abastecimento`, `sugerir_lotes_transferencia`, `planejar_recipientes`)
continuam devolvendo dados para quem está logado.

## Planejador Semanal (migration 049)

Tela em `/producao/planejador`, que virou **duas abas** —
`src/pages/producao/PlanejadorPage.tsx` é a casca:

| Aba | Arquivo |
|---|---|
| Semana | `PlanejadorSemanaPage.tsx` (nova) |
| Dia | `PlanejadorRecipientesPage.tsx` (a de sempre, sem o `<h1>`) |

As duas ficam montadas (`hidden`), então trocar de aba não perde o digitado.

**Três modos de preencher** (migration 052, `planos_semana.modo_preenchimento`):

| Modo | O quê |
|---|---|
| `blocos` (padrão) | um sabor por dia; lava só na troca |
| `igual` | todo dia com o mesmo mix, na proporção da meta |
| `manual` | o sistema não distribui |

**A regra por trás do `blocos`:** trocar de sabor obriga a lavar os utensílios.
Enche-se cada dia com um sabor só, na ordem de `ordem_fichas`, e cada produto
só transborda **uma vez** para o dia seguinte. Daí no máximo uma lavagem por
troca.

**A ordem muda o resultado de verdade.** Com 30.000 TRD + 20.000 DDL em 5 dias,
TRD primeiro dá um dia misto (qua: TRD 164 + DDL 4); DDL primeiro dá **zero**
dias mistos, porque o DDL fecha exatamente em 2 dias. Vale sugerir inverter
quando o dia misto incomodar.

Qualquer produto pode ser acrescentado a qualquer dia pelo botão `+ CÓDIGO` —
sem isso o usuário ficava preso na distribuição sugerida. As linhas abertas na
mão vivem em `abertos`, estado de digitação que some ao trocar de semana.

A conta corre em **bateladas** (4 formas) e converte para formas no fim, com o
último dia de cada produto levando o resto — a última batelada costuma ser
parcial. Testado com 300 combinações: a soma dos dias bate exata com a meta.

- `planos_semana.dias_ativos DATE[]` guarda os dias marcados **inclusive os
  vazios**; sem isso um dia marcado sem produção sumiria ao recarregar.
- Editar um dia liga `ajustado` e para o auto-distribuir. **Redistribuir** volta.
- A meta do topo é reconstruída **na carga**, não por efeito reativo — reagir a
  `grade` faria a meta seguir o ajuste manual, e o aviso de divergência nunca
  apareceria.
- Aviso de "duas rodadas de abastecimento" compara a demanda do dia com a
  **capacidade** dos recipientes, não com o conteúdo: o que estará nos potes na
  quinta depende do consumo até lá.
- `semanaDeTrabalho()` em `src/lib/utils.ts`: no sábado e domingo devolve a
  semana **seguinte**. Usada também pelo botão do Reabastecimento.

Datas sempre como string `YYYY-MM-DD` e montadas componente a componente —
`new Date('2026-08-03')` é meia-noite UTC e no Brasil cai no dia 2.

### Planejado × realizado (migration 051)

A `v_plano_semana` da 049 partia dos itens do plano, então era cega para
produção feita **fora** do plano — e essa é a metade que explica por que o
insumo acabou antes. Virou `FULL OUTER JOIN` entre planejado e produzido dentro
da semana; linha sem plano vem com `fora_do_plano = true`.

`formas_realizadas` **NULL** = ainda não aconteceu, diferente de aconteceu zero.
É o que distingue "em andamento" de "não cumprido" — somar zero apagaria a
diferença.

Na tela: cada ficha do dia mostra o produzido abaixo do campo (verde igual ao
plano, âmbar diferente, azul sessão aberta), o dia ganha etiqueta quando há
sessão aberta ou produção fora do plano, e a semana fecha numa tabela
planejado × produzido × diferença. A folha impressa ganha a coluna Produzido
só quando há o que comparar — e as larguras do `colgroup` acompanham.

**Recriar view apaga as opções:** a 051 repete
`ALTER VIEW ... SET (security_invoker = true)`. Sem isso voltaria a vazar.

## Reabastecimento — Fase 3 (migrations 046-048)

Tela em `/reabastecimento` (`src/pages/reabastecimento/ReabastecimentoPage.tsx`).

O caminho é o que a fábrica usa para pensar:

```
meta de unidades → formas (fornadas) → insumo necessário → o que comprar
```

A **046** tinha invertido isso, pedindo "formas por dia". A **048** corrigiu:
a entrada é a meta de unidades, porque é o que se sabe. Formas arredonda para
cima — não existe meia fornada, e a última sai inteira.

- `projecao_producao.unidades_alvo` — meta por ficha. Grava via
  `salvar_projecao`; ficha com 0 é apagada.
- `configuracoes_sistema.reabastecimento_margem_pct` (15). As colunas
  `reabastecimento_dias` e `dias_uteis_mes` foram **removidas** na 048: com o
  alvo em unidades o período já está embutido nele.
- `v_projecao_formas` — unidades → formas, bateladas e unidades produzidas.
  **A tela não usa esta view** para exibir: refaz a conta em JavaScript enquanto
  se digita, senão somaria unidade nova com forma antiga (foi um bug real). A
  view continua sendo a base de `v_reabastecimento`.
- `v_reabastecimento` — necessário com margem, estoque, quanto comprar.

**O estoque soma EC + EP.** O açúcar que está no pote da produção é açúcar que
a fábrica tem; ignorá-lo encheria o depósito.

`embalagens` só sai quando `insumos.tamanho_embalagem` está preenchido — hoje
só o INS001 tem. Os outros saem em peso, com aviso na tela.

Conferido: meta 30.000 TRD + 20.000 DDL → 500 + 334 formas → açúcar
**571,334 kg** de receita, **657,034 kg** com 15%, **54 sacos** de 10 kg
descontando os 120 kg em casa.

A auditoria de estoque da planilha é o módulo de Contagem, que já existe.

**Unidades por forma** (`fichas_tecnicas_versoes.rendimento_fornada`) agora é
editável em **Configurações → Produção**, junto com o peso médio. Antes só dava
para mexer criando uma versão nova da ficha. Não é valor global — é por ficha;
a aba só centraliza. Sessões fechadas não são recalculadas.

**Nota de vocabulário:** é uma **fábrica**, não uma padaria (correção do Lucca
em 02/08/2026). As migrations 026, 030, 039 e 046 ainda dizem "padaria" nos
comentários — não foram editadas para não mexer em migration já aplicada.

---

## Últimas migrations aplicadas

| # | Nome | O que faz |
|---|------|-----------|
| 009 | lote_grupo_multi_transfer | `lote_grupo_id` em lotes; RPC `realizar_transferencia_multipla` |
| 010 | formato_sublotes | Formato `INS014-0001.1/3`; `gerar_proximo_codigo` usa regex |
| 011 | lote_prefixo_insumo | Prefixo do lote = código do insumo (ex: `INS014-0001`) |
| 012 | marcas | Tabelas `marcas`, `insumos_marcas`, `fornecedores_insumos_marcas`; `marca_id` em `lotes` e `locais`; RPCs atualizados |
| 013 | insumo_recipiente_modelo | modelo de recipiente por insumo |
| 014 | rls_yield_perdas | policies faltantes (fichas/sessões) + colunas de rendimento e perdas |
| 015-016 | rpcs_producao_v2 / fix_consumo_teorico | RPCs de produção reescritos |
| 017-018 | produtos_expedicao / rpcs_expedicao | módulo de produtos e expedição |
| 019 | contagem | módulo de contagem (EC e EP) |
| 020 | permissoes_papel | permissões por papel configuráveis |
| 021-022 | fichas_insumo / nutrientes_insumo | fichas de insumo e tabela nutricional |
| 023 | brownies_morena_cacau | INS028-034 + fichas FT-001 e FT-002 |
| 024 | fix_versao_ativa_constraint | corrige constraint de versão ativa |
| 025 | rls_empresas_configuracoes | policies em `empresas` e `configuracoes_sistema` |

---

## Feature implementada: Marcas de insumos

- [x] Migration 012 aplicada no banco
- [x] Tipos `Marca`, `InsumoMarca`, `FornecedorInsumoMarca` + `marca_id`/`marca` em `Lote` e `Local`
- [x] `InsumoListPage` — seção "Marcas deste insumo" no modal (criar/vincular/remover)
- [x] `FornecedorListPage` — seção "Produtos que fornece" no modal (vincular pares insumo+marca)
- [x] `RecipienteListPage` — select de marca pós-insumo; `marca_id` salvo em `locais`; nome exibido como `MARCA: descrição`
- [x] `NovoLotePage` — cascata insumo → fornecedor filtrado → marca filtrada; `p_marca_id` enviado ao RPC
- [x] `TransferenciaPage` — validação de marca em `handleScanLocal` após RO-003

---

## Outras mudanças recentes (já implementadas)

### Formato de lotes
- Código = `{insumo_codigo}-{seq}` para lote único, `{insumo_codigo}-{seq}.{i}/{N}` para sublotes
- Ex: `INS033-0001.1/3`, `INS033-0001.2/3`, `INS033-0001.3/3`
- Sequencial é por insumo (independente entre insumos)

### TransferenciaPage (`src/pages/transferencia/TransferenciaPage.tsx`)
- Step `scan_mais`: escaneie N sublotes do mesmo `lote_grupo_id` antes de ir ao recipiente
- Fluxo: `scan_lote → scan_mais → scan_local → confirmar → sucesso`
- Reembalagem (INS027, INS014, INS023): `scan_lote → scan_local → reembalagem → sucesso`
- `handleConfirmar` chama `realizar_transferencia_multipla`

### EstoquePage (`src/pages/estoque/EstoquePage.tsx`)
- Badges: `⚠ comprar`, `⚠ transferir`, `⚠ etiquetar`
- "etiquetar" aparece quando há lotes `ativo` com `etiqueta_impressa = false`

### Sidebar (`src/components/layout/Sidebar.tsx`)
- Ordem: Dashboard → Recebimento → Transferência → Estoque → Produção → ...
- Item **Dev Tools** em âmbar no final (rota `/dev`)

### DevPage (`src/pages/dev/DevPage.tsx`)
- Limpar tudo / lotes / EP / sessões / perdas
- Definir estoque mínimo EC+EP para todos os insumos
- Criar lotes de teste (1 por insumo ativo, quantidade e sublotes configuráveis)

---

## Travas configuráveis (migrations 041-043)

Cada regra tem modo `bloqueia` (recusa sempre) ou `avisa` (passa com
justificativa escrita, gravada em `excecoes_registradas`). Configurável em
Configurações → Travas. Padrão: só `marca_diferente` bloqueia.

Chaves: `marca_diferente`, `segundo_lote_aberto`, `excede_capacidade`,
`sessao_sem_insumo`, `fefo`.

As RPCs afetadas aceitam `p_justificativa` e devolvem
`{ok:false, trava, modo, mensagem, requer_justificativa}` quando a regra pega.
**Justificativa nunca fura `bloqueia`.**

Ao adicionar parâmetro com DEFAULT a uma RPC existente, DROPar a assinatura
antiga — senão o Postgres recusa por ambiguidade (aconteceu na 042).

## Abastecimento (migration 040)

- `planejar_abastecimento` só devolve insumo cujos recipientes **não cobrem** a
  produção planejada. Quando devolve, o alvo é **encher até a capacidade**,
  discriminando produção × excedente.
- `sugerir_lotes_transferencia` esgota o **lote já aberto** antes de tudo,
  depois lotes inteiros em FEFO, e abre no máximo **um** novo.
  Lote aberto = `quantidade_disponivel < quantidade_recebida`.

## Leitura guiada do QR (migration 045)

`validar_scan_lote(empresa, lote, ja_escaneados[], justificativa)` é chamada a
cada QR lido no estoque central. É **onde as travas agem** — antes de o operador
carregar peso, quando ainda dá para trocar de embalagem.

- **`fefo`** deixou de ser decorativa. Regra real: o lote **aberto** do insumo
  tem que estar entre os escaneados. Onde ele é despejado não importa. Só é
  cobrada enquanto nenhum aberto foi lido.
- **`excede_capacidade`** virou limite de leitura: só dá para escanear mais um
  lote enquanto o acumulado ainda não cobriu o **espaço livre somado dos
  recipientes daquele insumo**. O último passa — é dele que sai a sobra.

`realizar_transferencia_multipla` agora **enche até a capacidade** e devolve
`sobras[]` com o que não coube; a tela oferece o próximo recipiente. Antes
despejava o saldo inteiro de todos os lotes sem olhar a capacidade.

**Regra revogada aqui:** "todos os sublotes do mesmo recebimento". Vinha da
RO-003 e ficou incompatível com o lote aberto único — o aberto que voltou quase
sempre é de outro recebimento. No lugar: **mesmo insumo e mesma marca**.

`realizar_transferencia` (lote único, usada pelos fluxos de reembalagem) **não**
ganhou a trava `fefo` — mexer nela sem testar Nutella/DDL/Stikadinho era risco
sem necessidade.

## Sessão de produção (migration 044)

- `abrir_sessao_producao_v2` valida insumo nos recipientes (trava
  `sessao_sem_insumo`) e devolve a lista `faltantes` para a tela.
- `atualizar_plano_sessao` permite mudar as formas com a sessão aberta.
  **Não mexe em `quantidade_inicial`** — é a foto do pote na abertura e é dela
  que sai o consumo real.

## Regras de negócio importantes

- ~~**RO-002**: transferência é sempre total~~ — **REVOGADA** (migration 035).
  Transferência parcial liberada; o lote só vira `esgotado` se realmente zerar.
- ~~**RO-003**: recipiente deve estar vazio~~ — **REVOGADA** (migration 035).
  Um recipiente pode ter vários lotes do mesmo insumo misturados.
- **Marca é a trava que ficou**: não se mistura marcas no mesmo recipiente.
  Validado contra a marca configurada no recipiente E contra a marca do
  conteúdo atual.
- **Mistura**: `locais_lotes` guarda o conteúdo lote a lote;
  `locais_estado_atual` virou o resumo, mantido por trigger
  (`recalcular_estado_local`). Nunca escrever no resumo direto.
- **Rateio**: a balança pesa o pote, não cada lote. O consumo é dividido entre
  os lotes na proporção do que cada um tinha — em `fechar_sessao_producao`,
  `aplicar_contagem` e no consumo teórico de `abrir_sessao_producao_v2`.
- **Esgotar** (`esgotar_recipiente`): com rateio o saldo nunca zera exato;
  o botão baixa a sobra como `ajuste_inventario` e encerra a mistura.
- **Bug corrigido na 036**: `fechar_sessao_producao` baixava o consumo em
  `lotes.quantidade_disponivel` (estoque central) em vez do recipiente —
  contagem dupla. Ficava escondido porque o fluxo de sublotes zerava o lote no
  EC ao transferir. Com transferência parcial isso comeria estoque real.
- **FIFO**: aviso se há lote mais antigo do mesmo insumo disponível
- **Marcas**: lote e recipiente devem ser da mesma marca (se ambos definidos)
- ~~**Sublotes**: só sublotes do mesmo `lote_grupo_id` juntos~~ — **REVOGADA**
  (migration 045). Agora basta mesmo insumo e mesma marca.
- Insumos com reembalagem (`INS027` Nutella, `INS014` DDL, `INS023` Stikadinho) usam fluxo próprio

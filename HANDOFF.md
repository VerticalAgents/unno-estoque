# MischaFlex — estado do projeto

> Diário do projeto: o que está acontecendo, o que foi feito, o que falta.
> Atualizado ao fim de cada sessão.
>
> **As regras que não mudam estão no `CLAUDE.md`** — convenções, armadilhas
> conhecidas, regras de negócio, como aplicar migration. Não repetir aqui.

**Última atualização:** 29/08/2026

---

## Onde paramos

### A virada do estoque (em curso desde 17/08)

Tirar o sistema do estado de teste e colocá-lo contando estoque de verdade.
Plano publicado em https://claude.ai/code/artifact/fbc17036-c89a-4faa-bce4-6fcf75e05ef5

**A decisão de fundo (21/08):** os 153 lotes de 09/08 eram reais, mas várias
produções aconteceram sem a transferência ser registrada. O saldo virou ficção.
Decidido **resetar tudo, recontar baldes e estoque físico, e reetiquetar**.

Já feito: produção anterior ao sistema importada (17 dias, 28/06 a 13/08,
33.480 unidades) e 58 das 73 taras de recipiente.

**Falta, nesta ordem:**

1. ~~Salvar os dossiês de 10, 11 e 12/08~~ — **feito em 23/08**, em
   `docs/rastreabilidade/` (44 pesagens, versionadas no Git).
2. **Consertar o texto do dossiê.** A 097 faz sessão importada dizer "este dia
   foi produzido antes de o sistema existir" — falso para produção de agosto
   registrada em atraso. São duas ausências diferentes e o documento precisa
   distinguir.
3. ~~Perdas do 12 e 13/08~~ — **feito em 23/08**, ver abaixo.
4. ~~Lançar a produção de 17 a 21/08~~ — **feito em 23/08** (SESS-0021 a 0024).
   **Falta o dia 14/08**, que nunca foi perguntado nem respondido. 15 e 16 são
   fim de semana; 21 o Lucca confirmou que não houve produção.
5. ~~Resetar o estoque~~ — **feito em 23/08**. Falta a parte física: contar
   baldes e estoque, lançar pela Abertura, reetiquetar.

**Respondido em 23/08:** os 5.022 brownies pendurados no estoque de produto
acabado (SESS-0001 e 0002) são exatamente 1.438 + 3.584 — a produção dos dias
10 e 11. O Lucca confirmou que tudo que a semana produziu, a semana vendeu.
**Eles não existem fisicamente** e o reset tem de zerá-los. Vale a mesma coisa
para os 2.558 do dia 12, se a pós-produção chegar a criá-los.

### ⚠ O prazo pós-abertura começa a correr na CHEGADA, não na abertura

**Encontrado em 29/08/2026**, quando o Lucca perguntou como a contagem lidaria
com dois lotes de validades diferentes: *"tem coisa vencendo daqui uns dias e
outras vencendo no final do ano"*. Ele estava certo, e a tela discordava dele.

`calcular_validade_pos_abertura` é chamada por `registrar_entrada_lote` com a
**data de recebimento**:

```sql
v_calculada := p_data_recebimento + (v_shelf_life || ' days')::INTERVAL;
RETURN LEAST(p_validade_original, v_calculada);
```

Ou seja: todo fardo é tratado como se tivesse sido aberto no dia em que entrou.
**Fardo lacrado não tem relógio correndo.**

A farinha é o retrato. `INS002-0003`, recebida em 28/08, lacrada:

| na embalagem (`validade_original`) | **03/12/2026** |
| o que o sistema mostra (`validade_pos_abertura`) | **27/09/2026** |

Dois meses e meio a menos, num saco fechado. E não é só a farinha — em 29/08,
**13 insumos** tinham a data encurtada. Açúcar: original 15/07/27, exibida
22/09/26 — dez meses. Doce de leite: 06/03/27 virou 06/09/26.

#### Por que isso ainda não estourou

`LEAST()` protege o caso comum: quando a validade impressa é curta, é ela que
vale. E como a data calculada cresce junto com a data de recebimento, a ordem
do FEFO **acidentalmente** continua parecida com a de chegada.

O FEFO erra quando uma entrega **nova** tem validade impressa **mais curta** que
uma antiga. Aí o sistema manda usar a antiga primeiro, e ela não é a que vence
antes. Não aconteceu ainda porque as entregas vêm em ordem.

#### O que já foi feito

A tela de contagem do EC passou a mostrar `validade_original` para fardo
lacrado (`validadeReal`, em `NovaContagemEcPage.tsx`). **Só a tela** — o dado no
banco continua como está.

#### O que falta decidir, e é decisão do Lucca

Mexer no `validade_pos_abertura` gravado é mexer no **FEFO de todo o sistema**:
`validar_scan_lote`, a distribuição do abastecimento e os avisos de vencimento
ordenam por ele. As opções:

1. **Guardar as duas e usar cada uma no seu lugar** — `validade_original` para
   lacrado, `pos_abertura` calculada no momento em que o fardo é aberto de
   fato. É o certo, e é o que `registrar_abastecimento` já faz para o conteúdo
   que vai ao pote (`LEAST(CURRENT_DATE + shelf_life, validade_original)`). O
   recebimento é que não seguiu a mesma regra.
2. **Deixar como está** e aceitar que a data exibida é pessimista.

A (1) exige um passo de correção nos lotes já gravados, e ele não é trivial:
não dá para simplesmente copiar `validade_original` por cima, porque os fardos
que JÁ foram abertos têm um prazo curto legítimo correndo.

### ⚠ As duas balanças não fecham, e o sistema dá dois nomes opostos a isso

**Este é o assunto para retomar.** Diagnosticado em 28/08/2026, durante a
auditoria física do Lucca. **É UM defeito só, não dois** — e foi ele quem
enxergou isso, perguntando de onde vinha um fardo de "25,124 kg".

No `registrar_abastecimento`, o que saiu das embalagens (declarado) quase nunca
bate com o que a balança do pote mediu. A diferença ganha dois destinos, e o que
decide é só o **sinal**:

| A balança do pote acusa | O sistema escreve | Onde vai parar |
|---|---|---|
| **menos** do que as embalagens deram | `perda_insumo` | vira desperdício |
| **mais** do que as embalagens deram | "a embalagem tinha mais" | sobe `quantidade_recebida` |

Nenhum dos dois é o nome certo, que seria *"as duas balanças não fecharam"*. E o
ajuste do lado de cima **só sobe, nunca desce** — o erro se acumula numa direção.

**Os 47 kg de perda fantasma (migration 113) e os fardos com recebido inflado
são o mesmo defeito, vistos de lados diferentes.** A 113 consertou só a metade
de baixo, e só a parte que vinha de "Zerou" sem querer.

#### Os dois casos medidos, que mostram a diferença de escala

**Açúcar, 27/08 15:14 (MOV-0219) — buraco de verdade.** Pote G Açúcar #1, duas
embalagens bipadas (9/18 e 15/18). A balança disse 14,445 kg; o declarado dava
10,986. Faltaram **3,459 kg = 31%**. Justificativa gravada: *"Tudo ok"*. O
sistema repartiu entre os dois lotes: 9/18 virou "recebeu 11,893" e 15/18
"recebeu 11,566" — de fardos de 10 kg. Provável embalagem despejada sem bipar.

**Farinha, 27/08 15:00 (MOV-0218) — ruído honesto.** Dois potes, dois fardos
(3/6 e 6/6). A balança disse 20,165 kg; o declarado dava 20,000. Diferença de
**165 g = 0,8%** — duas balanças medindo a mesma coisa, que é a regra da casa.
Rateada como 41 g e 124 g, virou o "fardo de 25,124 kg" que o Lucca estranhou.

**A lição das duas juntas:** o mesmo mecanismo trata 0,8% e 31% igual.

#### O caminho, quando retomar

1. **A folga de balança existe e está DESLIGADA.**
   `configuracoes_sistema.folga_balanca_pct`, com tela em Configurações. A 110 a
   fez nascer NULL de propósito ("vale exato o que foi pesado"). Em 1%, a
   farinha teria passado batido e o açúcar continuaria sendo pego.
   **É decisão do Lucca, e ele ainda não respondeu qual número quer.**
2. **Excesso grande não é "a embalagem tinha mais".** Precisa de destino
   próprio — uma entrada sem origem conhecida, que não suje
   `quantidade_recebida`. Hoje suja, e é isso que faz a tela de contagem dizer
   "já saíram 6,566 de 11,566" de um fardo de 10 kg.
3. **Os lotes já sujos.** A consulta que os encontra:

```sql
SELECT i.codigo, l.codigo, i.tamanho_embalagem, l.quantidade_recebida,
       round(l.quantidade_recebida - i.tamanho_embalagem, 3) AS a_mais
  FROM lotes l JOIN insumos i ON i.id = l.insumo_id
 WHERE i.tamanho_embalagem > 0
   AND l.quantidade_recebida > i.tamanho_embalagem + 0.001
 ORDER BY (l.quantidade_recebida / i.tamanho_embalagem) DESC;
```

Em 28/08 dava 25 lotes. Acima de 10%: INS001-0001.9/18 (+1,893),
INS012-0001.5/12 (+1,635), INS001-0001.15/18 (+1,566), INS016-0001.3/4 (+0,126),
INS012-0001.4/12 (+0,996). O resto está abaixo de 3% e é ruído de balança.

**Cuidado ao corrigir:** baixar `quantidade_recebida` de volta para o tamanho do
fardo deixaria o lote devendo quantidade a si mesmo — do 9/18 saíram 11,893 kg
de verdade, para dentro dos potes. O excedente precisa de outro lugar para
morar, não de ser apagado. É o item 2.

**Os cinco lançamentos de perda fantasma** (farinha 19,248 · açúcar invertido
6,936 · cobertura ao leite 5,242 · açúcar refinado 3,940 · ovo em pó 2,000)
seguem de pé, esperando os números que a auditoria de 28/08 levantou na mão.

### A recarga dava como lixo o que voltava para a prateleira

**Consertado em 27/08/2026** pela migration `113_nao_pesar_nao_e_dizer_que_acabou`.

O Lucca estranhou que a Essência de Doce de Leite tinha pouco no sistema. A
varredura mostrou que não era caso isolado — eram **47 kg de insumo escritos
como desperdício em quatro dias**:

| Insumo | Quando | Deu como perda | Entrou nos potes |
|---|---|---|---|
| Farinha de Trigo | 25/08 14:27 | 19,248 kg | 10,752 |
| Essência de Doce de Leite | 25/08 17:13 | 9,944 kg | 0,584 |
| Açúcar Invertido | 25/08 16:57 | 6,936 kg | 4,766 |
| Cobertura Ao Leite | 26/08 10:03 | 5,242 kg | 24,758 |
| Açúcar Refinado | 25/08 11:57 | 3,940 kg | 16,060 |
| Ovo em Pó | 24/08 09:40 | 2,000 kg | 7,000 |

Abaixo disso a lista cai para 0,6 kg e menos — essas são folga entre duas
balanças, e estão certas.

**A causa.** O último passo de Transferência → Reabastecer recipientes perguntava
*"cada embalagem zerou ou sobrou quanto?"*. "Sobrou" exigia um peso; ninguém pesa
um fardo de 25 kg para devolvê-lo à prateleira. **Quem não tinha o número só
conseguia seguir por "Zerou"** — e "Zerou" manda para o lixo tudo o que não entrou
no pote. A resposta mais comum de todas não existia.

**A 110 já tinha mexido nesta costura na véspera e não alcançou este caso.** Ela
mediu melhor o que ENTRAVA no pote (e funcionou — os `acerto_recipiente` de 0,386
e 0,094 da recarga da essência são o mecanismo dela agindo). O que ninguém
questionou foi a premissa do outro lado: bipar a embalagem significa que ela foi
esvaziada. **Era o mesmo defeito que a 102 consertou na transferência três dias
antes**, no fluxo vizinho.

**O que a 113 fez.** Uma terceira resposta, e ela nasce marcada: **"Não pesei"**.
`sobra` passou a aceitar NULL, e NULL não é zero — zero afirma que a embalagem foi
esvaziada. Para o lote não pesado quem decide quanto saiu é a balança do POTE, que
mediu de verdade. Perda zero. O saldo que resta é deduzido, e o lote sai marcado
com `saldo_estimado` — o `≈` aparece na lista de lotes, mesma distinção que a 112
fez para o pote. "Zerou" agora pede confirmação dizendo quanto vai para o lixo.

Sete ensaios em `begin … rollback` antes de aplicar, todos passando.

**Saldo da essência já reposto** (27/08): os 9,944 kg voltaram ao lote junto com
os dois acertos, como `ajuste_inventario`. Fecha exato dos dois lados: prateleira
12,390 + pote 0,119 = 12,509 = recebido 13,124 − consumido 0,615.

**O que falta:** os outros cinco lançamentos da tabela acima continuam de pé.
Não foram desfeitos de propósito — **só o Lucca sabe se alguma daquela embalagem
foi mesmo para o lixo**, e a pergunta é caso a caso. A farinha é a mais delicada:
a contagem dos três potes aplicada em 27/08 já mexeu no EP daquele insumo, então
a devolução ao lote precisa ser conferida contra o que está na prateleira hoje.
Consulta para retomar:

```sql
SELECT i.codigo, i.nome, m.codigo AS mov, mi.quantidade, m.created_at
  FROM movimentacoes_itens mi
  JOIN movimentacoes m ON m.id = mi.movimentacao_id
  JOIN lotes l ON l.id = mi.lote_id
  JOIN insumos i ON i.id = l.insumo_id
 WHERE m.tipo = 'perda_insumo'
   AND m.observacoes LIKE 'Diferen%a entre o que saiu das embalagens%'
 ORDER BY mi.quantidade DESC;
```

### Pendências abertas na abertura de estoque

Encontradas em 23/08 enquanto o Lucca contava. Nenhuma trava a contagem, e por
isso ficaram para depois — mexer no meio da operação dele era o risco maior.

1. **A etiqueta é marcada como impressa ao CLICAR, não ao imprimir.**
   `ImpressaoLotesPage.tsx:125` grava `etiqueta_impressa = true` e só então chama
   `window.print()`. O Lucca clicou pelo celular, não conseguiu imprimir, e as 18
   etiquetas do açúcar sumiram da fila mesmo sem sair no papel — foram devolvidas
   à mão. O papel picotar errado dá no mesmo. Marcar depois de imprimir não é
   confiável (o navegador não conta se saiu), então o caminho é um passo
   explícito: "saiu tudo certo?" depois do diálogo, ou um botão de desmarcar na
   própria lista.

2. **O conteúdo dos baldes vira vários lotes fatiados pelo tamanho da embalagem.**
   180 kg na prateleira + 31,584 kg nos potes viraram 18 + **4** lotes: 10, 10,
   10 e 1,584. Não existe fardo nenhum dentro do pote — deveria ser **um** lote
   de 31,584. Some com `registrar_entrada_lote` fatiando quando
   `tamanho_embalagem > 0`; a saída limpa é um parâmetro `p_fatiar` e a chamada
   dos baldes passando `false`. **Cuidado:** parâmetro novo com DEFAULT exige
   DROP da assinatura antiga, senão o Postgres recusa por ambiguidade (a lição da
   migration 042, no `CLAUDE.md`).

   Efeito colateral que vem junto: `locais_lotes` aponta os dois potes para o
   **primeiro** dos 4 lotes, que tem 10 kg de recebida e 31,584 de conteúdo. As
   contas fecham e o consumo funciona, mas os outros 3 ficam zerados apontando
   para nada.

### Pendências laterais, sem pressa

- **7 insumos sem `tamanho_embalagem`** (INS028 a INS034). O Lucca deixou para
  depois de propósito; só atrapalha o lançamento daqueles insumos.
- **`Sidebar.tsx` exporta dados e componente** — o Vite avisa que não consegue
  hot-reload. Mover os itens de navegação para arquivo próprio resolve.
- **A tela `/dev` apaga estoque e não tem trava de admin.** Combinado: trancar
  quando o primeiro funcionário for cadastrado, não antes.
- **`SECURITY DEFINER` não confere a empresa de quem chama** (ver `CLAUDE.md`).
- **17 commits não enviados ao GitHub** (de `8698e0e` a `669df39`).

---

## Perdas de 10 a 13/08 — fechadas em 23/08

O Lucca deu o faturamento da semana (**10.172 unidades boas**: 6.218 Tradicional
e 3.954 Doce de Leite) e confirmou que tudo que foi produzido na semana foi
vendido na semana. Daí sai a perda por diferença.

**`quantidade_produzida` é o líquido**, as unidades boas — a perda vive em campo
separado. Confirmado no dia 10: 24 formas × 60 = 1.440 assadas = 1.438 boas + 2
perdidas. Idem no 11 (3.584 + 16 = 3.600).

Assado bruto 10.320 − 10.172 vendidas = **148 de perda** nos quatro dias.
Por sabor: Tradicional perdeu 22 (18 já lançados no 10 e 11, sobrando 4 para o
dia 13, número forçado); Doce de Leite perdeu 126, rateados entre 12 e 13
**proporcionalmente ao assado de cada dia** (2.640 × 1.440), por escolha do
Lucca. Gravado numa transação que só fecha se a soma bater 10.172/148.

**Doce de leite perdeu 3,1% do que assou; tradicional, 0,35%** — quase dez vezes
mais. Pode ser real (desenforma pior) ou pode ser doce de leite parado em
estoque que a conta leu como quebra. Sem resposta até agora.

**O que ficou faltando:** `sessoes_producao` **não tem campo de observação**, então
não há onde registrar que essas perdas foram **estimadas pelo faturamento e não
medidas na bancada**. O dia 13 se defende pelo selo `importada`; o **dia 12 agora
parece número medido e não é**. Migration pequena resolve, e o campo serve para
muito mais. Não feito porque o reset vem antes.

**Por que pelo banco e não pela tela de Pós-produção**, revertendo a decisão
anterior: a tela pede o motivo da perda, o que seria melhor, mas também **cria
estoque de produto acabado** — 2.558 brownies que já foram vendidos. Preferido o
número certo sem motivo a um motivo com estoque falso. Dá para refazer pela tela
depois do reset.

---

## Semana de 17 a 21/08 — lançada em 23/08

44 formas Tradicional no 17; 24 Tradicional + 20 Doce de Leite no 18; 48
Tradicional no 19; 44 Doce de Leite no 20; nada no 21. Faturamento da semana:
**6.957 Tradicional e 3.842 Doce de Leite**.

Tradicional assou 6.960 e vendeu 6.957 → **3 de perda**, uma por dia produzido.
Doce de Leite assou 3.840 e vendeu **3.842** — dois a mais do que produziu.
Perda negativa não existe; gravado como zero e os 2 deixados de lado. Podem ser
sobra da semana anterior, uma forma que rendeu 61, ou contagem do faturamento.

Importado por `importar_producao_historica` (SESS-0021 a 0024), que converte
unidades em formas arredondando — as 5 linhas devolveram 44, 24, 20, 48 e 44,
exatamente o que o Lucca contou. Depois `quantidade_planejada` foi corrigida
para o bruto assado e `quantidade_perdida` recebeu o número conhecido.

**`sessoes_producao` TEM campo de observação** — `observacoes_abertura` e
`observacoes_fechamento`. A sessão anterior concluiu que não tinha, procurando
pelos nomes errados (`observacoes`, `notas`). A nota de que a perda é estimada
foi gravada nas sessões desta semana **e** nas do 12 e 13, que tinham ficado sem.

### As duas semanas juntas

| | Assado | Vendido | Perda | % |
|---|---:|---:|---:|---:|
| Tradicional | 13.200 | 13.175 | 25 | 0,19% |
| Doce de Leite | 7.920 | 7.796 | 124 | 1,57% |

**O doce de leite perde oito vezes mais que o tradicional, em duas semanas
seguidas.** Não é acaso de um dia ruim. Como esta semana ele fechou redondo, a
perda de 126 da semana passada não era doce de leite parado em estoque — era
quebra mesmo, concentrada no 12 e no 13. Aponta para a desenforma. Não
investigado.

---

## O reset — feito em 23/08

Antes, as 44 linhas de pesagem foram salvas em `docs/rastreabilidade/` (folha
legível, dado cru e os dossiês como o sistema os desenha). São a única
rastreabilidade de insumo que o sistema chegou a ter.

Usada a `dev_limpar_estoque` da migration 062, **não** a "Limpar tudo" da tela
`/dev`: a primeira preserva as sessões de produção, a segunda levaria as 24
junto. Depois, os 3 lotes de produto com saldo (LPROD-0001, 0002 e 0003 — os
5.022) tiveram o saldo zerado e o status virou `esgotado`; o lote fica, porque
é o rastro da produção.

| | Antes | Depois |
|---|---:|---:|
| Lotes de insumo | 153 | 0 |
| Baldes com conteúdo | 26 | 0 |
| Movimentações | 94 | 0 |
| Produto acabado com saldo | 3 | 0 |
| Sessões de produção | 24 | **24** |
| Linhas de produção (51.809 un.) | 27 | **27** |

Backup do que foi apagado em `backup_antes_do_reset.json`, no scratchpad da
sessão — transitório, some com a pasta temporária.

**A trava salvou a operação uma vez.** A primeira execução exigia 28 linhas de
produção, número que eu havia contado de cabeça; são 27. Ela desfez tudo e nada
foi apagado. Reescrita para medir o histórico antes e exigir que sessões, linhas
e unidades fiquem idênticas — **conferência não deve depender de número chutado
por quem escreve o script**.

---

## Sessão de 23/08/2026

As mensagens de commit explicam o porquê de cada decisão; não repito aqui.

**Dados** — `8698e0e`, `345bc10`
Importação de 17 dias de produção anterior ao sistema, sem tocar no estoque
(migrations 096/097). `sessoes_producao.importada` marca esses dias; o dossiê
diz o que não sabe em vez de fingir rastreabilidade. `quantidade_perdida` fica
**NULL** de propósito — zero afirmaria que não quebrou nenhum.

**Segurança** — `d6d1ab5`, `7ada5c0`
Descoberto que 52 funções `SECURITY DEFINER` atendiam visitante sem login, num
repositório público. Provado chamando `dossie_rastreabilidade` com a chave
publicável (voltou dado real de lote) e re-testado depois da 098 (401). Também
removido `apply_migrations.ps1`, que tinha um token do Supabase em texto puro
— o token foi verificado morto antes.

**Visual** — `6bb720d` até `669df39`
Sessões de produção em ordem de data mais visão de calendário; menu lateral
virou bloco flutuante que vira cabeçalho ao recolher; 19 itens reorganizados em
4 grupos; aplicado o tema de tokens; logo do Unno; e uma série de correções de
contraste no modo escuro. Detalhe do sistema visual na memória
`project_design_system.md` e as armadilhas de CSS no `CLAUDE.md`.

---

## Histórico
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

**Saldo descendo de segunda em diante** (`saldos`): cada linha de dia mostra
quanto da meta ainda resta depois de abater aquele dia e os anteriores. Sem
isso, distribuir na mão era adivinhação. Aparece quando `preenchimento` é
`manual` ou o plano foi ajustado — nos modos automáticos fecha sempre em zero e
seria ruído. Verde = completo, vermelho = passou.

O painel **"Falta distribuir"** fica acima dos dias, perto de onde se digita. Ele
substituiu o aviso de divergência que estava no fim da página.

No modo `manual` **todas** as linhas de produto ficam abertas em todos os dias —
sumir com a linha vizinha ao digitar era o atrito principal. Nos modos
automáticos elas escondem e voltam pelo botão `+ CÓDIGO`.

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

## Migrations

A lista viva é a própria pasta `supabase/migrations/` — os nomes dizem o que
cada uma faz. Estamos na **112**; todas aplicadas no banco.

**Duas sessões de trabalho mexem neste repositório.** As migrations 108 a 111
saíram de outra, em 24/08, e por isso houve colisão de número: a 112 nasceu
como 108 e foi renumerada. **Conferir a pasta antes de numerar uma migration
nova** — e, mais importante, gerar sempre a partir de `pg_get_functiondef`, que
é o que salvou o conteúdo de estar errado.

As que importam para o trabalho de agora:

| # | O que faz |
|---|---|
| 093-094 | Dossiê de rastreabilidade, com o descarte da desenforma |
| 095 | Perdas por dia e metas |
| 096 | Produção anterior ao sistema (`importada`, `importar_producao_historica`) |
| 097 | Rastreabilidade da produção importada (lotes nascem `esgotado`) |
| 098 | RPC só para quem fez login |

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


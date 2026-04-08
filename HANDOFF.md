# MischaFlex — Handoff de Contexto

Arquivo atualizado ao fim de cada sessão. Sempre leia antes de continuar.

---

## Stack
- React 18 + TypeScript + Vite + TailwindCSS
- Supabase (projeto `outunfdtwgsmdqtphzgf`, região sa-east-1)
- Caminho local: `C:\Users\lucca\OneDrive\Área de Trabalho\IA\Projetos\MischaFlex`

---

## Últimas migrations aplicadas

| # | Nome | O que faz |
|---|------|-----------|
| 009 | lote_grupo_multi_transfer | `lote_grupo_id` em lotes; RPC `realizar_transferencia_multipla` |
| 010 | formato_sublotes | Formato `INS014-0001.1/3`; `gerar_proximo_codigo` usa regex |
| 011 | lote_prefixo_insumo | Prefixo do lote = código do insumo (ex: `INS014-0001`) |
| 012 | marcas | Tabelas `marcas`, `insumos_marcas`, `fornecedores_insumos_marcas`; `marca_id` em `lotes` e `locais`; RPCs atualizados |

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

## Regras de negócio importantes

- **RO-002**: transferência é sempre total (lote inteiro)
- **RO-003**: recipiente deve estar vazio antes de receber novo lote
- **FIFO**: aviso se há lote mais antigo do mesmo insumo disponível
- **Marcas**: lote e recipiente devem ser da mesma marca (se ambos definidos)
- **Sublotes**: só sublotes do mesmo `lote_grupo_id` podem ser transferidos juntos
- Insumos com reembalagem (`INS027` Nutella, `INS014` DDL, `INS023` Stikadinho) usam fluxo próprio

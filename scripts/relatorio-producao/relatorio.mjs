/**
 * Relatório de produção e entrega — gera o HTML a partir do banco.
 *
 * Uso:
 *   DBURL="postgresql://..." node relatorio.mjs 2026-08-01 2026-08-31 saida.html
 *
 * A SENHA NUNCA ENTRA NESTE ARQUIVO. Ela vem por variável de ambiente, porque o
 * repositório é público — ver CLAUDE.md.
 *
 * O que o relatório responde, nesta ordem:
 *
 *   1. quanto saiu do forno       formas x rendimento da ficha
 *   2. quanto foi descartado      pós-produção, ou o que foi lançado no fechamento
 *   3. quanto foi entregue        o que sobra, que é a regra da casa
 *
 * A PROCEDÊNCIA DE CADA NÚMERO ANDA JUNTO COM ELE. Um dia sem pós-produção tem
 * "entregue" igual ao que saiu do forno — não porque nada quebrou, mas porque
 * ninguém conferiu, e as duas coisas não podem ter a mesma cara. Daí os três
 * selos:
 *
 *   conferido        a desenforma foi registrada
 *   declarado        a perda foi digitada no fechamento, sem passar pela desenforma
 *   sem conferência  nem uma coisa nem outra
 */
import pg from 'pg'
import fs from 'node:fs'

const [, , DE, ATE, SAIDA] = process.argv
if (!DE || !ATE || !SAIDA) {
  console.error('uso: node relatorio.mjs <AAAA-MM-DD> <AAAA-MM-DD> <saida.html>')
  process.exit(1)
}
if (!process.env.DBURL) {
  console.error('falta DBURL no ambiente')
  process.exit(1)
}

const c = new pg.Client({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: false } })
await c.connect()

// ── Os dados ────────────────────────────────────────────────
//
// Uma linha por (dia, ficha). O rendimento sai da ficha e não de uma constante:
// 60 é a convenção Odara, não uma lei do sistema.
const { rows: linhas } = await c.query(`
  SELECT s.data_producao,
         f.codigo AS ficha_codigo,
         f.nome   AS ficha_nome,
         COALESCE(ftv.rendimento_fornada, 60)      AS rendimento,
         sk.multiplicador                          AS formas,
         sk.quantidade_produzida                   AS entregue,
         sk.quantidade_perdida                     AS descarte,
         (pp.id IS NOT NULL)                       AS teve_pos
    FROM sessoes_producao_skus sk
    JOIN sessoes_producao s ON s.id = sk.sessao_id
    JOIN fichas_tecnicas f ON f.id = sk.ficha_tecnica_id
    LEFT JOIN fichas_tecnicas_versoes ftv ON ftv.id = sk.ficha_versao_id
    LEFT JOIN pos_producao pp ON pp.sessao_id = s.id
   WHERE s.data_producao BETWEEN $1 AND $2
   ORDER BY s.data_producao, f.codigo`, [DE, ATE])

if (!linhas.length) {
  console.error(`nenhuma produção entre ${DE} e ${ATE}`)
  process.exit(2)
}

const { rows: motivos } = await c.query(`
  SELECT m.nome, sum(ppd.quantidade)::int AS un
    FROM pos_producao_descartes ppd
    JOIN motivos_descarte m ON m.id = ppd.motivo_id
    JOIN pos_producao pp ON pp.id = ppd.pos_id
    JOIN sessoes_producao s ON s.id = pp.sessao_id
   WHERE s.data_producao BETWEEN $1 AND $2
   GROUP BY m.nome ORDER BY 2 DESC`, [DE, ATE])

// O maior descarte num dia só, para o achado do fim.
const { rows: [pico] } = await c.query(`
  SELECT to_char(s.data_producao,'DD/MM') AS dia, m.nome AS motivo,
         ppd.quantidade::int AS un, f.codigo AS ficha
    FROM pos_producao_descartes ppd
    JOIN motivos_descarte m ON m.id = ppd.motivo_id
    JOIN pos_producao pp ON pp.id = ppd.pos_id
    JOIN sessoes_producao s ON s.id = pp.sessao_id
    JOIN sessoes_producao_skus sk ON sk.id = ppd.sessao_sku_id
    JOIN fichas_tecnicas f ON f.id = sk.ficha_tecnica_id
   WHERE s.data_producao BETWEEN $1 AND $2
   ORDER BY ppd.quantidade DESC LIMIT 1`, [DE, ATE])

await c.end()

// ── As contas ───────────────────────────────────────────────
const n = x => Number(x ?? 0)
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))
const br = s => s.slice(0, 10).split('-').reverse().join('/')
const brCurto = s => s.slice(8, 10) + '/' + s.slice(5, 7)
const num = v => v.toLocaleString('pt-BR')
const SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
/** Dia da semana sem passar por fuso: `new Date('2026-08-03')` é UTC. */
const diaSemana = s => {
  const [a, m, d] = s.split('-').map(Number)
  return SEM[new Date(Date.UTC(a, m - 1, d)).getUTCDay()]
}

for (const l of linhas) l.data = iso(l.data_producao)

const fichas = [...new Map(linhas.map(l => [l.ficha_codigo,
  { codigo: l.ficha_codigo, nome: l.ficha_nome }])).values()]
  .sort((a, b) => a.codigo.localeCompare(b.codigo))

/** Vermelho e âmbar primeiro — a paleta da casa; o resto cicla. */
const PALETA = ['var(--dado-a)', 'var(--dado-b)', 'var(--dado-c)', 'var(--dado-d)']
fichas.forEach((f, i) => { f.cor = PALETA[i % PALETA.length] })

const dias = [...new Set(linhas.map(l => l.data))].sort().map(data => {
  const doDia = linhas.filter(l => l.data === data)
  const forno = doDia.reduce((s, l) => s + n(l.formas) * n(l.rendimento), 0)
  const entregue = doDia.reduce((s, l) => s + n(l.entregue), 0)
  const temPos = doDia.some(l => l.teve_pos)
  const temDeclarado = doDia.some(l => l.descarte !== null && n(l.descarte) > 0)
  return {
    data,
    formas: doDia.reduce((s, l) => s + n(l.formas), 0),
    forno, entregue,
    descarte: forno - entregue,
    // Sem pós-produção e sem perda digitada, o número não foi conferido —
    // e um zero aí não é uma medição, é a ausência dela.
    selo: temPos ? 'conferido' : temDeclarado ? 'declarado' : 'sem conferência',
    porFicha: Object.fromEntries(doDia.map(l => [l.ficha_codigo, n(l.formas)])),
  }
})

const T = {
  formas: dias.reduce((s, d) => s + d.formas, 0),
  forno: dias.reduce((s, d) => s + d.forno, 0),
  entregue: dias.reduce((s, d) => s + d.entregue, 0),
}
T.descarte = T.forno - T.entregue

// Só onde a desenforma foi registrada é que o descarte é uma medição.
const conf = dias.filter(d => d.selo === 'conferido')
const confForno = conf.reduce((s, d) => s + d.forno, 0)
const confDesc = conf.reduce((s, d) => s + d.descarte, 0)
const semConf = dias.filter(d => d.selo === 'sem conferência').length

const porFicha = fichas.map(f => {
  const suas = linhas.filter(l => l.ficha_codigo === f.codigo)
  const formas = suas.reduce((s, l) => s + n(l.formas), 0)
  const entregue = suas.reduce((s, l) => s + n(l.entregue), 0)
  const forno = suas.reduce((s, l) => s + n(l.formas) * n(l.rendimento), 0)
  return { ...f, formas, entregue, descarte: forno - entregue,
           parte: T.entregue ? entregue / T.entregue * 100 : 0 }
})

const maiorDia = dias.reduce((a, d) => d.forno > a.forno ? d : a, dias[0])
const menorDia = dias.reduce((a, d) => d.forno < a.forno ? d : a, dias[0])
const ordenados = [...dias].map(d => d.forno).sort((a, b) => a - b)
const mediana = ordenados.length % 2
  ? ordenados[(ordenados.length - 1) / 2]
  : (ordenados[ordenados.length / 2 - 1] + ordenados[ordenados.length / 2]) / 2

/** Semanas de segunda a domingo, para o ritmo. */
const semanas = []
for (const d of dias) {
  const [a, m, dd] = d.data.split('-').map(Number)
  const t = new Date(Date.UTC(a, m - 1, dd))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7))
  const chave = t.toISOString().slice(0, 10)
  let s = semanas.find(x => x.chave === chave)
  if (!s) { s = { chave, forno: 0, entregue: 0, dias: 0 }; semanas.push(s) }
  s.forno += d.forno; s.entregue += d.entregue; s.dias++
}
const maiorSemana = Math.max(...semanas.map(s => s.forno), 1)

const pct = (a, b) => b ? (a / b * 100) : 0
const f1 = x => x.toFixed(1).replace('.', ',')
/**
 * Largura em CSS. Separada do `f1` de propósito: `width:46,7%` é inválido e o
 * navegador descarta a regra sem avisar — a barra some e nada acusa o erro.
 */
const w = x => x.toFixed(1)
const f2 = x => x.toFixed(2).replace('.', ',')

// ── O documento ─────────────────────────────────────────────
const maiorFornoDia = Math.max(...dias.map(d => d.forno), 1)
const rendPadrao = n(linhas[0].rendimento)

const linhaTabela = d => {
  const barras = fichas.map(f => {
    const formas = d.porFicha[f.codigo] ?? 0
    if (!formas) return ''
    const largura = pct(formas * rendPadrao, maiorFornoDia)
    return `<i style="width:${w(largura)}%;background:${f.cor}"></i>`
  }).join('')
  const cls = d.selo === 'conferido' ? 'conferido' : d.selo === 'declarado' ? 'declarado' : ''
  const dv = d.descarte === 0 && d.selo === 'sem conferência'
  return `          <tr>`
    + `<td class="dia">${diaSemana(d.data)} ${brCurto(d.data)}</td>`
    + `<td class="n">${d.formas}</td>`
    + `<td class="celula-barra"><div class="barra">${barras}</div></td>`
    + `<td class="n">${num(d.forno)}</td>`
    + `<td class="desc${dv ? ' vazio' : ''}">${num(d.descarte)}</td>`
    + `<td class="n">${num(d.entregue)}</td>`
    + `<td><span class="selo ${cls}">${d.selo}</span></td></tr>`
}

const html = `<title>Produção e entrega · ${br(DE)} a ${br(ATE)}</title>

<style>
  :root {
    --ground: #ffffff;
    --surface: #f6f4f2;
    --surface-2: #efebe8;
    --line: #e2dcd7;
    --line-strong: #cdc4bd;
    --ink: #1a1512;
    --ink-2: #4a423c;
    --ink-3: #7d736b;
    --acento: #d1193a;
    --dado-a: #d1193a;
    --dado-b: #b5762a;
    --dado-c: #4a6b8a;
    --dado-d: #6b8a4a;
    --descarte: #6b6560;
    --ok: #2f7d51;
    --vago: #b7ada6;

    --display: Georgia, "Iowan Old Style", "Times New Roman", serif;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  :root:not([data-theme="light"]) { color-scheme: light; }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #14100e; --surface: #1d1815; --surface-2: #262019;
      --line: #322a25; --line-strong: #4a3f37;
      --ink: #f3efec; --ink-2: #c3b8b0; --ink-3: #8e8078;
      --acento: #f2445f; --dado-a: #f2445f; --dado-b: #d9964a;
      --dado-c: #7fa6cc; --dado-d: #9ec47a;
      --descarte: #9a8f86; --ok: #5cb583; --vago: #4a403a;
      color-scheme: dark;
    }
  }

  :root[data-theme="dark"] {
    --ground: #14100e; --surface: #1d1815; --surface-2: #262019;
    --line: #322a25; --line-strong: #4a3f37;
    --ink: #f3efec; --ink-2: #c3b8b0; --ink-3: #8e8078;
    --acento: #f2445f; --dado-a: #f2445f; --dado-b: #d9964a;
    --dado-c: #7fa6cc; --dado-d: #9ec47a;
    --descarte: #9a8f86; --ok: #5cb583; --vago: #4a403a;
    color-scheme: dark;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font-family: var(--sans); font-size: 16px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .folha {
    max-width: 62rem; margin: 0 auto;
    padding: clamp(1.5rem, 4vw, 4rem) clamp(1.1rem, 4vw, 3rem) 5rem;
    display: flex; flex-direction: column; gap: 3rem;
  }

  .rotulo {
    font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--ink-3); margin: 0;
  }

  header { display: flex; flex-direction: column; gap: 1rem; }

  header h1 {
    font-family: var(--display); font-weight: 400;
    font-size: clamp(2.1rem, 6vw, 3.4rem); line-height: 1.05;
    letter-spacing: -0.02em; margin: 0; text-wrap: balance;
  }

  header h1 em { font-style: italic; color: var(--acento); }
  .subtitulo { margin: 0; max-width: 46ch; color: var(--ink-2); }
  .regua { height: 3px; background: var(--ink); width: 4rem; }

  .sintese, .cadeia, .grade-stat {
    display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line);
  }
  .sintese { grid-template-columns: repeat(2, 1fr); }
  .cadeia { grid-template-columns: 1fr; }
  .grade-stat { grid-template-columns: repeat(2, 1fr); }

  @media (min-width: 46rem) {
    .sintese { grid-template-columns: repeat(4, 1fr); }
    .cadeia { grid-template-columns: repeat(3, 1fr); }
    .grade-stat { grid-template-columns: repeat(3, 1fr); }
  }

  .metrica, .elo, .stat {
    background: var(--ground); display: flex; flex-direction: column;
  }
  .metrica { padding: 1.25rem 1.1rem; gap: 0.35rem; }
  .elo { padding: 1.4rem 1.2rem; gap: 0.4rem; }
  .stat { padding: 1.1rem; gap: 0.2rem; }

  .metrica b, .elo b, .stat b {
    font-family: var(--mono); font-variant-numeric: tabular-nums;
    font-weight: 600; letter-spacing: -0.03em; line-height: 1;
  }
  .metrica b { font-size: clamp(1.5rem, 4vw, 1.9rem); }
  .elo b { font-size: 1.75rem; }
  .stat b { font-size: 1.35rem; letter-spacing: -0.02em; }

  .metrica span, .stat span { font-size: 0.82rem; color: var(--ink-3); }
  .metrica.forte b { color: var(--ok); }

  .elo .oque { font-family: var(--display); font-size: 1.05rem; color: var(--ink); }
  .elo small { font-size: 0.8rem; color: var(--ink-3); line-height: 1.4; }
  .elo.perda b { color: var(--descarte); }
  .elo.perda b::before { content: "−"; }
  .elo.chega b { color: var(--ok); }
  .stat em { font-style: normal; font-size: 0.74rem; color: var(--ink-3); }

  .produtos { display: grid; gap: 1rem; }
  @media (min-width: 46rem) { .produtos { grid-template-columns: repeat(2, 1fr); } }

  .produto {
    background: var(--surface); border: 1px solid var(--line); padding: 1.4rem;
    display: flex; flex-direction: column; gap: 0.9rem;
  }

  .produto h3 {
    margin: 0; font-family: var(--display); font-size: 1.3rem;
    font-weight: 400; letter-spacing: -0.01em;
  }

  .numeros { display: flex; gap: 1.6rem; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
  .numeros div { display: flex; flex-direction: column; gap: 0.1rem; }
  .numeros strong { font-family: var(--mono); font-size: 1.15rem; font-weight: 600; }
  .numeros span { font-size: 0.72rem; color: var(--ink-3); }

  .barra-participacao { height: 8px; background: var(--surface-2); overflow: hidden; }
  .barra-participacao i { display: block; height: 100%; }

  .participacao {
    font-family: var(--mono); font-size: 0.78rem; color: var(--ink-2);
    font-variant-numeric: tabular-nums; margin: 0;
  }

  .secao { display: flex; flex-direction: column; gap: 1.1rem; }

  .secao h2 {
    margin: 0; font-family: var(--display); font-weight: 400;
    font-size: 1.55rem; letter-spacing: -0.01em;
  }

  .secao > p { margin: 0; color: var(--ink-2); max-width: 62ch; font-size: 0.95rem; }

  .legenda { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: center; }
  .chave { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.82rem; color: var(--ink-2); }
  .chave i { width: 12px; height: 12px; display: inline-block; }

  .rolagem { overflow-x: auto; }

  table {
    width: 100%; border-collapse: collapse;
    font-variant-numeric: tabular-nums; min-width: 40rem;
  }

  thead th {
    text-align: left; font-family: var(--mono); font-size: 0.68rem;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3);
    font-weight: 500; padding: 0 0.6rem 0.55rem;
    border-bottom: 1px solid var(--line-strong);
  }

  thead th.n, tbody td.n, tfoot td.n { text-align: right; }

  tbody td { padding: 0.6rem; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  tbody td.dia { font-family: var(--mono); color: var(--ink-2); white-space: nowrap; }
  tbody td.n { font-family: var(--mono); }
  tbody td.desc { font-family: var(--mono); text-align: right; color: var(--descarte); }
  tbody td.desc.vazio { color: var(--vago); }

  .celula-barra { width: 26%; padding-right: 0 !important; }
  .barra { display: flex; height: 14px; background: var(--surface-2); }
  .barra i { display: block; height: 100%; }

  .selo {
    display: inline-block; font-family: var(--mono); font-size: 0.62rem;
    letter-spacing: 0.08em; text-transform: uppercase; padding: 0.15rem 0.45rem;
    border: 1px solid var(--line-strong); color: var(--ink-3); white-space: nowrap;
  }
  .selo.conferido { border-color: var(--ok); color: var(--ok); }
  .selo.declarado { border-color: var(--dado-b); color: var(--dado-b); }

  tfoot td {
    padding: 0.75rem 0.6rem; font-family: var(--mono);
    font-weight: 600; border-top: 2px solid var(--ink);
  }

  .motivos { display: flex; flex-direction: column; gap: 0.75rem; }
  .motivo { display: grid; grid-template-columns: 10rem 1fr auto; gap: 0.9rem; align-items: center; }
  @media (max-width: 34rem) { .motivo { grid-template-columns: 7.5rem 1fr auto; gap: 0.6rem; } }
  .motivo .nome { font-size: 0.9rem; color: var(--ink); }
  .motivo .trilho { height: 20px; background: var(--surface-2); }
  .motivo .trilho i { display: block; height: 100%; background: var(--descarte); }
  .motivo .qt {
    font-family: var(--mono); font-variant-numeric: tabular-nums;
    font-size: 0.95rem; font-weight: 600; min-width: 3.5rem; text-align: right;
  }

  .semanas { display: flex; flex-direction: column; gap: 0.5rem; }
  .semana { display: flex; align-items: center; gap: 0.9rem; }
  .semana .rot { font-family: var(--mono); font-size: 0.78rem; color: var(--ink-2); width: 6.5rem; flex: none; }
  .semana .trilho { flex: 1; height: 18px; background: var(--surface-2); }
  .semana .trilho i { display: block; height: 100%; background: var(--dado-a); }
  .semana .val { font-family: var(--mono); font-size: 0.85rem; font-variant-numeric: tabular-nums; width: 4.5rem; text-align: right; }

  .achado { background: var(--surface); border-left: 3px solid var(--acento); padding: 1.2rem 1.4rem; }
  .achado p { margin: 0; color: var(--ink-2); font-size: 0.92rem; max-width: 62ch; }
  .achado strong { color: var(--ink); }

  footer {
    border-top: 1px solid var(--line); padding-top: 1.2rem;
    color: var(--ink-3); font-size: 0.8rem;
    display: flex; flex-wrap: wrap; gap: 0.4rem 1.5rem;
  }
</style>

<div class="folha">

  <header>
    <p class="rotulo">Mischa's · Industrialização por encomenda</p>
    <h1>Produção e <em>entrega</em><br />${br(DE)} a ${br(ATE)}</h1>
    <div class="regua"></div>
    <p class="subtitulo">
      O que saiu do forno, o que foi separado na desenforma e o que de fato foi
      entregue — dia a dia, conforme o sistema de rastreabilidade.
    </p>
  </header>

  <section class="sintese" aria-label="Síntese">
    <div class="metrica"><b>${num(T.formas)}</b><span>formas produzidas</span></div>
    <div class="metrica"><b>${num(T.forno)}</b><span>unidades do forno</span></div>
    <div class="metrica"><b>${num(T.descarte)}</b><span>unidades descartadas</span></div>
    <div class="metrica forte"><b>${num(T.entregue)}</b><span>unidades entregues</span></div>
  </section>

  <section class="secao">
    <h2>Do forno até a entrega</h2>
    <p>
      Cada forma rende ${rendPadrao} unidades. O que quebra, sai cru ou fora da
      gramatura é separado na desenforma e não vai para o cliente — o que sobra
      é a entrega.
    </p>
    <div class="cadeia">
      <div class="elo">
        <span class="oque">Saiu do forno</span>
        <b>${num(T.forno)}</b>
        <small>${num(T.formas)} formas × ${rendPadrao} unidades</small>
      </div>
      <div class="elo perda">
        <span class="oque">Descartado</span>
        <b>${num(T.descarte)}</b>
        <small>${f2(pct(T.descarte, T.forno))}% do período — ${dias.length - semConf} dos ${dias.length} dias com esse número apurado</small>
      </div>
      <div class="elo chega">
        <span class="oque">Entregue</span>
        <b>${num(T.entregue)}</b>
        <small>${porFicha.map(f => `${num(f.entregue)} ${f.nome.replace(/^Brownie /, '')}`).join(' · ')}</small>
      </div>
    </div>
  </section>

  <section class="produtos" aria-label="Produtos">
${porFicha.map(f => `    <article class="produto">
      <h3>${f.nome}</h3>
      <div class="numeros">
        <div><strong>${num(f.formas)}</strong><span>formas</span></div>
        <div><strong>${num(f.entregue)}</strong><span>entregues</span></div>
        <div><strong>${num(f.descarte)}</strong><span>descartadas</span></div>
      </div>
      <div class="barra-participacao"><i style="width:${w(f.parte)}%;background:${f.cor}"></i></div>
      <p class="participacao">${f1(f.parte)}% do volume entregue</p>
    </article>`).join('\n')}
  </section>

  <section class="secao">
    <h2>Dia a dia</h2>
    <div class="legenda">
${fichas.map(f => `      <span class="chave"><i style="background:${f.cor}"></i> ${f.nome.replace(/^Brownie /, '')}</span>`).join('\n')}
      <span class="chave"><span class="selo conferido">conferido</span> desenforma registrada</span>
      <span class="chave"><span class="selo declarado">declarado</span> perda lançada no fechamento</span>
      <span class="chave"><span class="selo">—</span> sem conferência</span>
    </div>

    <div class="rolagem">
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th class="n">Formas</th>
            <th class="celula-barra">Composição</th>
            <th class="n">Do forno</th>
            <th class="n">Descarte</th>
            <th class="n">Entregue</th>
            <th>Origem</th>
          </tr>
        </thead>
        <tbody>
${dias.map(linhaTabela).join('\n')}
        </tbody>
        <tfoot>
          <tr><td>Total</td><td class="n">${num(T.formas)}</td><td></td><td class="n">${num(T.forno)}</td><td class="n">${num(T.descarte)}</td><td class="n">${num(T.entregue)}</td><td></td></tr>
        </tfoot>
      </table>
    </div>
  </section>
${motivos.length ? `
  <section class="secao">
    <h2>Por que foi descartado</h2>
    <p>
      Os ${num(motivos.reduce((s, m) => s + m.un, 0))} descartes apurados na desenforma, pelo motivo
      registrado. O restante do período foi lançado sem motivo atribuído.
    </p>
    <div class="motivos">
${motivos.map(m => `      <div class="motivo">
        <span class="nome">${m.nome}</span>
        <div class="trilho"><i style="width:${w(pct(m.un, motivos[0].un))}%"></i></div>
        <span class="qt">${num(m.un)}</span>
      </div>`).join('\n')}
    </div>
  </section>` : ''}

  <section class="secao">
    <h2>Ritmo</h2>
    <p>Volume de forno, antes do descarte.</p>

    <div class="grade-stat">
      <div class="stat"><b>${num(Math.round(T.forno / dias.length))}</b><span>média por dia produzido</span><em>${dias.length} dias com produção</em></div>
      <div class="stat"><b>${num(Math.round(mediana))}</b><span>mediana diária</span><em>metade dos dias acima disso</em></div>
      <div class="stat"><b>${f1(T.formas / dias.length)}</b><span>formas por dia produzido</span><em>${rendPadrao} unidades por forma</em></div>
      <div class="stat"><b>${num(maiorDia.forno)}</b><span>maior dia — ${brCurto(maiorDia.data)}</span><em>${maiorDia.formas} formas</em></div>
      <div class="stat"><b>${num(menorDia.forno)}</b><span>menor dia — ${brCurto(menorDia.data)}</span><em>${menorDia.formas} formas</em></div>
      <div class="stat"><b>${f2(pct(confDesc, confForno))}%</b><span>descarte onde foi conferido</span><em>${num(confDesc)} em ${num(confForno)} unidades</em></div>
    </div>

    <div class="semanas">
${semanas.map(s => `      <div class="semana"><span class="rot">sem. ${brCurto(s.chave)}</span><span class="trilho"><i style="width:${w(pct(s.forno, maiorSemana))}%"></i></span><span class="val">${num(s.forno)}</span></div>`).join('\n')}
    </div>
${semConf ? `
    <div class="achado">
      <p>
        <strong>${semConf} ${semConf === 1 ? 'dia' : 'dias'} de ${dias.length} não ${semConf === 1 ? 'passou' : 'passaram'} pela desenforma no sistema.</strong>
        Nesses, "entregue" é igual ao que saiu do forno por falta de dado, não por
        não ter havido quebra. Onde a desenforma foi de fato registrada, o descarte
        foi de ${f2(pct(confDesc, confForno))}% — contra ${f2(pct(T.descarte, T.forno))}% do período inteiro.
      </p>
    </div>` : ''}
${pico && pico.un > 20 ? `
    <div class="achado">
      <p>
        <strong>O dia ${pico.dia} concentra ${num(pico.un)} descartes por "${pico.motivo.toLowerCase()}"</strong>,
        num lançamento só de ${pico.ficha}. Vale entender o que aconteceu.
      </p>
    </div>` : ''}
  </section>

  <footer>
    <span>Origem: MischaFlex — sessões de produção e pós-produção</span>
    <span>Rendimento: ${rendPadrao} unidades por forma</span>
    <span>Emitido em ${br(new Date(Date.now() - 3 * 3600e3).toISOString())}</span>
  </footer>

</div>
`

fs.writeFileSync(SAIDA, html)

// O resumo vai para o terminal: é o que o Claude lê para comentar o relatório
// sem ter de reabrir o HTML.
console.log(JSON.stringify({
  periodo: [DE, ATE],
  dias: dias.length,
  formas: T.formas,
  forno: T.forno,
  descarte: T.descarte,
  entregue: T.entregue,
  taxa_periodo: Number(pct(T.descarte, T.forno).toFixed(2)),
  taxa_onde_conferido: Number(pct(confDesc, confForno).toFixed(2)),
  dias_conferidos: conf.length,
  dias_declarados: dias.filter(d => d.selo === 'declarado').length,
  dias_sem_conferencia: semConf,
  por_produto: porFicha.map(f => ({ nome: f.nome, formas: f.formas,
    entregue: f.entregue, descarte: f.descarte })),
  motivos: motivos.map(m => ({ nome: m.nome, unidades: m.un })),
  maior_descarte_unico: pico ?? null,
  arquivo: SAIDA,
}, null, 1))

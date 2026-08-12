/**
 * O que a tela de Perdas e o relatório impresso compartilham.
 *
 * O gráfico mora aqui porque ele é o mesmo nos dois lugares — e um gráfico
 * duplicado é um gráfico que diverge: o dia em que a regra do eixo mudasse num
 * arquivo e não no outro, o papel diria uma coisa e a tela outra.
 */

/**
 * Cor por ORDEM do motivo, não por posição na lista carregada: a linha do
 * "queimado" tem de ser a mesma cor toda semana, senão comparar duas semanas
 * vira adivinhação.
 */
const CORES = ['#e11d48', '#f59e0b', '#0ea5e9', '#8b5cf6', '#10b981', '#f43f5e', '#64748b', '#84cc16']
export const corDoMotivo = (ordem: number) => CORES[Math.abs(ordem) % CORES.length]

/** Mesma escala do resto do sistema. */
export function corPct(pct: number): string {
  return pct <= 3 ? 'text-emerald-600' : pct <= 8 ? 'text-yellow-600' : 'text-red-600'
}

export function fmt(n: number, casas = 0) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: casas })
}

// Datas montadas componente a componente: `new Date('2026-08-03')` é meia-noite
// UTC e no Brasil cai no dia 2.
export function paraISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function paraData(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d)
}

/** A segunda-feira da semana em que a data cai. */
export function segundaDe(iso: string): string {
  const d = paraData(iso)
  const dow = d.getDay()
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow))
  return paraISO(d)
}

export function rotuloSemana(iso: string): string {
  const d = paraData(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

export interface SemanaMotivos {
  chave: string
  total: number
  fatias: { id: string; motivo: string; ordem: number; qtd: number }[]
}

/**
 * A participação de cada motivo ao longo do tempo, uma linha por motivo.
 *
 * Empilhado mostrava a composição de cada semana, mas escondia o movimento: era
 * preciso comparar espessuras de faixa que começam em alturas diferentes. Com
 * linhas, um motivo ultrapassando o outro é literalmente uma linha cruzando a
 * outra — que é o sinal que se quer ver antes de o total mexer.
 *
 * Só entram semanas COM descarte: uma semana sem produção não tem participação
 * de nada, e plotá-la como zero desenharia um mergulho que não aconteceu. Como
 * as semanas vazias saem, o eixo é uma sequência de medições, não uma régua de
 * tempo — o rótulo de cada ponto diz a semana.
 */
export function LinhasMotivos({
  semanas, motivos,
}: {
  semanas: SemanaMotivos[]
  motivos: { id: string; motivo: string; ordem: number }[]
}) {
  const pontos = semanas.filter(s => s.total > 0)
  if (pontos.length === 0) {
    return (
      <p className="text-sm text-gray-400 text-center py-8">
        Ainda não há descarte registrado para desenhar a série.
      </p>
    )
  }

  // Viewbox fixo escalado por CSS: o texto acompanha a largura sem distorcer.
  const L = 34, R = 12, T = 14, B = 26
  const W = 620, H = 260
  const alturaUtil = H - T - B
  const larguraUtil = W - L - R

  const share = (s: SemanaMotivos, id: string) => {
    const f = s.fatias.find(x => x.id === id)
    return f ? (f.qtd / s.total) * 100 : 0
  }

  const maiorValor = Math.max(...motivos.flatMap(m => pontos.map(p => share(p, m.id))), 10)
  const passo = maiorValor <= 20 ? 5 : 10
  // Um passo SEMPRE acima do maior valor: sem essa folga, um motivo com 100%
  // dos descartes encosta no teto e o rótulo dele sai do quadro. Medido.
  const topo = (Math.floor(maiorValor / passo) + 1) * passo

  const x = (i: number) => pontos.length === 1
    ? L + larguraUtil / 2
    : L + (i * larguraUtil) / (pontos.length - 1)
  const y = (v: number) => T + alturaUtil - (v / topo) * alturaUtil

  const linhas = motivos.map(m => ({
    ...m,
    valores: pontos.map((p, i) => ({ i, v: share(p, m.id) })),
  }))
  // Desenha o motivo mais forte por último, para ele ficar por cima no cruzamento.
  const ordenadas = [...linhas].sort(
    (a, b) => a.valores[a.valores.length - 1].v - b.valores[b.valores.length - 1].v)

  const ticks: number[] = []
  for (let v = 0; v <= topo; v += passo) ticks.push(v)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img">
      {/* Grade e eixo */}
      {ticks.map(t => (
        <g key={t}>
          <line x1={L} y1={y(t)} x2={W - R} y2={y(t)}
                stroke="currentColor" className="text-gray-200 dark:text-white/10" strokeWidth={1} />
          <text x={L - 6} y={y(t) + 3} textAnchor="end"
                className="fill-gray-400" style={{ fontSize: 10 }}>{t}</text>
        </g>
      ))}

      {ordenadas.map(l => {
        const cor = corDoMotivo(l.ordem)
        const d = l.valores.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i)} ${y(p.v)}`).join(' ')
        return (
          <g key={l.id}>
            {pontos.length > 1 && (
              <path d={d} fill="none" stroke={cor} strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
            )}
            {l.valores.map(p => (
              <g key={p.i}>
                <circle cx={x(p.i)} cy={y(p.v)} r={3.5} fill={cor} />
                <text
                  x={x(p.i)}
                  y={y(p.v) - 8}
                  textAnchor={p.i === 0 ? 'start' : p.i === pontos.length - 1 ? 'end' : 'middle'}
                  style={{ fontSize: 11, fontWeight: 600 }}
                  fill={cor}
                >
                  {Math.round(p.v)}
                </text>
              </g>
            ))}
          </g>
        )
      })}

      {/* Semanas */}
      {pontos.map((p, i) => (
        <text key={p.chave} x={x(i)} y={H - 8} textAnchor="middle"
              className="fill-gray-400" style={{ fontSize: 10 }}>
          {rotuloSemana(p.chave)}
        </text>
      ))}
    </svg>
  )
}

/** Legenda das cores, usada ao lado do gráfico na tela e no papel. */
export function LegendaMotivos({
  motivos,
}: {
  motivos: { id: string; motivo: string; ordem: number }[]
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {motivos.map(m => (
        <span key={m.id} className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-unno-muted">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: corDoMotivo(m.ordem) }} />
          {m.motivo}
        </span>
      ))}
    </div>
  )
}

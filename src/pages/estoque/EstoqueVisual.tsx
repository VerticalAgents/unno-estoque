import { useId } from 'react'

/**
 * O estoque desenhado: cada embalagem e cada pote cheio até o que tem dentro.
 *
 * A tela de estoque era só número (Lucca, 29/09/2026: "tá muito numérico").
 * "O #2 está pela metade" se vê sem ler nada — e o número continua ali, pequeno,
 * embaixo, e completo no toque.
 *
 * SVG à mão, sem biblioteca: são seis contornos, e cada um precisa saber onde
 * começa e termina o corpo para o conteúdo subir de baixo até o percentual.
 */

export type FormaTipo = 'balde' | 'saco' | 'caixa' | 'garrafa' | 'lata' | 'prateleira'

/** Contorno de cada forma num quadro 60×72, e a faixa vertical que o conteúdo ocupa. */
const FORMAS: Record<FormaTipo, { corpo: string; extra?: string; topo: number; base: number }> = {
  balde: {
    corpo: 'M9 18 L51 18 L46 68 L14 68 Z',
    extra: 'M11 18 Q30 -2 49 18 M7 18 L53 18',
    topo: 18, base: 68,
  },
  saco: {
    corpo: 'M14 16 Q30 22 46 16 L51 62 Q30 72 9 62 Z',
    extra: 'M24 12 Q30 17 36 12 M26 9 L34 9',
    topo: 16, base: 70,
  },
  caixa: {
    corpo: 'M7 16 L53 16 L53 68 L7 68 Z',
    extra: 'M7 24 L53 24',
    topo: 16, base: 68,
  },
  garrafa: {
    corpo: 'M25 4 L35 4 L35 14 Q46 18 46 30 L46 66 Q46 69 43 69 L17 69 Q14 69 14 66 L14 30 Q14 18 25 14 Z',
    topo: 4, base: 69,
  },
  lata: {
    corpo: 'M12 14 L48 14 L48 66 Q48 69 45 69 L15 69 Q12 69 12 66 Z',
    extra: 'M12 14 Q30 20 48 14',
    topo: 14, base: 69,
  },
  prateleira: {
    corpo: 'M6 20 L54 20 L54 66 L6 66 Z',
    topo: 20, base: 66,
  },
}

/** Da palavra do cadastro para o desenho. O que não se conhece vira caixa. */
export function formaDaEmbalagem(tipo: string | null | undefined): FormaTipo {
  switch (tipo) {
    case 'saco': case 'saca': case 'fardo': return 'saco'
    case 'balde': case 'balde_fornecedor': return 'balde'
    case 'garrafa': case 'garrafa_fornecedor': return 'garrafa'
    case 'lata': return 'lata'
    case 'prateleira': return 'prateleira'
    default: return 'caixa'
  }
}

/** Verde cheio, amarelo pela metade, vermelho no fim. */
function corDoNivel(pct: number): string {
  if (pct >= 0.5) return '#22c55e'
  if (pct >= 0.2) return '#f59e0b'
  return '#ef4444'
}

export function Peca({
  forma, cheio, estimado, rotulo, detalhe, selecionada, onClick,
}: {
  forma: FormaTipo
  /** 0 a 1 (ou mais, se passou da capacidade). `null` = não se sabe quanto cabe. */
  cheio: number | null
  /** O número é estimativa (desconto teórico, embalagem não pesada): listrado. */
  estimado?: boolean
  rotulo: string
  detalhe: string
  selecionada?: boolean
  onClick?: () => void
}) {
  const id = useId().replace(/:/g, '')
  const f = FORMAS[forma]
  const altura = f.base - f.topo
  const semCapacidade = cheio === null
  const acima = cheio !== null && cheio > 1.005
  const nivel = cheio === null ? 0 : Math.max(0, Math.min(1, cheio))
  const vazio = cheio !== null && cheio <= 0.0001
  const cor = corDoNivel(nivel)
  const y = f.base - altura * nivel

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center w-[72px] rounded-controle p-1 transition-colors ${
        selecionada ? 'bg-brand-500/12 ring-2 ring-brand-500' : 'hover:bg-gray-50'
      }`}
      title={detalhe}
    >
      <svg viewBox="0 0 60 72" className="w-14 h-16" aria-hidden>
        <defs>
          <clipPath id={`c${id}`}><path d={f.corpo} /></clipPath>
          <pattern id={`p${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={cor} fillOpacity="0.25" />
            <rect width="3" height="6" fill={cor} />
          </pattern>
        </defs>
        {!semCapacidade && !vazio && (
          <rect
            x="0" y={y} width="60" height={f.base - y + 2}
            fill={estimado ? `url(#p${id})` : cor}
            clipPath={`url(#c${id})`}
          />
        )}
        <path
          d={f.corpo}
          fill="none"
          stroke={acima ? '#dc2626' : '#9ca3af'}
          strokeWidth={acima ? 2.5 : 1.8}
          strokeDasharray={semCapacidade ? '4 3' : undefined}
          strokeLinejoin="round"
        />
        {f.extra && <path d={f.extra} fill="none" stroke="#9ca3af" strokeWidth="1.6" strokeLinecap="round" />}
        {acima && (
          <g>
            <circle cx="52" cy="10" r="7" fill="#dc2626" />
            <path d="M52 6.5 V13.5 M48.5 10 H55.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        )}
      </svg>
      <span className="text-xs font-semibold text-gray-800 leading-tight truncate max-w-full">{rotulo}</span>
      <span className={`text-[0.7rem] leading-tight tabular-nums ${estimado ? 'text-amber-700' : 'text-gray-500'}`}>
        {estimado && '≈ '}{detalhe}
      </span>
    </button>
  )
}

/**
 * Óleo e ovo na produção: não há pote, há garrafas e pacotes soltos
 * (migration 126). Uma figurinha por unidade inteira — a aberta não conta,
 * mesma regra do reabastecimento.
 */
export function FileiraUnidades({
  n, tipo, selecionada, onClick, rotulo,
}: {
  n: number
  tipo: string
  selecionada?: boolean
  onClick?: () => void
  rotulo: string
}) {
  const MAX = 60
  const mostrar = Math.min(n, MAX)
  const garrafa = tipo === 'garrafa'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-controle p-2 transition-colors ${
        selecionada ? 'bg-brand-500/12 ring-2 ring-brand-500' : 'hover:bg-gray-50'
      }`}
    >
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: mostrar }, (_, i) => (
          <svg key={i} viewBox={garrafa ? '0 0 12 24' : '0 0 16 16'} className={garrafa ? 'w-3 h-6' : 'w-4 h-4'} aria-hidden>
            {garrafa
              ? <path d="M4.5 1 H7.5 V5 Q11 6.5 11 10 V22 Q11 23 10 23 H2 Q1 23 1 22 V10 Q1 6.5 4.5 5 Z" fill="#22c55e" />
              : <rect x="1" y="2" width="14" height="13" rx="2" fill="#22c55e" />}
          </svg>
        ))}
        {n > MAX && <span className="text-xs text-gray-500 self-center">+{n - MAX}</span>}
        {n === 0 && <span className="text-xs text-gray-400 italic">nenhum{garrafa ? 'a garrafa' : ' pacote'} fechad{garrafa ? 'a' : 'o'}</span>}
      </div>
      <p className="text-xs font-semibold text-gray-800 mt-1.5">{rotulo}</p>
    </button>
  )
}

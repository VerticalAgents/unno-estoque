import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../contexts/AuthContext'

/**
 * Configuração de impressão das etiquetas.
 *
 * Duas coisas descrevem o papel:
 *
 * 1. O TAMANHO de uma etiqueta (largura x altura em mm). O conteúdo é
 *    desenhado num tamanho-base e encolhido/aumentado inteiro até caber,
 *    mantendo a proporção — nada estica nem achata.
 *
 *    Há dois desenhos-base, escolhidos pelo formato do papel: `paisagem`
 *    (deitada, 100x75mm) e `retrato` (em pé, 34x65mm). Uma etiqueta de
 *    34x65 usando o desenho deitado desperdiçaria 61% do papel; por isso
 *    o desenho em pé existe.
 *
 * 2. O ROLO. Rolo de térmica costuma ter 2 ou 3 colunas de etiquetas lado a
 *    lado, e a impressora avança a LINHA inteira. Então a "página" que o
 *    navegador imprime é a linha, não a etiqueta: `colunas` etiquetas
 *    separadas por `espaco`, com `margem` nas duas bordas.
 *
 * Tudo em `configuracoes_sistema`, uma linha por empresa (migrations 063 e 064).
 */

// ── Desenhos-base ─────────────────────────────────────────────

export type EtiquetaLayout = 'paisagem' | 'retrato'

export const LAYOUT_BASE: Record<EtiquetaLayout, EtiquetaDims> = {
  paisagem: { largura: 100, altura: 75 },
  retrato: { largura: 34, altura: 65 },
}

/** Papel mais largo do que alto usa o desenho deitado; o resto, o em pé. */
export function layoutDaEtiqueta(dims: EtiquetaDims): EtiquetaLayout {
  return dims.largura >= dims.altura ? 'paisagem' : 'retrato'
}

export const ETIQUETA_MIN_MM = 10
export const ETIQUETA_MAX_MM = 400
export const ETIQUETA_MAX_COLUNAS = 10
export const ETIQUETA_MAX_ESPACO_MM = 50

// ── Configuração ──────────────────────────────────────────────

export type EtiquetaTipo = 'lote' | 'recipiente'

export type EtiquetaDims = { largura: number; altura: number }

export type EtiquetaConfig = EtiquetaDims & {
  colunas: number
  espaco: number
  margem: number
}

export const ETIQUETA_CONFIG_PADRAO: EtiquetaConfig = {
  largura: 100,
  altura: 75,
  colunas: 1,
  espaco: 0,
  margem: 0,
}

/** Tamanhos de rolo mais comuns em impressora térmica de etiqueta. */
export const ETIQUETA_PRESETS: { largura: number; altura: number; nome: string }[] = [
  { largura: 100, altura: 75, nome: 'Padrão' },
  { largura: 100, altura: 50, nome: 'Rolo largo' },
  { largura: 80, altura: 60, nome: 'Média' },
  { largura: 60, altura: 40, nome: 'Pequena' },
  { largura: 50, altura: 30, nome: 'Mini' },
  { largura: 34, altura: 65, nome: 'Em pé' },
  { largura: 40, altura: 60, nome: 'Em pé larga' },
]

const COLUNAS_DB: Record<EtiquetaTipo, Record<keyof EtiquetaConfig, string>> = {
  lote: {
    largura: 'etiqueta_lote_largura_mm',
    altura: 'etiqueta_lote_altura_mm',
    colunas: 'etiqueta_lote_colunas',
    espaco: 'etiqueta_lote_espaco_mm',
    margem: 'etiqueta_lote_margem_mm',
  },
  recipiente: {
    largura: 'etiqueta_recipiente_largura_mm',
    altura: 'etiqueta_recipiente_altura_mm',
    colunas: 'etiqueta_recipiente_colunas',
    espaco: 'etiqueta_recipiente_espaco_mm',
    margem: 'etiqueta_recipiente_margem_mm',
  },
}

export function colunasEtiqueta(tipo: EtiquetaTipo) {
  return COLUNAS_DB[tipo]
}

function entre(valor: unknown, min: number, max: number, padrao: number): number {
  const n = Number(valor)
  if (!Number.isFinite(n) || n < min || n > max) return padrao
  return n
}

/** Descarta valor ausente, não-numérico ou fora da faixa aceita pelo banco. */
export function saneiaConfig(bruto: Partial<Record<keyof EtiquetaConfig, unknown>>): EtiquetaConfig {
  return {
    largura: entre(bruto.largura, ETIQUETA_MIN_MM, ETIQUETA_MAX_MM, ETIQUETA_CONFIG_PADRAO.largura),
    altura: entre(bruto.altura, ETIQUETA_MIN_MM, ETIQUETA_MAX_MM, ETIQUETA_CONFIG_PADRAO.altura),
    colunas: Math.round(entre(bruto.colunas, 1, ETIQUETA_MAX_COLUNAS, ETIQUETA_CONFIG_PADRAO.colunas)),
    espaco: entre(bruto.espaco, 0, ETIQUETA_MAX_ESPACO_MM, ETIQUETA_CONFIG_PADRAO.espaco),
    margem: entre(bruto.margem, 0, ETIQUETA_MAX_ESPACO_MM, ETIQUETA_CONFIG_PADRAO.margem),
  }
}

/** Lê a configuração da linha do banco, coluna por coluna, já saneada. */
export function configDaLinha(tipo: EtiquetaTipo, row: Record<string, unknown> | null): EtiquetaConfig {
  const cols = COLUNAS_DB[tipo]
  if (!row) return ETIQUETA_CONFIG_PADRAO
  return saneiaConfig({
    largura: row[cols.largura],
    altura: row[cols.altura],
    colunas: row[cols.colunas],
    espaco: row[cols.espaco],
    margem: row[cols.margem],
  })
}

/**
 * Lê a configuração de um tipo de etiqueta.
 *
 * Enquanto carrega — e se a empresa ainda não tem linha em
 * `configuracoes_sistema` — devolve o padrão, que é exatamente o que o
 * sistema imprimia antes desta configuração existir.
 */
export function useEtiquetaConfig(tipo: EtiquetaTipo): { config: EtiquetaConfig; carregando: boolean } {
  const { profile } = useAuth()
  const [config, setConfig] = useState<EtiquetaConfig>(ETIQUETA_CONFIG_PADRAO)
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    if (!profile) return
    let cancelado = false
    const cols = COLUNAS_DB[tipo]

    supabase
      .from('configuracoes_sistema')
      .select(Object.values(cols).join(', '))
      .eq('empresa_id', profile.empresa_id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelado) return
        setConfig(configDaLinha(tipo, data as Record<string, unknown> | null))
        setCarregando(false)
      })

    return () => { cancelado = true }
  }, [profile, tipo])

  return { config, carregando }
}

// ── Geometria ─────────────────────────────────────────────────

/** Quanto o desenho-base precisa encolher/crescer para caber no papel. */
export function escalaEtiqueta(dims: EtiquetaDims): number {
  const base = LAYOUT_BASE[layoutDaEtiqueta(dims)]
  return Math.min(dims.largura / base.largura, dims.altura / base.altura)
}

/** Quanto do papel sobra em branco, de 0 a 1, por diferença de formato. */
export function sobraEtiqueta(dims: EtiquetaDims): number {
  const base = LAYOUT_BASE[layoutDaEtiqueta(dims)]
  const escala = escalaEtiqueta(dims)
  const usado = base.largura * escala * base.altura * escala
  return 1 - usado / (dims.largura * dims.altura)
}

/** O tamanho da "página" que a impressora recebe: uma LINHA do rolo. */
export function dimsLinha(config: EtiquetaConfig): EtiquetaDims {
  return {
    largura:
      2 * config.margem
      + config.colunas * config.largura
      + (config.colunas - 1) * config.espaco,
    altura: config.altura,
  }
}

/** Quebra a lista de etiquetas em linhas do rolo. */
export function emLinhas<T>(itens: T[], colunas: number): T[][] {
  const n = Math.max(1, colunas)
  const linhas: T[][] = []
  for (let i = 0; i < itens.length; i += n) linhas.push(itens.slice(i, i + n))
  return linhas
}

// ── Impressão ─────────────────────────────────────────────────

/**
 * Folha de estilo de impressão comum às telas de etiqueta.
 *
 * Esconde tudo que é de tela e deixa visível só `.etiqueta-print-target`,
 * posicionado no canto da página. `size` é a linha do rolo.
 */
export function etiquetaPrintStyles(config: EtiquetaConfig): string {
  const linha = dimsLinha(config)
  return `
  .etiqueta-print-target { display: none; }

  @page { size: ${linha.largura}mm ${linha.altura}mm; margin: 0; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; }

    body > * { visibility: hidden; }

    .etiqueta-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0;
      left: 0;
    }
    .etiqueta-print-target * { visibility: visible !important; }
    .etiqueta-page-break { page-break-after: always; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`
}

/**
 * Moldura de UMA etiqueta: recorta na medida configurada e encaixa o
 * desenho-base no meio, na maior escala que couber.
 *
 * O conteúdo (`children`) deve ser desenhado no tamanho do layout — é o que
 * garante que a pré-visualização e o papel mostrem a mesma coisa.
 */
export function EtiquetaCanvas({ dims, children }: { dims: EtiquetaDims; children: ReactNode }) {
  const base = LAYOUT_BASE[layoutDaEtiqueta(dims)]
  const escala = escalaEtiqueta(dims)
  const sobraX = (dims.largura - base.largura * escala) / 2
  const sobraY = (dims.altura - base.altura * escala) / 2

  return (
    <div
      style={{
        width: `${dims.largura}mm`,
        height: `${dims.altura}mm`,
        overflow: 'hidden',
        position: 'relative',
        boxSizing: 'border-box',
        backgroundColor: '#fff',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: `${sobraY}mm`,
          left: `${sobraX}mm`,
          width: `${base.largura}mm`,
          height: `${base.altura}mm`,
          transform: `scale(${escala})`,
          transformOrigin: 'top left',
        }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Uma LINHA do rolo: as etiquetas lado a lado, com o vão entre colunas e a
 * margem nas bordas. Colunas que sobram no fim ficam em branco — o papel
 * anda de linha inteira de qualquer jeito.
 */
export function EtiquetaLinhaRolo({ config, children }: { config: EtiquetaConfig; children: ReactNode }) {
  const linha = dimsLinha(config)
  return (
    <div
      style={{
        width: `${linha.largura}mm`,
        height: `${linha.altura}mm`,
        padding: `0 ${config.margem}mm`,
        display: 'flex',
        gap: `${config.espaco}mm`,
        boxSizing: 'border-box',
        overflow: 'hidden',
        backgroundColor: '#fff',
      }}
    >
      {children}
    </div>
  )
}

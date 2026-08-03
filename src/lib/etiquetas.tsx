import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
  /** Vão entre uma linha de etiquetas e a próxima. Entra na altura da página. */
  espacoLinha: number
  /** Ajuste fino: empurra tudo o que é impresso. Aceita negativo. */
  deslocarX: number
  deslocarY: number
}

export const ETIQUETA_CONFIG_PADRAO: EtiquetaConfig = {
  largura: 100,
  altura: 75,
  colunas: 1,
  espaco: 0,
  margem: 0,
  espacoLinha: 0,
  deslocarX: 0,
  deslocarY: 0,
}

export const ETIQUETA_MAX_DESLOCAR_MM = 30

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
    espacoLinha: 'etiqueta_lote_espaco_linha_mm',
    deslocarX: 'etiqueta_lote_deslocar_x_mm',
    deslocarY: 'etiqueta_lote_deslocar_y_mm',
  },
  recipiente: {
    largura: 'etiqueta_recipiente_largura_mm',
    altura: 'etiqueta_recipiente_altura_mm',
    colunas: 'etiqueta_recipiente_colunas',
    espaco: 'etiqueta_recipiente_espaco_mm',
    margem: 'etiqueta_recipiente_margem_mm',
    espacoLinha: 'etiqueta_recipiente_espaco_linha_mm',
    deslocarX: 'etiqueta_recipiente_deslocar_x_mm',
    deslocarY: 'etiqueta_recipiente_deslocar_y_mm',
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
    espacoLinha: entre(bruto.espacoLinha, 0, ETIQUETA_MAX_ESPACO_MM, ETIQUETA_CONFIG_PADRAO.espacoLinha),
    deslocarX: entre(bruto.deslocarX, -ETIQUETA_MAX_DESLOCAR_MM, ETIQUETA_MAX_DESLOCAR_MM, 0),
    deslocarY: entre(bruto.deslocarY, -ETIQUETA_MAX_DESLOCAR_MM, ETIQUETA_MAX_DESLOCAR_MM, 0),
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
    espacoLinha: row[cols.espacoLinha],
    deslocarX: row[cols.deslocarX],
    deslocarY: row[cols.deslocarY],
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

/**
 * O tamanho da "página" que a impressora recebe: uma LINHA do rolo.
 *
 * A altura inclui o vão até a linha seguinte — é o passo do rolo, não a
 * altura da etiqueta. Sem isso a impressão escorrega um pouco a cada linha.
 */
export function dimsLinha(config: EtiquetaConfig): EtiquetaDims {
  return {
    largura:
      2 * config.margem
      + config.colunas * config.largura
      + (config.colunas - 1) * config.espaco,
    altura: config.altura + config.espacoLinha,
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
 * O resto da página sai do fluxo com `display: none` — e não com
 * `visibility: hidden`. Escondido por visibilidade, o conteúdo de tela
 * continua ocupando altura e o navegador emite páginas em branco entre as
 * etiquetas: numa página de 65mm isso vira rolo desperdiçado.
 *
 * Para o seletor funcionar sem depender de onde a tela está na árvore, a
 * área de impressão é levada para filha direta do `body` por
 * `EtiquetaFolhaImpressao`.
 *
 * O `visibility: visible` continua necessário: `index.css` tem um
 * `@media print { body * { visibility: hidden } }` global que atinge o
 * conteúdo da etiqueta mesmo estando fora do fluxo do app. Sem esta regra,
 * saem as páginas na quantidade certa, do tamanho certo — e em branco.
 */
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

/**
 * A área que vai para o papel, montada como filha direta do `body`.
 *
 * O portal existe para que nenhuma margem, padding ou altura das telas do
 * app entre na conta da página impressa — o que sai na impressora é só o que
 * está aqui dentro.
 */
export function EtiquetaFolhaImpressao({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="etiqueta-print-target">{children}</div>,
    document.body,
  )
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
  const deslocado = config.deslocarX !== 0 || config.deslocarY !== 0

  return (
    <div
      style={{
        width: `${linha.largura}mm`,
        height: `${linha.altura}mm`,
        boxSizing: 'border-box',
        overflow: 'hidden',
        backgroundColor: '#fff',
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: `${config.espaco}mm`,
          padding: `0 ${config.margem}mm`,
          boxSizing: 'border-box',
          width: `${linha.largura}mm`,
          height: `${config.altura}mm`,
          // O ajuste fino move o conteúdo dentro da página, sem mudar o
          // tamanho dela — é o empurrão que alinha com a etiqueta física.
          transform: deslocado
            ? `translate(${config.deslocarX}mm, ${config.deslocarY}mm)`
            : undefined,
        }}
      >
        {children}
      </div>
    </div>
  )
}

import { QRCodeSVG } from 'qrcode.react'
import type { Lote, Empresa } from '../../types/database.types'
import { formatDate, formatDateTime } from '../../lib/utils'
import { LAYOUT_BASE, layoutDaEtiqueta, type EtiquetaDims } from '../../lib/etiquetas'

/**
 * O conteúdo da etiqueta de lote/sublote, nos dois desenhos possíveis.
 *
 * Cada desenho é feito no tamanho-base do seu layout (100x75mm deitado,
 * 34x65mm em pé) e é o `EtiquetaCanvas` que o ajusta ao papel configurado.
 * Quem escolhe o desenho é o formato do papel, não a tela: um rolo em pé
 * usando o desenho deitado desperdiçaria mais da metade da etiqueta.
 *
 * Os dois carregam a mesma informação. O que muda é o arranjo e o quanto
 * cada bloco pode ocupar.
 */

export type LoteEtiqueta = Lote & {
  insumo: { nome: string; codigo: string; unidade_medida: string; shelf_life_dias_pos_abertura?: number }
  fornecedor?: { nome: string }
  marca?: { nome: string }
  recebido_usuario?: { nome: string }
}

type Props = { lote: LoteEtiqueta; empresa: Empresa | null; dims: EtiquetaDims }

/** Os campos da etiqueta, já formatados — iguais nos dois desenhos. */
function dadosDoLote(lote: LoteEtiqueta, empresa: Empresa | null) {
  const marcaForn = [
    (lote.marca as unknown as { nome: string } | null)?.nome,
    (lote.fornecedor as unknown as { nome: string } | null)?.nome,
  ].filter(Boolean).join(' - ')

  const shelfLife = (lote.insumo as unknown as { shelf_life_dias_pos_abertura?: number })?.shelf_life_dias_pos_abertura

  return {
    marcaForn: marcaForn || '—',
    responsavel: (lote.recebido_usuario as unknown as { nome: string } | null)?.nome ?? '',
    cnpj: empresa?.cnpj ?? '',
    endereco: [empresa?.endereco, empresa?.cidade, empresa?.estado].filter(Boolean).join(', '),
    empresaNome: empresa?.nome ?? 'Unno',
    aposAbertura: shelfLife != null ? `${shelfLife} DIAS` : '—',
    qrContent: [lote.codigo, lote.data_recebimento, lote.numero_nf ?? ''].filter(Boolean).join('|'),
  }
}

export function EtiquetaLoteContent({ lote, empresa, dims }: Props) {
  return layoutDaEtiqueta(dims) === 'retrato'
    ? <LoteRetrato lote={lote} empresa={empresa} />
    : <LotePaisagem lote={lote} empresa={empresa} />
}

// ── Deitada (base 100x75mm) ───────────────────────────────────

function LotePaisagem({ lote, empresa }: { lote: LoteEtiqueta; empresa: Empresa | null }) {
  const d = dadosDoLote(lote, empresa)
  const base = LAYOUT_BASE.paisagem

  return (
    <div style={{
      width: `${base.largura}mm`,
      height: `${base.altura}mm`,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxSizing: 'border-box',
    }}>

      {/* ── CABEÇALHO ── */}
      <div style={{ padding: '4mm 4mm 3mm 4mm', flexShrink: 0 }}>
        <div style={{ fontSize: '14pt', fontWeight: 'bold', lineHeight: 1.2 }}>
          {lote.insumo.nome}
        </div>
        <div style={{ fontSize: '8pt', color: '#6b7280', marginTop: '1mm' }}>
          {d.empresaNome}
        </div>
      </div>

      {/* ── CORPO (dados + QR) ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        borderTop: '1.5pt solid #000',
        borderBottom: '1.5pt solid #000',
        minHeight: 0,
      }}>
        <div style={{
          flex: '0 0 62mm',
          padding: '2.5mm 3mm',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRight: '1pt solid #000',
        }}>
          <Campo label="RECEBIMENTO:" value={formatDate(lote.data_recebimento)} />
          <Campo label="VALIDADE ORIGINAL:" value={formatDate(lote.validade_original)} />
          <Campo label="MANIPULAÇÃO:" value={formatDateTime(lote.created_at)} />
          <Campo label="VALIDADE:" value={formatDate(lote.validade_pos_abertura)} bold />
          <Campo label="APÓS ABERTURA:" value={d.aposAbertura} />
          <Campo label="MARCA/FORN.:" value={d.marcaForn} />
        </div>

        <div style={{
          flex: 1,
          padding: '2.5mm 3mm',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: '7pt', alignSelf: 'flex-start' }}>
            <span style={{ fontWeight: 'bold' }}>LOTE: </span>{lote.codigo}
          </div>
          <div style={{ fontSize: '7pt', alignSelf: 'flex-start', marginTop: '1.5mm' }}>
            <span style={{ fontWeight: 'bold' }}>NF: </span>{lote.numero_nf || '—'}
          </div>
          <div style={{ marginTop: '2mm', flex: 1, display: 'flex', alignItems: 'center' }}>
            <QRCodeSVG value={d.qrContent} size={90} level="M" includeMargin={false} />
          </div>
        </div>
      </div>

      {/* ── RODAPÉ ── */}
      <div style={{
        padding: '1.5mm 4mm',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: '6.5pt' }}>
            <span style={{ fontWeight: 'bold' }}>RESP.: </span>
            <span style={{ fontWeight: 'bold' }}>{d.responsavel}</span>
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm' }}>
            <span style={{ fontWeight: 'bold' }}>CNPJ: </span>{d.cnpj}
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm', maxWidth: '70mm', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <span style={{ fontWeight: 'bold' }}>END.: </span>{d.endereco}
          </div>
        </div>
        <div style={{ fontSize: '6pt', color: '#6b7280', whiteSpace: 'nowrap' }}>
          #{lote.codigo}
        </div>
      </div>
    </div>
  )
}

function Campo({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ fontSize: '7.5pt', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span style={{ fontWeight: 'bold' }}>{label} </span>
      <span style={{ fontWeight: bold ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

// ── Em pé (base 34x65mm) ──────────────────────────────────────

/**
 * Numa etiqueta estreita não cabe tudo lado a lado, então a informação vira
 * uma pilha e a ordem passa a ser a de quem lê no estoque: o que é o insumo,
 * até quando serve, e só depois a papelada.
 *
 * A validade vem em caixa invertida porque é o único campo que alguém
 * procura de longe, com o pote na mão.
 */
function LoteRetrato({ lote, empresa }: { lote: LoteEtiqueta; empresa: Empresa | null }) {
  const d = dadosDoLote(lote, empresa)
  const base = LAYOUT_BASE.retrato

  return (
    <div style={{
      width: `${base.largura}mm`,
      height: `${base.altura}mm`,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      padding: '1.2mm 1.5mm 1.8mm 1.5mm',
      overflow: 'hidden',
      boxSizing: 'border-box',
    }}>

      {/* ── Faixa destacável ──
          O rolo tem uma picotada a ZONA_DESTACAVEL_MM do topo. Tudo o que
          precisa sobreviver ao destaque — o que é, de quem é, até quando
          serve — cabe acima dela; o resto (papelada e QR) fica abaixo.
          As medidas deste bloco existem para respeitar esse limite: mexer
          em fonte ou espaçamento aqui exige refazer a conta. */}

      {/* Nome do insumo — até duas linhas, o resto corta.
          A altura é fixa (mesmo com nome de uma linha só) para que as
          etiquetas da mesma linha do rolo saiam alinhadas entre si. */}
      <div style={{
        fontSize: '7pt',
        fontWeight: 'bold',
        lineHeight: 1.12,
        height: '5.6mm',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        {lote.insumo.nome}
      </div>
      {/* Mesmo corpo e peso do "LOTE" lá embaixo, em maiúsculas: é o nome da
          empresa que responde pelo produto, e precisa se ler de perto. */}
      <div style={{
        fontSize: '6.5pt',
        fontWeight: 'bold',
        lineHeight: 1.1,
        textTransform: 'uppercase',
        marginTop: '0.3mm',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}>
        {d.empresaNome}
      </div>

      {/* Validade — o campo que se lê de longe */}
      <div style={{
        marginTop: '0.8mm',
        background: '#000',
        color: '#fff',
        padding: '0.7mm 1mm',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: '4.5pt', lineHeight: 1.1, letterSpacing: '0.3pt' }}>VALIDADE</div>
        <div style={{ fontSize: '9.5pt', fontWeight: 'bold', lineHeight: 1.05 }}>
          {formatDate(lote.validade_pos_abertura)}
        </div>
      </div>
      {/* ── fim da faixa destacável (≈16,8mm de 18,5mm) ── */}

      {/* Demais datas e origem */}
      <div style={{ marginTop: '1.2mm', flexShrink: 0 }}>
        <CampoRetrato label="RECEB." value={formatDate(lote.data_recebimento)} />
        <CampoRetrato label="VAL. ORIG." value={formatDate(lote.validade_original)} />
        <CampoRetrato label="MANIP." value={formatDateTime(lote.created_at)} />
        <CampoRetrato label="APÓS ABERT." value={d.aposAbertura} />
        <CampoRetrato label="MARCA/FORN." value={d.marcaForn} />
      </div>

      {/* Lote e NF */}
      <div style={{
        marginTop: '1mm',
        paddingTop: '0.8mm',
        borderTop: '1pt solid #000',
        flexShrink: 0,
      }}>
        {/* O código do lote é a chave da rastreabilidade: em vez de cortar
            com reticências, quebra em duas linhas. Sublote longo
            (INS028-0001.12/12) passa de uma linha em etiqueta estreita. */}
        <div style={{
          fontSize: '6.5pt',
          fontWeight: 'bold',
          lineHeight: 1.15,
          wordBreak: 'break-all',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          LOTE: {lote.codigo}
        </div>
        <div style={{ fontSize: '5.8pt', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          NF: {lote.numero_nf || '—'}
        </div>
      </div>

      {/* QR — ocupa o que sobrar, centralizado. O tamanho deixa folga na
          altura para o código do lote usar duas linhas. Em 203dpi, 15mm dão
          ~3,5 pontos por módulo do QR: sobra de leitura com folga. */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: '1mm',
      }}>
        <QRCodeSVG value={d.qrContent} size={57} level="M" includeMargin={false} />
      </div>

      {/* Responsável e CNPJ */}
      <div style={{ flexShrink: 0, marginTop: '0.8mm' }}>
        <div style={{ fontSize: '5.2pt', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span style={{ fontWeight: 'bold' }}>RESP.: </span>{d.responsavel}
        </div>
        <div style={{ fontSize: '5.2pt', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span style={{ fontWeight: 'bold' }}>CNPJ: </span>{d.cnpj}
        </div>
      </div>
    </div>
  )
}

function CampoRetrato({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      fontSize: '6pt',
      lineHeight: 1.35,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      <span style={{ fontWeight: 'bold' }}>{label}: </span>{value}
    </div>
  )
}

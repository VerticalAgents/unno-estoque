import { QRCodeSVG } from 'qrcode.react'
import type { Local, Insumo } from '../../types/database.types'
import { formatDate } from '../../lib/utils'
import { LAYOUT_BASE, baseDoLayout, layoutDaEtiqueta, type EtiquetaDims } from '../../lib/etiquetas'

/**
 * O conteúdo da etiqueta de recipiente, nos dois desenhos possíveis —
 * mesma ideia da etiqueta de lote: `paisagem` (100mm de largura, altura na
 * proporção do papel) e `retrato` (34x65mm), escolhidos pelo formato do papel.
 *
 * O que não pode faltar em nenhum dos dois: o QR fixo (é o que a produção
 * escaneia), o nome do recipiente e o aviso de que isto NÃO é etiqueta de
 * lote — as duas circulam pela mesma bancada.
 */

export const SUBTIPO_LABELS: Record<string, string> = {
  balde: 'Balde',
  balde_fornecedor: 'Balde do fornecedor',
  caixa_plastica: 'Caixa plástica',
  garrafa: 'Garrafa',
  garrafa_fornecedor: 'Garrafa do fornecedor',
  saco_confeitar: 'Saco de confeitar',
  lata: 'Lata',
  prateleira: 'Prateleira',
}

export type RecipienteEtiqueta = Local & { insumo?: Insumo }

type Props = { recipiente: RecipienteEtiqueta; dims: EtiquetaDims }

export function EtiquetaRecipienteContent({ recipiente, dims }: Props) {
  return layoutDaEtiqueta(dims) === 'retrato'
    ? <RecipienteRetrato recipiente={recipiente} />
    : <RecipientePaisagem recipiente={recipiente} base={baseDoLayout(dims)} />
}

function subtipoDe(recipiente: RecipienteEtiqueta): string {
  return SUBTIPO_LABELS[recipiente.subtipo ?? ''] ?? recipiente.subtipo ?? '—'
}

// ── Deitada (100mm de largura, altura na proporção do papel) ──

/** Um milímetro em pixels de CSS — o QR só aceita tamanho em px. */
const PX_POR_MM = 96 / 25.4

/**
 * O desenho deitado, refeito em 08/08/2026 junto com a etiqueta de lote.
 *
 * Duas coisas estavam erradas. O desenho era preso em 100x75mm, então numa
 * etiqueta 100x50 ele entrava encolhido a 67% e sobravam 17mm de papel branco
 * de cada lado — foi o "mal enquadrada" que o usuário viu. E ele ainda usava a
 * linguagem antiga (caixinha com borda fina, dados soltos), de antes da
 * etiqueta de lote ganhar a tarja preta.
 *
 * Agora a altura vem do papel (`baseDoLayout`) e o arranjo é o mesmo da
 * etiqueta de lote: tarja preta com o que se lê de longe — aqui o NOME do
 * recipiente, que é o que a pessoa procura na bancada —, campos à esquerda e
 * QR à direita, com o aviso de "não é etiqueta de lote" no rodapé.
 */
function RecipientePaisagem({ recipiente, base }: { recipiente: RecipienteEtiqueta; base: EtiquetaDims }) {
  const qr = recipiente.qr_code_fixo ?? recipiente.id

  // O QR cresce com o papel, mas para de crescer antes de empurrar os campos:
  // em 203dpi, 22mm já dão folga de sobra para a leitura.
  const qrMm = Math.max(18, Math.min(30, base.altura * 0.5))

  return (
    <div style={{
      width: `${base.largura}mm`,
      height: `${base.altura}mm`,
      fontFamily: 'sans-serif',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxSizing: 'border-box',
      padding: '2.5mm',
    }}>

      {/* ── Tarja preta: o nome, que é o que se lê de longe ── */}
      <div style={{
        background: '#000',
        color: '#fff',
        padding: '1mm 2mm',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: '5.5pt',
          letterSpacing: '0.5pt',
          fontWeight: 'bold',
        }}>
          <span>RECIPIENTE EP</span>
          <span>{subtipoDe(recipiente).toUpperCase()}</span>
        </div>
        <div style={{
          fontSize: '15pt',
          fontWeight: 'bold',
          lineHeight: 1.1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {recipiente.nome}
        </div>
      </div>

      {/* ── Corpo: campos à esquerda, QR à direita ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: '3mm', paddingTop: '2mm' }}>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '1.2mm',
        }}>
          {recipiente.insumo && <InfoRow label="INSUMO" value={recipiente.insumo.nome} destaque />}
          {recipiente.capacidade_max != null && (
            <InfoRow
              label="CAPACIDADE"
              value={`${recipiente.capacidade_max} ${recipiente.unidade_capacidade ?? ''}`.trim()}
            />
          )}
          <InfoRow label="CADASTRO" value={formatDate(recipiente.created_at)} />
          {recipiente.observacoes && <InfoRow label="OBS" value={recipiente.observacoes} />}
        </div>

        <div style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <QRCodeSVG value={qr} size={qrMm * PX_POR_MM} level="M" includeMargin={false} />
          <div style={{
            fontFamily: 'monospace',
            fontSize: '5pt',
            color: '#000',
            marginTop: '0.8mm',
            maxWidth: `${qrMm + 6}mm`,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {qr}
          </div>
        </div>
      </div>

      {/* ── Rodapé: as duas etiquetas circulam pela mesma bancada ── */}
      <div style={{
        flexShrink: 0,
        marginTop: '1.5mm',
        borderTop: '1pt solid #000',
        paddingTop: '1mm',
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '6pt',
        fontWeight: 'bold',
        letterSpacing: '0.3pt',
      }}>
        <span>USO INTERNO · NÃO É ETIQUETA DE LOTE</span>
        <span style={{ fontWeight: 'normal' }}>Unno</span>
      </div>
    </div>
  )
}

/**
 * Rótulo e valor de um campo.
 *
 * Nada de cinza aqui: impressora térmica é preto ou nada. Ela não tem tom
 * intermediário, então cinza vira pontilhado — e a 6pt o pontilhado quase
 * some, que foi o "ficaram muito fracos" do usuário em 08/08/2026. A
 * hierarquia entre rótulo e valor é feita por TAMANHO, que a térmica
 * reproduz, e não por cor, que ela não reproduz.
 */
function InfoRow({ label, value, destaque }: { label: string; value: string; destaque?: boolean }) {
  return (
    <div style={{
      fontSize: destaque ? '9pt' : '8pt',
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      <span style={{ fontSize: '6pt', fontWeight: 'bold', letterSpacing: '0.3pt' }}>{label}: </span>
      <span style={{ fontWeight: destaque ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

// ── Em pé (base 34x65mm) ──────────────────────────────────────

function RecipienteRetrato({ recipiente }: { recipiente: RecipienteEtiqueta }) {
  const qr = recipiente.qr_code_fixo ?? recipiente.id
  const base = LAYOUT_BASE.retrato

  return (
    <div
      className="font-sans"
      style={{
        width: `${base.largura}mm`,
        height: `${base.altura}mm`,
        padding: '1.5mm',
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Faixa de identificação — some a chance de confundir com etiqueta de lote */}
      <div style={{
        background: '#000',
        color: '#fff',
        fontSize: '5pt',
        fontWeight: 'bold',
        letterSpacing: '0.4pt',
        textAlign: 'center',
        padding: '0.6mm 0',
        flexShrink: 0,
      }}>
        RECIPIENTE EP
      </div>

      {/* Nome */}
      <div style={{
        marginTop: '1mm',
        fontSize: '8pt',
        fontWeight: 800,
        lineHeight: 1.15,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        {recipiente.nome}
      </div>
      <div style={{
        fontSize: '5pt',
        color: '#000',
        paddingBottom: '0.8mm',
        borderBottom: '1pt solid #000',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}>
        {subtipoDe(recipiente)}
      </div>

      {/* QR — o que a produção escaneia, então fica com o maior espaço */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.8mm',
      }}>
        <QRCodeSVG value={qr} size={76} level="M" includeMargin={false} />
        <p style={{
          fontFamily: 'monospace',
          fontSize: '4.5pt',
          color: '#000',
          maxWidth: '30mm',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}>
          {qr}
        </p>
      </div>

      {/* Dados */}
      <div style={{ flexShrink: 0 }}>
        {recipiente.insumo && (
          <CampoRetrato label="INSUMO" value={recipiente.insumo.nome} bold />
        )}
        {recipiente.capacidade_max != null && (
          <CampoRetrato
            label="CAPAC."
            value={`${recipiente.capacidade_max} ${recipiente.unidade_capacidade ?? ''}`}
          />
        )}
        <CampoRetrato label="CADASTRO" value={formatDate(recipiente.created_at)} />
      </div>

      <div style={{
        marginTop: '0.8mm',
        border: '0.5pt solid #000',
        borderRadius: '0.5mm',
        fontSize: '4pt',
        color: '#000',
        textAlign: 'center',
        padding: '0.4mm 0',
        flexShrink: 0,
      }}>
        USO INTERNO · NÃO É ETIQUETA DE LOTE
      </div>
    </div>
  )
}

function CampoRetrato({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{
      fontSize: '5pt',
      lineHeight: 1.45,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      <span>{label}: </span>
      <span style={{ fontWeight: bold ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

import { QRCodeSVG } from 'qrcode.react'
import type { Local, Insumo } from '../../types/database.types'
import { formatDate } from '../../lib/utils'
import { LAYOUT_BASE, layoutDaEtiqueta, type EtiquetaDims } from '../../lib/etiquetas'

/**
 * O conteúdo da etiqueta de recipiente, nos dois desenhos possíveis —
 * mesma ideia da etiqueta de lote: `paisagem` (100x75mm) e `retrato`
 * (34x65mm), escolhidos pelo formato do papel configurado.
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
    : <RecipientePaisagem recipiente={recipiente} />
}

function subtipoDe(recipiente: RecipienteEtiqueta): string {
  return SUBTIPO_LABELS[recipiente.subtipo ?? ''] ?? recipiente.subtipo ?? '—'
}

// ── Deitada (base 100x75mm) ───────────────────────────────────

function RecipientePaisagem({ recipiente }: { recipiente: RecipienteEtiqueta }) {
  const qr = recipiente.qr_code_fixo ?? recipiente.id
  const base = LAYOUT_BASE.paisagem

  return (
    <div
      className="font-sans text-[9pt]"
      style={{
        width: `${base.largura}mm`,
        height: `${base.altura}mm`,
        padding: '3mm',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Badge de identificação — diferencia visualmente da etiqueta de lote */}
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold uppercase tracking-widest text-[7pt] border border-gray-800">
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
          </svg>
          Recipiente EP
        </span>
        <span className="font-mono text-gray-400" style={{ fontSize: '7pt' }}>
          Unno
        </span>
      </div>

      {/* Nome do recipiente */}
      <div className="mb-2 pb-1.5 border-b-2 border-gray-800">
        <p className="font-extrabold leading-tight text-[14pt]">{recipiente.nome}</p>
        <p className="text-gray-500 text-[8pt]">{subtipoDe(recipiente)}</p>
      </div>

      {/* QR + dados */}
      <div className="flex gap-4 items-start">
        <div className="shrink-0 flex flex-col items-center">
          <QRCodeSVG value={qr} size={90} level="M" includeMargin={false} />
          <p className="font-mono text-center mt-1 text-gray-600" style={{ fontSize: '6.5pt' }}>
            {qr}
          </p>
        </div>

        <div className="flex-1 space-y-1.5">
          {recipiente.insumo && (
            <InfoRow label="Insumo" value={recipiente.insumo.nome} highlight />
          )}
          {recipiente.capacidade_max != null && (
            <InfoRow
              label="Capacidade"
              value={`${recipiente.capacidade_max} ${recipiente.unidade_capacidade ?? ''}`}
            />
          )}
          <InfoRow label="Cadastrado" value={formatDate(recipiente.created_at)} />
          {recipiente.observacoes && <InfoRow label="Obs" value={recipiente.observacoes} />}
          <div className="pt-1">
            <span className="inline-block px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-gray-500 font-mono text-[6.5pt]">
              USO INTERNO · NÃO É ETIQUETA DE LOTE
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <span className="uppercase tracking-wide text-gray-400 text-[7pt]">{label}: </span>
      <span className={`font-medium text-[9pt] ${highlight ? 'text-gray-900 font-bold' : 'text-gray-700'}`}>
        {value}
      </span>
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
        color: '#6b7280',
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
          color: '#4b5563',
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
        border: '0.5pt solid #9ca3af',
        borderRadius: '0.5mm',
        fontSize: '4pt',
        color: '#4b5563',
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
      <span style={{ color: '#6b7280' }}>{label}: </span>
      <span style={{ fontWeight: bold ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

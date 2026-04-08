import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Lote, Empresa } from '../../types/database.types'
import { QRCodeSVG } from 'qrcode.react'
import { formatDate, formatDateTime } from '../../lib/utils'
import { Button } from '../../components/ui/Button'

type LoteWithInsumo = Lote & {
  insumo: { nome: string; codigo: string; unidade_medida: string; shelf_life_dias_pos_abertura?: number }
  fornecedor?: { nome: string }
  marca?: { nome: string }
  recebido_usuario?: { nome: string }
}

export function ImpressaoEtiquetaPage() {
  const { loteId } = useParams<{ loteId: string }>()
  const { profile } = useAuth()
  const [lote, setLote] = useState<LoteWithInsumo | null>(null)
  const [empresa, setEmpresa] = useState<Empresa | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!loteId || !profile) return
    Promise.all([
      supabase
        .from('lotes')
        .select('*, insumo:insumos(nome, codigo, unidade_medida, shelf_life_dias_pos_abertura), fornecedor:fornecedores(nome), marca:marcas(nome), recebido_usuario:usuarios!lotes_recebido_por_fkey(nome)')
        .eq('id', loteId)
        .single(),
      supabase.from('empresas').select('*').eq('id', profile.empresa_id).single(),
    ]).then(([l, e]) => {
      setLote(l.data as unknown as LoteWithInsumo)
      setEmpresa(e.data as Empresa)
      setLoading(false)
    })
  }, [loteId, profile])

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!lote) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Lote não encontrado.</p>
      <Link to="/recebimento" className="text-brand-600 text-sm mt-2 inline-block">← Voltar</Link>
    </div>
  )

  return (
    <>
      <style>{printStyles}</style>

      {/* Screen-only: header + preview wrapper + buttons */}
      <div className="etiqueta-screen-ui p-4 sm:p-6 max-w-lg mx-auto">
        <div className="mb-6">
          <Link to="/recebimento" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Recebimento
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Etiqueta do Lote</h1>
          <p className="text-sm text-gray-500 mt-0.5">Pré-visualização antes de imprimir</p>
        </div>

        {/* Preview card */}
        <div className="flex justify-center mb-6">
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-3 inline-block">
            <LabelContent lote={lote} empresa={empresa} />
          </div>
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <Link to="/recebimento/novo">
            <Button variant="secondary" size="lg">Novo lote</Button>
          </Link>
          <Button
            size="lg"
            fullWidth
            onClick={async () => {
              await supabase.from('lotes').update({ etiqueta_impressa: true }).eq('id', loteId)
              window.print()
            }}
            icon={
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
              </svg>
            }
          >
            Imprimir etiqueta
          </Button>
        </div>
      </div>

      {/* Print-only: label rendered directly at root level */}
      <div className="etiqueta-print-target">
        <LabelContent lote={lote} empresa={empresa} />
      </div>
    </>
  )
}

// ── Print CSS ────────────────────────────────────────────────

const printStyles = `
  .etiqueta-print-target { display: none; }

  @page { size: 100mm 75mm; margin: 0; }

  @media print {
    /* Reset global */
    html, body { margin: 0 !important; padding: 0 !important; }

    /* Hide everything: sidebar, header, screen UI */
    body > * { visibility: hidden; }

    /* Show only the print target */
    .etiqueta-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0;
      left: 0;
    }
    .etiqueta-print-target * { visibility: visible !important; }

    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

// ── Label content (used in both preview and print) ───────────

function LabelContent({ lote, empresa }: { lote: LoteWithInsumo; empresa: Empresa | null }) {
  const marcaForn = [
    (lote.marca as unknown as { nome: string } | null)?.nome,
    (lote.fornecedor as unknown as { nome: string } | null)?.nome,
  ].filter(Boolean).join(' - ')

  const responsavel = (lote.recebido_usuario as unknown as { nome: string } | null)?.nome ?? ''
  const cnpj = empresa?.cnpj ?? ''
  const endereco = [empresa?.endereco, empresa?.cidade, empresa?.estado].filter(Boolean).join(', ')
  const empresaNome = empresa?.nome ?? "Unno"
  const shelfLife = (lote.insumo as unknown as { shelf_life_dias_pos_abertura?: number })?.shelf_life_dias_pos_abertura
  const qrContent = [lote.codigo, lote.data_recebimento, lote.numero_nf ?? ''].filter(Boolean).join('|')

  return (
    <div style={{
      width: '100mm',
      height: '75mm',
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
          {empresaNome}
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

        {/* Lado esquerdo — campos */}
        <div style={{
          flex: '0 0 62mm',
          padding: '2.5mm 3mm',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRight: '1pt solid #000',
        }}>
          <Field label="RECEBIMENTO:" value={formatDate(lote.data_recebimento)} />
          <Field label="VALIDADE ORIGINAL:" value={formatDate(lote.validade_original)} />
          <Field label="MANIPULAÇÃO:" value={formatDateTime(lote.created_at)} />
          <Field label="VALIDADE:" value={formatDate(lote.validade_pos_abertura)} bold />
          <Field label="APÓS ABERTURA:" value={shelfLife != null ? `${shelfLife} DIAS` : '—'} />
          <Field label="MARCA/FORN.:" value={marcaForn || '—'} />
        </div>

        {/* Lado direito — lote + NF + QR */}
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
            <QRCodeSVG value={qrContent} size={90} level="M" includeMargin={false} />
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
            <span style={{ fontWeight: 'bold' }}>{responsavel}</span>
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm' }}>
            <span style={{ fontWeight: 'bold' }}>CNPJ: </span>{cnpj}
          </div>
          <div style={{ fontSize: '6.5pt', marginTop: '0.5mm', maxWidth: '70mm', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            <span style={{ fontWeight: 'bold' }}>END.: </span>{endereco}
          </div>
        </div>
        <div style={{ fontSize: '6pt', color: '#6b7280', whiteSpace: 'nowrap' }}>
          #{lote.codigo}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ fontSize: '7.5pt', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span style={{ fontWeight: 'bold' }}>{label} </span>
      <span style={{ fontWeight: bold ? 'bold' : 'normal' }}>{value}</span>
    </div>
  )
}

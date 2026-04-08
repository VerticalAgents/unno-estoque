import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '../../components/ui/Button'
import type { Local, Insumo } from '../../types/database.types'
import { formatDate } from '../../lib/utils'

const SUBTIPO_LABELS: Record<string, string> = {
  balde: 'Balde',
  balde_fornecedor: 'Balde do fornecedor',
  caixa_plastica: 'Caixa plástica',
  garrafa: 'Garrafa',
  garrafa_fornecedor: 'Garrafa do fornecedor',
  saco_confeitar: 'Saco de confeitar',
  lata: 'Lata',
  prateleira: 'Prateleira',
}

type RecipienteComInsumo = Local & { insumo?: Insumo }

export function EtiquetaRecipientePage() {
  const { id } = useParams<{ id: string }>()
  const [recipiente, setRecipiente] = useState<RecipienteComInsumo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    supabase
      .from('locais')
      .select('*, insumo:insumos(id, nome, codigo, unidade_medida)')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        setRecipiente(data as RecipienteComInsumo)
        setLoading(false)
      })
  }, [id])

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!recipiente) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Recipiente não encontrado.</p>
      <Link to="/recipientes" className="text-brand-600 text-sm mt-2 inline-block">← Voltar</Link>
    </div>
  )

  return (
    <>
      {/* Screen UI */}
      <div className="print:hidden p-4 sm:p-6 max-w-lg mx-auto">
        <div className="mb-6">
          <Link to="/recipientes" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Recipientes
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Etiqueta do Recipiente</h1>
          <p className="text-sm text-gray-500 mt-0.5">Pré-visualização antes de imprimir</p>
        </div>

        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-4 mb-6">
          <LabelContent recipiente={recipiente} />
        </div>

        <Button
          size="lg"
          fullWidth
          onClick={() => window.print()}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
            </svg>
          }
        >
          Imprimir etiqueta
        </Button>
      </div>

      {/* Print layout */}
      <div className="hidden print-label">
        <style>{`
          @page {
            size: 100mm 75mm;
            margin: 3mm;
          }
          @media print {
            html, body { margin: 0; padding: 0; width: 100mm; height: 75mm; overflow: hidden; }
            .screen-only { display: none !important; }
            .print-label { display: block !important; width: 100mm; height: 75mm; position: absolute; top: 0; left: 0; }
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        `}</style>
        <LabelContent recipiente={recipiente} forPrint />
      </div>
    </>
  )
}

function LabelContent({ recipiente, forPrint = false }: { recipiente: RecipienteComInsumo; forPrint?: boolean }) {
  const qr = recipiente.qr_code_fixo ?? recipiente.id
  const size = forPrint ? 90 : 90

  return (
    <div className={`font-sans ${forPrint ? 'text-[9pt]' : 'text-sm'}`} style={{ width: forPrint ? '94mm' : '100%' }}>

      {/* Badge de identificação — diferencia visualmente da etiqueta de lote */}
      <div className="flex items-center justify-between mb-2">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold uppercase tracking-widest ${
          forPrint ? 'text-[7pt] border border-gray-800' : 'text-xs border border-gray-700 bg-gray-100'
        }`}>
          <svg className={forPrint ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
          </svg>
          Recipiente EP
        </span>
        <span className="font-mono text-gray-400" style={{ fontSize: forPrint ? '7pt' : '10px' }}>
          Unno
        </span>
      </div>

      {/* Nome do recipiente */}
      <div className="mb-2 pb-1.5 border-b-2 border-gray-800">
        <p className={`font-extrabold leading-tight ${forPrint ? 'text-[14pt]' : 'text-lg'}`}>
          {recipiente.nome}
        </p>
        <p className={`text-gray-500 ${forPrint ? 'text-[8pt]' : 'text-xs'}`}>
          {SUBTIPO_LABELS[recipiente.subtipo ?? ''] ?? recipiente.subtipo ?? '—'}
        </p>
      </div>

      {/* QR + dados */}
      <div className="flex gap-4 items-start">
        <div className="shrink-0 flex flex-col items-center">
          <QRCodeSVG
            value={qr}
            size={size}
            level="M"
            includeMargin={false}
          />
          <p className="font-mono text-center mt-1 text-gray-600" style={{ fontSize: forPrint ? '6.5pt' : '9px' }}>
            {qr}
          </p>
        </div>

        <div className="flex-1 space-y-1.5">
          {recipiente.insumo && (
            <InfoRow
              label="Insumo"
              value={recipiente.insumo.nome}
              highlight
              forPrint={forPrint}
            />
          )}
          {recipiente.capacidade_max != null && (
            <InfoRow
              label="Capacidade"
              value={`${recipiente.capacidade_max} ${recipiente.unidade_capacidade ?? ''}`}
              forPrint={forPrint}
            />
          )}
          <InfoRow
            label="Cadastrado"
            value={formatDate(recipiente.created_at)}
            forPrint={forPrint}
          />
          {recipiente.observacoes && (
            <InfoRow
              label="Obs"
              value={recipiente.observacoes}
              forPrint={forPrint}
            />
          )}
          <div className="pt-1">
            <span className={`inline-block px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-gray-500 font-mono ${
              forPrint ? 'text-[6.5pt]' : 'text-[9px]'
            }`}>
              USO INTERNO · NÃO É ETIQUETA DE LOTE
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, highlight, forPrint }: {
  label: string
  value: string
  highlight?: boolean
  forPrint?: boolean
}) {
  return (
    <div>
      <span className={`uppercase tracking-wide text-gray-400 ${forPrint ? 'text-[7pt]' : 'text-[9px]'}`}>
        {label}:{' '}
      </span>
      <span className={`font-medium ${highlight ? 'text-gray-900 font-bold' : 'text-gray-700'} ${forPrint ? 'text-[9pt]' : 'text-xs'}`}>
        {value}
      </span>
    </div>
  )
}

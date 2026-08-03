import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Empresa } from '../../types/database.types'
import { Button } from '../../components/ui/Button'
import { EtiquetaLoteContent, type LoteEtiqueta } from '../../components/etiqueta/EtiquetaLote'
import {
  EtiquetaCanvas,
  EtiquetaLinhaRolo,
  etiquetaPrintStyles,
  useEtiquetaConfig,
} from '../../lib/etiquetas'

export function ImpressaoEtiquetaPage() {
  const { loteId } = useParams<{ loteId: string }>()
  const { profile } = useAuth()
  const { config } = useEtiquetaConfig('lote')
  const [lote, setLote] = useState<LoteEtiqueta | null>(null)
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
      setLote(l.data as unknown as LoteEtiqueta)
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
      <style>{etiquetaPrintStyles(config)}</style>

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
          <p className="text-sm text-gray-500 mt-0.5">
            Pré-visualização antes de imprimir · etiqueta {config.largura}×{config.altura}mm
          </p>
        </div>

        {/* Preview */}
        <div className="flex justify-center mb-6">
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-3 inline-block">
            <EtiquetaCanvas dims={config}>
              <EtiquetaLoteContent lote={lote} empresa={empresa} dims={config} />
            </EtiquetaCanvas>
          </div>
        </div>

        {config.colunas > 1 && (
          <p className="text-xs text-gray-500 mb-4 -mt-2 text-center">
            Seu rolo tem {config.colunas} colunas. Uma etiqueta sozinha sai na primeira
            coluna e as outras {config.colunas - 1} saem em branco — o papel avança a
            linha inteira. Para aproveitar, imprima os lotes em conjunto pela lista de
            recebimento.
          </p>
        )}

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

      {/* Print-only: uma linha do rolo, com a etiqueta na primeira coluna */}
      <div className="etiqueta-print-target">
        <EtiquetaLinhaRolo config={config}>
          <EtiquetaCanvas dims={config}>
            <EtiquetaLoteContent lote={lote} empresa={empresa} dims={config} />
          </EtiquetaCanvas>
        </EtiquetaLinhaRolo>
      </div>
    </>
  )
}

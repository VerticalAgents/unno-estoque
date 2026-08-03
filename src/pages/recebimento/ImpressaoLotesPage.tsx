import { useEffect, useState } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Empresa } from '../../types/database.types'
import { Button } from '../../components/ui/Button'
import { EtiquetaLoteContent, type LoteEtiqueta } from '../../components/etiqueta/EtiquetaLote'
import {
  EtiquetaCanvas,
  EtiquetaFolhaImpressao,
  EtiquetaLinhaRolo,
  emLinhas,
  etiquetaPrintStyles,
  useEtiquetaConfig,
} from '../../lib/etiquetas'

type RouterLote = { lote_id: string; codigo: string; qr_code: string; quantidade: number }

export function ImpressaoLotesPage() {
  const location = useLocation()
  const { profile } = useAuth()
  const { config } = useEtiquetaConfig('lote')
  const routerLotes: RouterLote[] = (location.state as { lotes?: RouterLote[] })?.lotes ?? []
  const [lotes, setLotes] = useState<LoteEtiqueta[]>([])
  const [empresa, setEmpresa] = useState<Empresa | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!routerLotes.length || !profile) { setLoading(false); return }
    const ids = routerLotes.map(l => l.lote_id)
    Promise.all([
      supabase
        .from('lotes')
        .select('*, insumo:insumos(nome, codigo, unidade_medida, shelf_life_dias_pos_abertura), fornecedor:fornecedores(nome), marca:marcas(nome), recebido_usuario:usuarios!lotes_recebido_por_fkey(nome)')
        .in('id', ids),
      supabase.from('empresas').select('*').eq('id', profile.empresa_id).single(),
    ]).then(([l, e]) => {
      const sorted = ids.map(id => (l.data ?? []).find((x: { id: string }) => x.id === id)).filter(Boolean) as LoteEtiqueta[]
      setLotes(sorted)
      setEmpresa(e.data as Empresa)
      setLoading(false)
    })
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!routerLotes.length || !lotes.length) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Nenhuma etiqueta para exibir.</p>
      <Link to="/recebimento" className="text-brand-600 text-sm mt-2 inline-block">← Recebimento</Link>
    </div>
  )

  // O rolo anda de linha inteira: as etiquetas são agrupadas de `colunas` em
  // `colunas`, e cada grupo desses é uma página para o navegador.
  const linhas = emLinhas(lotes, config.colunas)

  return (
    <>
      <style>{etiquetaPrintStyles(config)}</style>

      {/* Screen UI */}
      <div className="etiqueta-screen-ui p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="mb-6">
          <Link to="/recebimento" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Recebimento
          </Link>
          <h1 className="text-xl font-bold text-gray-900">
            {lotes.length} etiqueta{lotes.length > 1 ? 's' : ''} gerada{lotes.length > 1 ? 's' : ''}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {lotes[0]?.insumo.nome} · etiqueta {config.largura}×{config.altura}mm
            {config.colunas > 1 && ` · ${linhas.length} linha${linhas.length > 1 ? 's' : ''} do rolo`}
          </p>
        </div>

        {/* Preview — cada bloco é uma linha do rolo, como vai sair no papel */}
        <div className="space-y-4 mb-6 overflow-x-auto">
          {linhas.map((linha, i) => (
            <div key={i} className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-3 inline-block">
              <p className="text-xs font-medium text-gray-400 mb-2">
                {config.colunas > 1
                  ? `Linha ${i + 1} de ${linhas.length}`
                  : `Etiqueta ${i + 1} de ${linhas.length}`}
              </p>
              <EtiquetaLinhaRolo config={config}>
                {linha.map(lote => (
                  <EtiquetaCanvas key={lote.id} dims={config}>
                    <EtiquetaLoteContent lote={lote} empresa={empresa} dims={config} />
                  </EtiquetaCanvas>
                ))}
              </EtiquetaLinhaRolo>
            </div>
          ))}
        </div>

        {config.colunas > 1 && lotes.length % config.colunas !== 0 && (
          <p className="text-xs text-gray-500 mb-4 -mt-2">
            A última linha tem {config.colunas - (lotes.length % config.colunas)} etiqueta(s)
            em branco — o rolo avança a linha inteira mesmo assim.
          </p>
        )}

        <div className="flex gap-3">
          <Link to="/recebimento/novo">
            <Button variant="secondary" size="lg">Novo lote</Button>
          </Link>
          <Button
            size="lg"
            fullWidth
            onClick={async () => {
              const ids = lotes.map(l => l.id)
              await supabase.from('lotes').update({ etiqueta_impressa: true }).in('id', ids)
              window.print()
            }}
            icon={
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
              </svg>
            }
          >
            Imprimir todas ({lotes.length})
          </Button>
        </div>
      </div>

      {/* Print target — uma página por linha do rolo */}
      <EtiquetaFolhaImpressao>
        {linhas.map((linha, i) => (
          <div key={i} className={i < linhas.length - 1 ? 'etiqueta-page-break' : ''}>
            <EtiquetaLinhaRolo config={config}>
              {linha.map(lote => (
                <EtiquetaCanvas key={lote.id} dims={config}>
                  <EtiquetaLoteContent lote={lote} empresa={empresa} dims={config} />
                </EtiquetaCanvas>
              ))}
            </EtiquetaLinhaRolo>
          </div>
        ))}
      </EtiquetaFolhaImpressao>
    </>
  )
}

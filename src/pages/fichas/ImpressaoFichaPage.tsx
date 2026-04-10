import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { formatDate } from '../../lib/utils'
import type { UnidadeMedida, Empresa } from '../../types/database.types'

interface ItemRow {
  id: string
  quantidade: number
  unidade: UnidadeMedida
  observacoes: string | null
  insumo: { nome: string; codigo: string; unidade_medida: UnidadeMedida }
}

interface VersaoRow {
  id: string
  versao: number
  ativa: boolean
  notas_alteracao: string
  rendimento_fornada: number | null
  peso_medio_g: number | null
  created_at: string
  criado_por_usuario: { nome: string } | null
  itens: ItemRow[]
}

interface FichaRow {
  id: string
  codigo: string
  nome: string
  descricao: string | null
  versao_atual: number
  tipo: 'produto' | 'insumo'
  insumo_resultado?: { nome: string; codigo: string } | null
  created_at: string
  versoes: VersaoRow[]
}

export function ImpressaoFichaPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const [ficha, setFicha] = useState<FichaRow | null>(null)
  const [empresa, setEmpresa] = useState<Empresa | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id || !profile) return
    Promise.all([
      supabase
        .from('fichas_tecnicas')
        .select(`
          *,
          insumo_resultado:insumos!fichas_tecnicas_insumo_resultado_id_fkey(nome, codigo),
          versoes:fichas_tecnicas_versoes(
            *,
            criado_por_usuario:usuarios!fichas_tecnicas_versoes_criado_por_fkey(nome),
            itens:fichas_tecnicas_itens(*, insumo:insumos(nome, codigo, unidade_medida))
          )
        `)
        .eq('id', id)
        .single(),
      supabase.from('empresas').select('*').eq('id', profile.empresa_id).single(),
    ]).then(([{ data: f }, { data: e }]) => {
      if (f) {
        const ficha = f as unknown as FichaRow
        ficha.versoes = (ficha.versoes ?? []).sort((a, b) => b.versao - a.versao)
        setFicha(ficha)
      }
      setEmpresa(e as Empresa)
      setLoading(false)
    })
  }, [id, profile])

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!ficha) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Ficha não encontrada.</p>
      <Link to="/fichas" className="text-brand-600 text-sm mt-2 inline-block">Voltar</Link>
    </div>
  )

  const versaoAtiva = ficha.versoes.find(v => v.ativa)
  const itens = [...(versaoAtiva?.itens ?? [])].sort((a, b) => {
    const toG = (q: number, u: string) => u === 'kg' || u === 'L' ? q * 1000 : q
    return toG(b.quantidade, b.unidade) - toG(a.quantidade, a.unidade)
  })
  const empresaNome = empresa?.nome ?? 'Unno'
  const tipo = ficha.tipo ?? 'produto'

  return (
    <>
      <style>{printStyles}</style>

      {/* Screen UI */}
      <div className="ft-screen-ui p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="mb-4">
          <Link to={`/fichas/${id}`} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Voltar para ficha
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Imprimir Ficha Técnica</h1>
          <p className="text-sm text-gray-500 mt-0.5">Pré-visualização antes de imprimir</p>
        </div>

        {/* Preview */}
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 mb-6">
          <FichaDocument ficha={ficha} versao={versaoAtiva} itens={itens} empresa={empresaNome} tipo={tipo} />
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
          Imprimir / Salvar PDF
        </Button>
      </div>

      {/* Print target */}
      <div className="ft-print-target">
        <FichaDocument ficha={ficha} versao={versaoAtiva} itens={itens} empresa={empresaNome} tipo={tipo} />
      </div>
    </>
  )
}

// ── Print CSS ────────────────────────────────────────────────

const printStyles = `
  .ft-print-target { display: none; }

  @page { size: A4; margin: 15mm; }

  @media print {
    html, body { margin: 0 !important; padding: 0 !important; }
    body > * { visibility: hidden; }
    .ft-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
    }
    .ft-print-target * { visibility: visible !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

// ── Document layout ──────────────────────────────────────────

function FichaDocument({
  ficha, versao, itens, empresa, tipo,
}: {
  ficha: FichaRow
  versao: VersaoRow | undefined
  itens: ItemRow[]
  empresa: string
  tipo: string
}) {
  const responsavel = versao?.criado_por_usuario
    ? (versao.criado_por_usuario as { nome: string }).nome
    : '—'

  return (
    <div style={{ fontFamily: 'sans-serif', fontSize: '10pt', color: '#111' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6mm', borderBottom: '2pt solid #111', paddingBottom: '4mm' }}>
        <div>
          <div style={{ fontSize: '18pt', fontWeight: 'bold' }}>Ficha Técnica</div>
          <div style={{ fontSize: '9pt', color: '#666', marginTop: '1mm' }}>{empresa}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '12pt', fontWeight: 'bold' }}>{ficha.codigo}</div>
          <div style={{ fontSize: '9pt', color: '#666' }}>
            Versão {ficha.versao_atual} · {tipo === 'insumo' ? 'Insumo' : 'Produto'}
          </div>
        </div>
      </div>

      {/* Info */}
      <div style={{ marginBottom: '5mm' }}>
        <div style={{ fontSize: '14pt', fontWeight: 'bold', marginBottom: '2mm' }}>{ficha.nome}</div>
        {ficha.descricao && (
          <div style={{ fontSize: '9pt', color: '#444', marginBottom: '2mm' }}>{ficha.descricao}</div>
        )}
        {tipo === 'insumo' && ficha.insumo_resultado && (
          <div style={{ fontSize: '10pt', color: '#00855a', fontWeight: '600', marginBottom: '2mm' }}>
            Produz: {(ficha.insumo_resultado as { nome: string }).nome}
          </div>
        )}
      </div>

      {/* Rendimento */}
      <div style={{ display: 'flex', gap: '8mm', marginBottom: '5mm', padding: '3mm 4mm', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
        <div>
          <span style={{ fontSize: '8pt', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Rendimento por fornada</span>
          <div style={{ fontSize: '14pt', fontWeight: 'bold' }}>{versao?.rendimento_fornada ?? '—'}</div>
        </div>
        {tipo === 'produto' && versao?.peso_medio_g && (
          <div>
            <span style={{ fontSize: '8pt', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Peso médio</span>
            <div style={{ fontSize: '14pt', fontWeight: 'bold' }}>{versao.peso_medio_g}g</div>
          </div>
        )}
      </div>

      {/* Ingredients table */}
      <div style={{ marginBottom: '5mm' }}>
        <div style={{ fontSize: '9pt', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#666', marginBottom: '2mm' }}>
          Ingredientes ({itens.length})
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9pt' }}>
          <thead>
            <tr style={{ borderBottom: '1.5pt solid #111' }}>
              <th style={{ textAlign: 'left', padding: '2mm 3mm', fontWeight: '600' }}>#</th>
              <th style={{ textAlign: 'left', padding: '2mm 3mm', fontWeight: '600' }}>Código</th>
              <th style={{ textAlign: 'left', padding: '2mm 3mm', fontWeight: '600' }}>Insumo</th>
              <th style={{ textAlign: 'right', padding: '2mm 3mm', fontWeight: '600' }}>Quantidade</th>
              <th style={{ textAlign: 'left', padding: '2mm 3mm', fontWeight: '600' }}>Unidade</th>
              <th style={{ textAlign: 'left', padding: '2mm 3mm', fontWeight: '600' }}>Obs.</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((item, idx) => (
              <tr key={item.id} style={{ borderBottom: '0.5pt solid #ddd' }}>
                <td style={{ padding: '2mm 3mm', color: '#999' }}>{idx + 1}</td>
                <td style={{ padding: '2mm 3mm', fontFamily: 'monospace', fontSize: '8pt' }}>{item.insumo.codigo}</td>
                <td style={{ padding: '2mm 3mm', fontWeight: '500' }}>{item.insumo.nome}</td>
                <td style={{ padding: '2mm 3mm', textAlign: 'right', fontWeight: '600' }}>{item.quantidade}</td>
                <td style={{ padding: '2mm 3mm' }}>{item.unidade}</td>
                <td style={{ padding: '2mm 3mm', color: '#666', fontSize: '8pt' }}>{item.observacoes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1pt solid #ccc', paddingTop: '3mm', marginTop: '8mm', display: 'flex', justifyContent: 'space-between', fontSize: '8pt', color: '#999' }}>
        <div>
          Versão {ficha.versao_atual} · Criada em {formatDate(versao?.created_at ?? ficha.created_at)}
          {responsavel !== '—' && ` · por ${responsavel}`}
        </div>
        <div>{empresa} · {ficha.codigo}</div>
      </div>

      {/* Version notes */}
      {versao?.notas_alteracao && (
        <div style={{ marginTop: '3mm', fontSize: '8pt', color: '#888', fontStyle: 'italic' }}>
          Notas: {versao.notas_alteracao}
        </div>
      )}
    </div>
  )
}

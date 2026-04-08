import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import type { UnidadeMedida, InsumoNutrientes } from '../../types/database.types'

interface ItemRow {
  id: string
  quantidade: number
  unidade: UnidadeMedida
  insumo: {
    id: string
    nome: string
    codigo: string
    unidade_medida: UnidadeMedida
  }
}

interface VersaoRow {
  id: string
  versao: number
  ativa: boolean
  rendimento_fornada: number | null
  peso_medio_g: number | null
  itens: ItemRow[]
}

interface FichaRow {
  id: string
  codigo: string
  nome: string
  versao_atual: number
  tipo: 'produto' | 'insumo'
  versoes: VersaoRow[]
}

interface NutrientesCalc {
  energia_kcal: number
  carboidratos: number
  acucares_totais: number
  acucares_adicionados: number
  proteinas: number
  gorduras_totais: number
  gorduras_saturadas: number
  gorduras_trans: number
  fibras: number
  sodio_mg: number
}

// Valores diários de referência (ANVISA RDC 429/2020)
const VD = {
  energia_kcal: 2000,
  carboidratos: 300,
  acucares_adicionados: 50,
  proteinas: 50,
  gorduras_totais: 65,
  gorduras_saturadas: 22,
  fibras: 25,
  sodio_mg: 2000,
}

export function TabelaNutricionalPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const [ficha, setFicha] = useState<FichaRow | null>(null)
  const [nutrientesMap, setNutrientesMap] = useState<Record<string, InsumoNutrientes>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id || !profile) return

    supabase
      .from('fichas_tecnicas')
      .select(`
        id, codigo, nome, versao_atual, tipo,
        versoes:fichas_tecnicas_versoes(
          id, versao, ativa, rendimento_fornada, peso_medio_g,
          itens:fichas_tecnicas_itens(id, quantidade, unidade, insumo:insumos(id, nome, codigo, unidade_medida))
        )
      `)
      .eq('id', id)
      .single()
      .then(async ({ data }) => {
        if (!data) { setLoading(false); return }
        const f = data as unknown as FichaRow
        f.versoes = (f.versoes ?? []).sort((a, b) => b.versao - a.versao)
        setFicha(f)

        // Busca nutrientes de todos os insumos da versão ativa
        const versaoAtiva = f.versoes.find(v => v.ativa)
        const insumoIds = (versaoAtiva?.itens ?? []).map(it => it.insumo.id)

        if (insumoIds.length > 0) {
          const { data: nutri } = await supabase
            .from('insumos_nutrientes')
            .select('*')
            .in('insumo_id', insumoIds)

          const map: Record<string, InsumoNutrientes> = {}
          for (const n of (nutri ?? []) as InsumoNutrientes[]) {
            map[n.insumo_id] = n
          }
          setNutrientesMap(map)
        }

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
  const itens = versaoAtiva?.itens ?? []
  const rendimento = versaoAtiva?.rendimento_fornada ?? 1
  const pesoMedio = versaoAtiva?.peso_medio_g ?? 100

  // Calcula nutrientes totais por fornada e por porção
  const totalFornada: NutrientesCalc = {
    energia_kcal: 0, carboidratos: 0, acucares_totais: 0, acucares_adicionados: 0,
    proteinas: 0, gorduras_totais: 0, gorduras_saturadas: 0, gorduras_trans: 0,
    fibras: 0, sodio_mg: 0,
  }

  for (const item of itens) {
    const nutri = nutrientesMap[item.insumo.id]
    if (!nutri) continue

    // Quantidade em gramas (converter se necessário)
    let qtdG = item.quantidade
    if (item.unidade === 'kg') qtdG *= 1000
    if (item.unidade === 'ml' || item.unidade === 'L') {
      if (item.unidade === 'L') qtdG *= 1000
      // ml ≈ g para a maioria dos líquidos
    }

    // Proporcional: nutrientes por 100g × (qtd_g / 100)
    const fator = qtdG / 100

    totalFornada.energia_kcal += nutri.energia_kcal * fator
    totalFornada.carboidratos += nutri.carboidratos * fator
    totalFornada.acucares_totais += nutri.acucares_totais * fator
    totalFornada.acucares_adicionados += nutri.acucares_adicionados * fator
    totalFornada.proteinas += nutri.proteinas * fator
    totalFornada.gorduras_totais += nutri.gorduras_totais * fator
    totalFornada.gorduras_saturadas += nutri.gorduras_saturadas * fator
    totalFornada.gorduras_trans += nutri.gorduras_trans * fator
    totalFornada.fibras += nutri.fibras * fator
    totalFornada.sodio_mg += nutri.sodio_mg * fator
  }

  // Peso total da fornada (g)
  const pesoTotalFornada = rendimento * pesoMedio

  // Nutrientes por 100g do produto final
  const per100g: NutrientesCalc = {} as NutrientesCalc
  for (const key of Object.keys(totalFornada) as (keyof NutrientesCalc)[]) {
    per100g[key] = pesoTotalFornada > 0 ? (totalFornada[key] / pesoTotalFornada) * 100 : 0
  }

  // Nutrientes por porção (1 unidade = pesoMedio gramas)
  const perPorcao: NutrientesCalc = {} as NutrientesCalc
  for (const key of Object.keys(totalFornada) as (keyof NutrientesCalc)[]) {
    perPorcao[key] = pesoTotalFornada > 0 ? (totalFornada[key] / pesoTotalFornada) * pesoMedio : 0
  }

  const insumosSemNutrientes = itens.filter(it => !nutrientesMap[it.insumo.id])

  return (
    <>
      <style>{printStyles}</style>

      <div className="tn-screen-ui p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="mb-4">
          <Link to={`/fichas/${id}`} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Voltar para ficha
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Tabela Nutricional</h1>
          <p className="text-sm text-gray-500 mt-0.5">{ficha.nome} · v{ficha.versao_atual}</p>
        </div>

        {insumosSemNutrientes.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
            <strong>{insumosSemNutrientes.length} insumo{insumosSemNutrientes.length > 1 ? 's' : ''} sem dados nutricionais:</strong>{' '}
            {insumosSemNutrientes.map(it => it.insumo.nome).join(', ')}
          </div>
        )}

        {/* Preview */}
        <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 mb-6">
          <TabelaDocument ficha={ficha} per100g={per100g} perPorcao={perPorcao} pesoMedio={pesoMedio} />
        </div>

        <Button size="lg" fullWidth onClick={() => window.print()}
          icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" /></svg>}
        >
          Imprimir / Salvar PDF
        </Button>
      </div>

      <div className="tn-print-target">
        <TabelaDocument ficha={ficha} per100g={per100g} perPorcao={perPorcao} pesoMedio={pesoMedio} />
      </div>
    </>
  )
}

const printStyles = `
  .tn-print-target { display: none; }
  @page { size: A4; margin: 20mm; }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; }
    body > * { visibility: hidden; }
    .tn-print-target {
      display: block !important;
      visibility: visible !important;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
    }
    .tn-print-target * { visibility: visible !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`

function TabelaDocument({
  ficha, per100g, perPorcao, pesoMedio,
}: {
  ficha: FichaRow
  per100g: NutrientesCalc
  perPorcao: NutrientesCalc
  pesoMedio: number
}) {
  function vd(nutrient: keyof typeof VD, value: number): string {
    const ref = VD[nutrient]
    if (!ref) return '—'
    return Math.round((value / ref) * 100) + '%'
  }

  function fmt(v: number, decimals = 1): string {
    return v.toFixed(decimals)
  }

  const rows: { label: string; indent?: boolean; per100: string; perP: string; vdStr: string }[] = [
    { label: 'Valor energético (kcal)', per100: fmt(per100g.energia_kcal, 0), perP: fmt(perPorcao.energia_kcal, 0), vdStr: vd('energia_kcal', perPorcao.energia_kcal) },
    { label: 'Carboidratos totais (g)', per100: fmt(per100g.carboidratos), perP: fmt(perPorcao.carboidratos), vdStr: vd('carboidratos', perPorcao.carboidratos) },
    { label: 'Açúcares totais (g)', indent: true, per100: fmt(per100g.acucares_totais), perP: fmt(perPorcao.acucares_totais), vdStr: '—' },
    { label: 'Açúcares adicionados (g)', indent: true, per100: fmt(per100g.acucares_adicionados), perP: fmt(perPorcao.acucares_adicionados), vdStr: vd('acucares_adicionados', perPorcao.acucares_adicionados) },
    { label: 'Proteínas (g)', per100: fmt(per100g.proteinas), perP: fmt(perPorcao.proteinas), vdStr: vd('proteinas', perPorcao.proteinas) },
    { label: 'Gorduras totais (g)', per100: fmt(per100g.gorduras_totais), perP: fmt(perPorcao.gorduras_totais), vdStr: vd('gorduras_totais', perPorcao.gorduras_totais) },
    { label: 'Gorduras saturadas (g)', indent: true, per100: fmt(per100g.gorduras_saturadas), perP: fmt(perPorcao.gorduras_saturadas), vdStr: vd('gorduras_saturadas', perPorcao.gorduras_saturadas) },
    { label: 'Gorduras trans (g)', indent: true, per100: fmt(per100g.gorduras_trans), perP: fmt(perPorcao.gorduras_trans), vdStr: '—' },
    { label: 'Fibras alimentares (g)', per100: fmt(per100g.fibras), perP: fmt(perPorcao.fibras), vdStr: vd('fibras', perPorcao.fibras) },
    { label: 'Sódio (mg)', per100: fmt(per100g.sodio_mg), perP: fmt(perPorcao.sodio_mg), vdStr: vd('sodio_mg', perPorcao.sodio_mg) },
  ]

  // Alertas frontais (ANVISA RDC 429/2020)
  const alertas: string[] = []
  if (per100g.acucares_adicionados >= 15) alertas.push('ALTO EM AÇÚCARES ADICIONADOS')
  if (per100g.gorduras_saturadas >= 6) alertas.push('ALTO EM GORDURAS SATURADAS')
  if (per100g.sodio_mg >= 600) alertas.push('ALTO EM SÓDIO')

  return (
    <div style={{ fontFamily: 'sans-serif', fontSize: '10pt', color: '#111', maxWidth: '400px' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '4mm' }}>
        <div style={{ fontSize: '8pt', color: '#666' }}>{ficha.codigo} · {ficha.nome}</div>
      </div>

      {/* Tabela nutricional */}
      <div style={{ border: '2pt solid #111', padding: '3mm' }}>
        <div style={{ fontSize: '14pt', fontWeight: 'bold', borderBottom: '1pt solid #111', paddingBottom: '2mm', marginBottom: '2mm' }}>
          INFORMAÇÃO NUTRICIONAL
        </div>
        <div style={{ fontSize: '8pt', marginBottom: '2mm' }}>
          Porções por embalagem: 1
        </div>
        <div style={{ fontSize: '8pt', marginBottom: '3mm', borderBottom: '1pt solid #111', paddingBottom: '2mm' }}>
          Porção: {pesoMedio}g (1 unidade)
        </div>

        {/* Table header */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8.5pt' }}>
          <thead>
            <tr style={{ borderBottom: '1pt solid #111' }}>
              <th style={{ textAlign: 'left', padding: '1.5mm 0', fontWeight: '600' }}></th>
              <th style={{ textAlign: 'right', padding: '1.5mm 2mm', fontWeight: '600' }}>100g</th>
              <th style={{ textAlign: 'right', padding: '1.5mm 2mm', fontWeight: '600' }}>{pesoMedio}g</th>
              <th style={{ textAlign: 'right', padding: '1.5mm 0', fontWeight: '600' }}>%VD*</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '0.5pt solid #ddd' }}>
                <td style={{ padding: '1.5mm 0', paddingLeft: row.indent ? '4mm' : 0, fontWeight: row.indent ? 'normal' : '500' }}>
                  {row.label}
                </td>
                <td style={{ textAlign: 'right', padding: '1.5mm 2mm' }}>{row.per100}</td>
                <td style={{ textAlign: 'right', padding: '1.5mm 2mm' }}>{row.perP}</td>
                <td style={{ textAlign: 'right', padding: '1.5mm 0' }}>{row.vdStr}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ fontSize: '7pt', color: '#666', marginTop: '2mm', borderTop: '1pt solid #111', paddingTop: '2mm' }}>
          *Percentual de valores diários fornecidos pela porção.
        </div>
      </div>

      {/* Alertas frontais ANVISA */}
      {alertas.length > 0 && (
        <div style={{ marginTop: '3mm', display: 'flex', gap: '2mm', flexWrap: 'wrap' }}>
          {alertas.map((a, i) => (
            <div key={i} style={{
              backgroundColor: '#111',
              color: '#fff',
              fontSize: '7pt',
              fontWeight: 'bold',
              padding: '2mm 3mm',
              borderRadius: '2px',
            }}>
              {a}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

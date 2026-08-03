/**
 * ARQUIVO TEMPORÁRIO DE TESTE — não faz parte do app.
 *
 * Renderiza uma linha do rolo (3 colunas de 34x65mm) com o componente real
 * de etiqueta de lote, para conferir o desenho sem precisar imprimir.
 * Aberto em /etiqueta-preview.html com o `vite` rodando.
 */
import { createRoot } from 'react-dom/client'
import { EtiquetaLoteContent, type LoteEtiqueta } from './components/etiqueta/EtiquetaLote'
import { EtiquetaCanvas, EtiquetaLinhaRolo, saneiaConfig } from './lib/etiquetas'
import type { Empresa } from './types/database.types'

const config = saneiaConfig({ largura: 34, altura: 65, colunas: 3, espaco: 2.5, margem: 2 })

const empresa = {
  nome: 'Mischa Brownies',
  cnpj: '12.345.678/0001-90',
  endereco: 'Rua das Acácias, 1200',
  cidade: 'Porto Alegre',
  estado: 'RS',
} as unknown as Empresa

function lote(n: number, nome: string, codigo: string): LoteEtiqueta {
  return {
    id: `id-${n}`,
    codigo,
    numero_nf: '004512',
    data_recebimento: '2026-08-01',
    validade_original: '2027-02-15',
    validade_pos_abertura: '2026-08-11',
    created_at: '2026-08-03T09:32:00-03:00',
    insumo: {
      nome,
      codigo: 'INS028',
      unidade_medida: 'kg',
      shelf_life_dias_pos_abertura: 10,
    },
    marca: { nome: 'Callebaut' },
    fornecedor: { nome: 'Distribuidora Sul' },
    recebido_usuario: { nome: 'Lucca Milleto' },
  } as unknown as LoteEtiqueta
}

const lotes = [
  lote(1, 'Chocolate meio amargo 53%', 'LT-2026-0801-001'),
  lote(2, 'Manteiga sem sal', 'LT-2026-0801-002'),
  lote(3, 'Creme de avelã com cacau Nutella balde 3kg', 'LT-2026-0801-003'),
]

// Caso extremo: nome comprido, marca comprida, lote comprido, sem NF.
const extremos: LoteEtiqueta[] = [
  {
    ...lote(4, 'Chocolate nobre ao leite 40% cacau em gotas saco 2,05kg premium', 'LT-2026-0801-0004-SUB-12'),
    numero_nf: null,
    marca: { nome: 'Callebaut Belgian Chocolate' },
    fornecedor: { nome: 'Distribuidora Sul Alimentos Ltda' },
    recebido_usuario: { nome: 'Maria Aparecida de Oliveira Santos' },
  } as unknown as LoteEtiqueta,
  lote(5, 'Ovo', 'LT-1'),
  lote(6, 'Farinha de trigo tipo 1 sem fermento', 'LT-2026-0801-006'),
]

/**
 * Cada etiqueta recebe uma borda vermelha desenhada por cima (absoluta, sem
 * empurrar nada) marcando o recorte real de 34x65mm — é onde dá para ver se
 * algum conteúdo encosta ou passa do papel.
 */
function Linha({ itens }: { itens: LoteEtiqueta[] }) {
  return (
    <div className="folha" style={{ display: 'inline-block', marginBottom: 12 }}>
      <EtiquetaLinhaRolo config={config}>
        {itens.map(l => (
          <div key={l.id} style={{ position: 'relative', flexShrink: 0 }}>
            <EtiquetaCanvas dims={config}>
              <EtiquetaLoteContent lote={l} empresa={empresa} dims={config} />
            </EtiquetaCanvas>
            <div style={{
              position: 'absolute',
              inset: 0,
              border: '1px solid #dc2626',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }} />
          </div>
        ))}
      </EtiquetaLinhaRolo>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <div>
    <Linha itens={lotes} />
    <Linha itens={extremos} />
  </div>,
)

import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { AbastecimentoUnidades, type CaixaInicial, type InsumoPorUnidade } from './AbastecimentoUnidades'

/**
 * Óleo e ovo pelo "Levar embalagem original" (migration 144): a caixa bipada
 * na tela de leitura chega aqui já na lista. Mesmo fluxo que o Reabastecer
 * usava por dentro.
 */
export function AbastecimentoUnidadesPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const { insumoId } = useParams()
  const [params] = useSearchParams()
  const loteId = params.get('lote')
  const [insumo, setInsumo] = useState<InsumoPorUnidade | null>(null)
  const [inicial, setInicial] = useState<CaixaInicial | undefined>(undefined)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile || !insumoId) return
    let vivo = true
    Promise.all([
      supabase.from('insumos').select('id, nome, codigo').eq('id', insumoId).eq('empresa_id', profile.empresa_id).maybeSingle(),
      supabase.from('insumos_embalagem_config').select('subunidade_tipo, subunidade_peso, tem_subunidades').eq('insumo_id', insumoId).maybeSingle(),
      loteId
        ? supabase.from('lotes').select('id, codigo, quantidade_disponivel, status').eq('id', loteId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]).then(([ins, emb, lote]) => {
      if (!vivo) return
      const i = ins.data as { id: string; nome: string; codigo: string } | null
      const e = emb.data as { subunidade_tipo: string | null; subunidade_peso: number | null; tem_subunidades: boolean } | null
      if (!i || !e?.tem_subunidades || !(Number(e.subunidade_peso) > 0)) {
        setErro('Este insumo não tem cadastrado quanto pesa cada unidade.')
        return
      }
      setInsumo({ insumo_id: i.id, nome: i.nome, codigo: i.codigo, tem: 0,
                  peso: Number(e.subunidade_peso), tipo: e.subunidade_tipo ?? 'unidade' })
      const l = lote.data as { id: string; codigo: string; quantidade_disponivel: number; status: string } | null
      if (l && l.status === 'ativo') setInicial({ id: l.id, codigo: l.codigo, quantidade_disponivel: Number(l.quantidade_disponivel) })
    })
    return () => { vivo = false }
  }, [profile, insumoId, loteId])

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-foreground">Levar para a produção</h1>
      </div>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
      {!erro && !insumo && (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {insumo && (
        <AbastecimentoUnidades
          insumo={insumo}
          inicial={inicial}
          onVoltar={() => navigate('/transferencia')}
          onConcluido={() => navigate('/transferencia')}
        />
      )}
    </div>
  )
}

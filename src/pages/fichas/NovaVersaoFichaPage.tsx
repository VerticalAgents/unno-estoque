import { useEffect, useState, type FormEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Insumo, UnidadeMedida } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

interface ItemForm {
  insumo_id: string
  quantidade: string
  unidade: UnidadeMedida
  observacoes: string
}

const UNIDADES: UnidadeMedida[] = ['kg', 'g', 'L', 'ml', 'unid']

export function NovaVersaoFichaPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [ficha, setFicha] = useState<{ nome: string; codigo: string; versao_atual: number } | null>(null)
  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notas, setNotas] = useState('')
  const [rendimentoFornada, setRendimentoFornada] = useState('')
  const [pesoMedioG, setPesoMedioG] = useState('')
  const [itens, setItens] = useState<ItemForm[]>([
    { insumo_id: '', quantidade: '', unidade: 'kg', observacoes: '' },
  ])

  useEffect(() => {
    if (!id || !profile) return
    Promise.all([
      supabase
        .from('fichas_tecnicas')
        .select('nome, codigo, versao_atual')
        .eq('id', id)
        .single(),
      supabase
        .from('insumos')
        .select('*')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true)
        .order('nome'),
    ]).then(([f, ins]) => {
      if (f.data) setFicha(f.data as typeof ficha)
      setInsumos((ins.data ?? []) as Insumo[])

      // Pre-fill itens from current active version
      supabase
        .from('fichas_tecnicas_versoes')
        .select('id, rendimento_fornada, peso_medio_g, fichas_tecnicas_itens(*)')
        .eq('ficha_id', id)
        .eq('ativa', true)
        .single()
        .then(({ data: vd }) => {
          const versaoData = vd as { id: string; rendimento_fornada: number | null; peso_medio_g: number | null; fichas_tecnicas_itens: { insumo_id: string; quantidade: number; unidade: UnidadeMedida; observacoes: string | null }[] } | null
          if (versaoData) {
            if (versaoData.rendimento_fornada) setRendimentoFornada(String(versaoData.rendimento_fornada))
            if (versaoData.peso_medio_g) setPesoMedioG(String(versaoData.peso_medio_g))
            if (versaoData.fichas_tecnicas_itens?.length) {
              setItens(
                versaoData.fichas_tecnicas_itens.map((it) => ({
                  insumo_id: it.insumo_id,
                  quantidade: String(it.quantidade),
                  unidade: it.unidade,
                  observacoes: it.observacoes ?? '',
                }))
              )
            }
          }
        })
    })
  }, [id, profile])

  function setItem(idx: number, field: keyof ItemForm, value: string) {
    setItens((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      if (field === 'insumo_id') {
        const ins = insumos.find((i) => i.id === value)
        if (ins) next[idx].unidade = ins.unidade_medida
      }
      return next
    })
  }

  function addItem() {
    setItens((prev) => [...prev, { insumo_id: '', quantidade: '', unidade: 'kg', observacoes: '' }])
  }

  function removeItem(idx: number) {
    if (itens.length <= 1) return
    setItens((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile || !id) return

    if (!notas.trim()) {
      setError('Descreva o que mudou nesta versão.')
      return
    }

    const itensValidos = itens.filter((it) => it.insumo_id && it.quantidade)
    if (itensValidos.length === 0) {
      setError('Adicione pelo menos um ingrediente.')
      return
    }

    const ids = itensValidos.map((it) => it.insumo_id)
    if (new Set(ids).size !== ids.length) {
      setError('Há ingredientes duplicados na lista.')
      return
    }

    setError('')
    setLoading(true)

    if (!rendimentoFornada || parseInt(rendimentoFornada) < 1) {
      setError('Rendimento por fornada é obrigatório.')
      setLoading(false)
      return
    }

    const { data, error: rpcError } = await supabase.rpc('criar_nova_versao_ficha', {
      p_ficha_id:           id,
      p_responsavel_id:     profile.id,
      p_notas:              notas,
      p_rendimento_fornada: parseInt(rendimentoFornada),
      p_peso_medio_g:       pesoMedioG ? parseFloat(pesoMedioG) : null,
      p_itens:              itensValidos.map((it) => ({
        insumo_id:   it.insumo_id,
        quantidade:  parseFloat(it.quantidade),
        unidade:     it.unidade,
        observacoes: it.observacoes || null,
      })),
    })

    setLoading(false)
    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao criar versão.')
      return
    }
    navigate(`/fichas/${id}/imprimir`)
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate(`/fichas/${id}`)}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Nova Versão da Receita</h1>
        {ficha && (
          <p className="text-sm text-gray-500 mt-0.5">
            {ficha.nome} · atualmente v{ficha.versao_atual}
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card className="p-5">
          <Textarea
            label="O que mudou nesta versão?"
            required
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            placeholder="Ex: Adicionado cacau black, ajuste no açúcar..."
            hint="Obrigatório — funciona como um commit message da receita."
          />
        </Card>

        {/* Rendimento */}
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Rendimento</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Unidades por fornada"
              required
              type="number" inputMode="decimal"
              min="1"
              step="1"
              value={rendimentoFornada}
              onChange={(e) => setRendimentoFornada(e.target.value)}
              placeholder="60"
              hint="Ex: 60 brownies por fornada"
            />
            <Input
              label="Peso médio por unidade (g)"
              type="number" inputMode="decimal"
              min="0.1"
              step="0.1"
              value={pesoMedioG}
              onChange={(e) => setPesoMedioG(e.target.value)}
              placeholder="65"
              hint="Opcional — controle de gramatura"
            />
          </div>
        </Card>

        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Ingredientes</h2>
            <p className="text-xs text-gray-400">Quantidade por fornada</p>
          </div>

          {itens.map((item, idx) => (
            <div key={idx} className="border border-gray-100 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">#{idx + 1}</span>
                {itens.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Remover
                  </button>
                )}
              </div>
              <Select
                label="Insumo"
                required
                value={item.insumo_id}
                onChange={(e) => setItem(idx, 'insumo_id', e.target.value)}
              >
                <option value="">Selecionar insumo...</option>
                {insumos.map((i) => (
                  <option key={i.id} value={i.id}>{i.codigo} — {i.nome}</option>
                ))}
              </Select>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Quantidade"
                  type="number" inputMode="decimal"
                  step="0.0001"
                  min="0.0001"
                  required
                  value={item.quantidade}
                  onChange={(e) => setItem(idx, 'quantidade', e.target.value)}
                  placeholder="0.000"
                />
                <Select
                  label="Unidade"
                  value={item.unidade}
                  onChange={(e) => setItem(idx, 'unidade', e.target.value)}
                >
                  {UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}
                </Select>
              </div>
              <Input
                label="Observações (opcional)"
                value={item.observacoes}
                onChange={(e) => setItem(idx, 'observacoes', e.target.value)}
              />
            </div>
          ))}

          <button
            type="button"
            onClick={addItem}
            className="w-full py-2 border-2 border-dashed border-gray-200 rounded-lg text-sm text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
          >
            + Adicionar ingrediente
          </button>
        </Card>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate(`/fichas/${id}`)}>
            Cancelar
          </Button>
          <Button type="submit" size="lg" fullWidth loading={loading}>
            Publicar Nova Versão
          </Button>
        </div>
      </form>
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
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

export function NovaFichaPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [tipo, setTipo] = useState<'produto' | 'insumo'>('produto')
  const [insumoResultadoId, setInsumoResultadoId] = useState('')

  const [form, setForm] = useState({
    codigo: '',
    nome: '',
    descricao: '',
    notas: 'Versão inicial da receita.',
    rendimento_fornada: '',
    peso_medio_g: '',
  })

  const [itens, setItens] = useState<ItemForm[]>([
    { insumo_id: '', quantidade: '', unidade: 'kg', observacoes: '' },
  ])

  useEffect(() => {
    if (!profile) return
    supabase
      .from('insumos')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .order('nome')
      .then(({ data }) => setInsumos((data ?? []) as Insumo[]))
  }, [profile])

  function setField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function setItem(idx: number, field: keyof ItemForm, value: string) {
    setItens((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      // Auto-fill unidade from insumo if insumo_id changes
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
    setItens((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return

    if (!form.codigo || !form.nome) {
      setError('Código e nome são obrigatórios.')
      return
    }

    if (!form.rendimento_fornada || parseInt(form.rendimento_fornada) < 1) {
      setError('Rendimento por fornada é obrigatório.')
      return
    }

    if (tipo === 'insumo' && !insumoResultadoId) {
      setError('Selecione qual insumo será produzido.')
      return
    }

    const itensValidos = itens.filter((it) => it.insumo_id && it.quantidade)
    if (itensValidos.length === 0) {
      setError('Adicione pelo menos um ingrediente.')
      return
    }

    // Check duplicate insumos
    const ids = itensValidos.map((it) => it.insumo_id)
    if (new Set(ids).size !== ids.length) {
      setError('Há ingredientes duplicados na lista.')
      return
    }

    setError('')
    setLoading(true)

    const { data, error: rpcError } = await supabase.rpc('criar_ficha_tecnica', {
      p_empresa_id:      profile.empresa_id,
      p_responsavel_id:  profile.id,
      p_codigo:          form.codigo.toUpperCase(),
      p_nome:            form.nome,
      p_descricao:       form.descricao || null,
      p_notas:           form.notas,
      p_rendimento_fornada: parseInt(form.rendimento_fornada),
      p_peso_medio_g:    form.peso_medio_g ? parseFloat(form.peso_medio_g) : null,
      p_tipo:            tipo,
      p_insumo_resultado_id: tipo === 'insumo' ? insumoResultadoId : null,
      p_itens:           itensValidos.map((it) => ({
        insumo_id:    it.insumo_id,
        quantidade:   parseFloat(it.quantidade),
        unidade:      it.unidade,
        observacoes:  it.observacoes || null,
      })),
    })

    setLoading(false)
    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao criar ficha.')
      return
    }

    const result = data as { ficha_id: string }
    navigate(`/fichas/${result.ficha_id}/imprimir`)
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/fichas')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Nova Ficha Técnica</h1>
        <p className="text-sm text-gray-500 mt-0.5">Receita com ingredientes e quantidades por unidade</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Tipo */}
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Tipo de Ficha</h2>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setTipo('produto')}
              className={['py-3 rounded-lg text-sm font-medium border-2 transition-colors',
                tipo === 'produto' ? 'bg-brand-50 border-brand-400 text-brand-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              ].join(' ')}>
              Produto Acabado
            </button>
            <button type="button" onClick={() => setTipo('insumo')}
              className={['py-3 rounded-lg text-sm font-medium border-2 transition-colors',
                tipo === 'insumo' ? 'bg-brand-50 border-brand-400 text-brand-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              ].join(' ')}>
              Insumo (Producao Propria)
            </button>
          </div>
          {tipo === 'insumo' && (
            <Select label="Insumo produzido" required value={insumoResultadoId} onChange={e => setInsumoResultadoId(e.target.value)}>
              <option value="">Selecione o insumo que sera produzido...</option>
              {insumos.map(ins => (
                <option key={ins.id} value={ins.id}>{ins.codigo} — {ins.nome} ({ins.unidade_medida})</option>
              ))}
            </Select>
          )}
        </Card>

        {/* Identificação */}
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Identificação</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Código"
              required
              value={form.codigo}
              onChange={(e) => setField('codigo', e.target.value)}
              placeholder="FT-001"
              hint="Ex: FT-001, FT-BR-CLASSICO"
            />
            <Input
              label="Nome do produto"
              required
              value={form.nome}
              onChange={(e) => setField('nome', e.target.value)}
              placeholder="Brownie Clássico 90g"
            />
          </div>
          <Textarea
            label="Descrição (opcional)"
            value={form.descricao}
            onChange={(e) => setField('descricao', e.target.value)}
            placeholder="Descrição do produto final..."
            rows={2}
          />
        </Card>

        {/* Rendimento */}
        <Card className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Rendimento</h2>
          <div className={tipo === 'produto' ? 'grid grid-cols-2 gap-4' : ''}>
            <Input
              label={tipo === 'produto' ? 'Unidades por fornada' : `Quantidade produzida por lote (${insumos.find(i => i.id === insumoResultadoId)?.unidade_medida ?? 'un'})`}
              required
              type="number" inputMode="decimal"
              min="1"
              step={tipo === 'insumo' ? '0.001' : '1'}
              value={form.rendimento_fornada}
              onChange={(e) => setField('rendimento_fornada', e.target.value)}
              placeholder={tipo === 'produto' ? '60' : '5'}
              hint={tipo === 'produto' ? 'Ex: 60 brownies por fornada' : 'Ex: 5 kg de doce de leite por lote'}
            />
            {tipo === 'produto' && (
              <Input
                label="Peso medio por unidade (g)"
                type="number" inputMode="decimal"
                min="0.1"
                step="0.1"
                value={form.peso_medio_g}
                onChange={(e) => setField('peso_medio_g', e.target.value)}
                placeholder="65"
                hint="Opcional — usado para controle de gramatura"
              />
            )}
          </div>
        </Card>

        {/* Ingredientes */}
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Ingredientes
            </h2>
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
                placeholder="Ex: peneirado, temperatura ambiente..."
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

        {/* Notas da versão */}
        <Card className="p-5">
          <Textarea
            label="Notas desta versão"
            required
            value={form.notas}
            onChange={(e) => setField('notas', e.target.value)}
            hint="Descreva o que define esta versão da receita (como um commit message)."
          />
        </Card>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/fichas')}>
            Cancelar
          </Button>
          <Button type="submit" size="lg" fullWidth loading={loading}>
            Criar Ficha Técnica
          </Button>
        </div>
      </form>
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Insumo, Fornecedor, Marca } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { today } from '../../lib/utils'

export function NovoLotePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [todosFornecedores, setTodosFornecedores] = useState<Fornecedor[]>([])
  const [fornecedoresFiltrados, setFornecedoresFiltrados] = useState<Fornecedor[]>([])
  const [marcasDisponiveis, setMarcasDisponiveis] = useState<Marca[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    insumo_id: '',
    fornecedor_id: '',
    marca_id: '',
    numero_nf: '',
    data_recebimento: today(),
    validade_original: '',
    quantidade_recebida: '',
    observacoes: '',
  })

  const [numEtiquetas, setNumEtiquetas] = useState(1)

  // Load selects base
  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase.from('insumos').select('*').eq('empresa_id', profile.empresa_id).eq('ativo', true).order('nome'),
      supabase.from('fornecedores').select('*').eq('empresa_id', profile.empresa_id).eq('ativo', true).order('nome'),
    ]).then(([ins, forn]) => {
      setInsumos((ins.data ?? []) as Insumo[])
      setTodosFornecedores((forn.data ?? []) as Fornecedor[])
    })
  }, [profile])

  // Quando muda o insumo: filtrar fornecedores e resetar fornecedor+marca
  useEffect(() => {
    if (!form.insumo_id) {
      setFornecedoresFiltrados(todosFornecedores)
      setMarcasDisponiveis([])
      setForm(prev => ({ ...prev, fornecedor_id: '', marca_id: '' }))
      return
    }

    supabase
      .from('fornecedores_insumos_marcas')
      .select('fornecedor_id')
      .eq('insumo_id', form.insumo_id)
      .then(({ data }) => {
        const ids = [...new Set((data ?? []).map((r: { fornecedor_id: string }) => r.fornecedor_id))]
        if (ids.length > 0) {
          setFornecedoresFiltrados(todosFornecedores.filter(f => ids.includes(f.id)))
        } else {
          setFornecedoresFiltrados(todosFornecedores)
        }
        setForm(prev => ({ ...prev, fornecedor_id: '', marca_id: '' }))
        setMarcasDisponiveis([])
      })
  }, [form.insumo_id, todosFornecedores])

  // Quando muda o fornecedor: filtrar marcas
  useEffect(() => {
    if (!form.fornecedor_id || !form.insumo_id) {
      setMarcasDisponiveis([])
      setForm(prev => ({ ...prev, marca_id: '' }))
      return
    }

    supabase
      .from('fornecedores_insumos_marcas')
      .select('marca:marcas(id, nome, empresa_id, created_at)')
      .eq('fornecedor_id', form.fornecedor_id)
      .eq('insumo_id', form.insumo_id)
      .then(({ data }) => {
        const marcas = (data ?? []).map((r: any) => Array.isArray(r.marca) ? r.marca[0] : r.marca).filter(Boolean) as Marca[]
        setMarcasDisponiveis(marcas)
        setForm(prev => ({ ...prev, marca_id: '' }))
      })
  }, [form.fornecedor_id, form.insumo_id])

  const selectedInsumo = insumos.find(i => i.id === form.insumo_id)
  const tamanhoEmbalagem = selectedInsumo?.tamanho_embalagem
  const quantidade = parseFloat(form.quantidade_recebida) || 0

  // Auto-calcula num_etiquetas quando muda a quantidade ou o insumo
  // Com tamanho de embalagem, o número de etiquetas é consequência da divisão
  // física, não uma escolha: são os fardos cheios mais o aberto, se sobrar.
  useEffect(() => {
    if (tamanhoEmbalagem && quantidade > 0) {
      setNumEtiquetas(Math.ceil(quantidade / tamanhoEmbalagem))
    } else {
      setNumEtiquetas(1)
    }
  }, [form.insumo_id, form.quantidade_recebida, tamanhoEmbalagem])

  /**
   * Como a quantidade se reparte entre as etiquetas.
   *
   * Com tamanho de embalagem cadastrado, a divisão é a FÍSICA — fardos cheios
   * mais um aberto com o resto —, a mesma que `registrar_entrada_lote` faz no
   * banco (migration 077). Antes esta tela dividia igualmente e prometia, para
   * 30 kg de farinha, "2× 15 kg": embalagem que não existe.
   */
  function calcDistribuicao(): string | null {
    if (quantidade <= 0) return null
    const un = selectedInsumo?.unidade_medida ?? ''

    if (tamanhoEmbalagem && tamanhoEmbalagem > 0) {
      const fechadas = Math.floor(quantidade / tamanhoEmbalagem)
      const resto = Math.round((quantidade - fechadas * tamanhoEmbalagem) * 1000) / 1000
      const partes: string[] = []
      if (fechadas > 0) partes.push(`${fechadas}× ${tamanhoEmbalagem} ${un}`)
      if (resto > 0) partes.push(`1× ${resto} ${un} (embalagem aberta)`)
      return partes.join(' + ')
    }

    if (numEtiquetas === 1) return `1 etiqueta de ${quantidade} ${un}`
    const qtdPorEtiqueta = Math.floor((quantidade / numEtiquetas) * 1000) / 1000
    const qtdUltima = Math.round((quantidade - qtdPorEtiqueta * (numEtiquetas - 1)) * 1000) / 1000
    if (qtdPorEtiqueta === qtdUltima) return `${numEtiquetas}× ${qtdPorEtiqueta} ${un}`
    return `${numEtiquetas - 1}× ${qtdPorEtiqueta} ${un} + 1× ${qtdUltima} ${un}`
  }

  function set(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    setError('')

    if (!form.insumo_id || !form.validade_original || !form.quantidade_recebida) {
      setError('Preencha todos os campos obrigatórios.')
      return
    }
    if (numEtiquetas < 1) {
      setError('O número de etiquetas deve ser pelo menos 1.')
      return
    }

    setLoading(true)
    const { data, error: rpcError } = await supabase.rpc('registrar_entrada_lote', {
      p_empresa_id:          profile.empresa_id,
      p_insumo_id:           form.insumo_id,
      p_fornecedor_id:       form.fornecedor_id || null,
      p_marca_id:            form.marca_id || null,
      p_data_recebimento:    form.data_recebimento,
      p_validade_original:   form.validade_original,
      p_quantidade_recebida: parseFloat(form.quantidade_recebida),
      p_unidade:             selectedInsumo?.unidade_medida ?? 'kg',
      p_num_etiquetas:       numEtiquetas,
      p_observacoes:         form.observacoes || null,
      p_responsavel_id:      profile.id,
      p_numero_nf:           form.numero_nf || null,
    })

    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao registrar lote.')
      setLoading(false)
      return
    }

    const result = data as { lotes: { lote_id: string; codigo: string; qr_code: string; quantidade: number }[] }

    if (numEtiquetas === 1) {
      navigate(`/recebimento/imprimir/${result.lotes[0].lote_id}`)
    } else {
      navigate('/recebimento/imprimir-lotes', { state: { lotes: result.lotes } })
    }
  }

  const distribuicao = calcDistribuicao()

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      {/* Page header */}
      <div className="mb-6">
        <button onClick={() => navigate('/recebimento')} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Registrar Novo Lote</h1>
        <p className="text-sm text-gray-500 mt-0.5">Entrada no Estoque Central</p>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="p-5 space-y-4">
          {/* Insumo */}
          <Select
            label="Insumo"
            required
            value={form.insumo_id}
            onChange={e => set('insumo_id', e.target.value)}
          >
            <option value="">Selecionar insumo...</option>
            {insumos.map(ins => (
              <option key={ins.id} value={ins.id}>
                {ins.codigo} — {ins.nome}
              </option>
            ))}
          </Select>

          {/* Fornecedor — filtrado pelos vínculos do insumo */}
          <Select
            label="Fornecedor (opcional)"
            value={form.fornecedor_id}
            onChange={e => set('fornecedor_id', e.target.value)}
          >
            <option value="">Sem fornecedor</option>
            {fornecedoresFiltrados.map(f => (
              <option key={f.id} value={f.id}>{f.nome}</option>
            ))}
          </Select>

          {/* Marca — filtrada pelos vínculos fornecedor+insumo */}
          {marcasDisponiveis.length > 0 && (
            <Select
              label="Marca"
              value={form.marca_id}
              onChange={e => set('marca_id', e.target.value)}
            >
              <option value="">Sem marca</option>
              {marcasDisponiveis.map(m => (
                <option key={m.id} value={m.id}>{m.nome}</option>
              ))}
            </Select>
          )}

          {/* Número da NF */}
          <Input
            label="Número da NF (opcional)"
            type="text"
            value={form.numero_nf}
            onChange={e => set('numero_nf', e.target.value)}
            placeholder="Ex: 001234"
          />

          <div className="grid grid-cols-2 gap-4">
            {/* Data de recebimento */}
            <Input
              label="Data de recebimento"
              type="date"
              required
              value={form.data_recebimento}
              onChange={e => set('data_recebimento', e.target.value)}
            />

            {/* Validade original */}
            <Input
              label="Validade (embalagem)"
              type="date"
              required
              value={form.validade_original}
              onChange={e => set('validade_original', e.target.value)}
            />
          </div>

          {/* Quantidade */}
          <Input
            label={`Quantidade total ${selectedInsumo ? `(${selectedInsumo.unidade_medida})` : ''}`}
            type="number" inputMode="decimal"
            step="0.001"
            min="0.001"
            required
            value={form.quantidade_recebida}
            onChange={e => set('quantidade_recebida', e.target.value)}
            placeholder="0.000"
          />

          {/* Widget de fracionamento */}
          {quantidade > 0 && form.insumo_id && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">
                Etiquetas / QR Codes
              </p>
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-700 whitespace-nowrap">Etiquetas a gerar:</label>
                <input
                  type="number" inputMode="decimal"
                  min="1"
                  step="1"
                  value={numEtiquetas}
                  disabled={!!tamanhoEmbalagem}
                  onChange={e => setNumEtiquetas(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-20 rounded-lg border border-blue-300 px-3 py-1.5 text-sm font-semibold text-blue-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-blue-100 disabled:text-blue-700"
                />
                {tamanhoEmbalagem && (
                  <span className="text-xs text-blue-600">
                    embalagem de {tamanhoEmbalagem} {selectedInsumo?.unidade_medida} — o
                    sistema separa os fardos cheios do que sobrar
                  </span>
                )}
              </div>
              {distribuicao && (
                <p className="text-xs text-blue-700 mt-2 font-medium">{distribuicao}</p>
              )}
            </div>
          )}

          {/* Observações */}
          <Textarea
            label="Observações (opcional)"
            value={form.observacoes}
            onChange={e => set('observacoes', e.target.value)}
            placeholder="Condição da embalagem, temperatura de chegada..."
          />
        </Card>

        {error && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3 mt-4 acoes-fixas">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => navigate('/recebimento')}
          >
            Cancelar
          </Button>
          <Button type="submit" size="lg" fullWidth loading={loading}>
            Registrar e gerar {numEtiquetas > 1 ? `${numEtiquetas} etiquetas` : 'QR Code'}
          </Button>
        </div>
      </form>
    </div>
  )
}

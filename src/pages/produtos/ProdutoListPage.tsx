import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Produto, ProdutoEmbalagem } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

type FichaOption = {
  id: string
  nome: string
  codigo: string
  versoes: { peso_medio_g: number | null; ativa: boolean }[]
}

type NivelEmbalagem = {
  nome: string
  quantidade: string
}

type FormState = {
  codigo: string
  nome: string
  descricao: string
  ficha_tecnica_id: string
  peso_unitario_g: string
  validade_dias: string
  ativo: boolean
  niveis: NivelEmbalagem[]
}

const emptyForm = (): FormState => ({
  codigo: '',
  nome: '',
  descricao: '',
  ficha_tecnica_id: '',
  peso_unitario_g: '',
  validade_dias: '',
  ativo: true,
  niveis: [],
})

type ProdutoComJoins = Produto & {
  ficha_tecnica?: { nome: string; codigo: string }
  embalagens?: ProdutoEmbalagem[]
}

export function ProdutoListPage() {
  const { profile } = useAuth()
  const [produtos, setProdutos] = useState<ProdutoComJoins[]>([])
  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ProdutoComJoins | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    if (!profile) return
    const [{ data: prods }, { data: fichasData }] = await Promise.all([
      supabase
        .from('produtos')
        .select('*, ficha_tecnica:fichas_tecnicas(nome, codigo), embalagens:produtos_embalagens(*)')
        .eq('empresa_id', profile.empresa_id)
        .order('nome'),
      supabase
        .from('fichas_tecnicas')
        .select('id, nome, codigo, versoes:fichas_tecnicas_versoes(peso_medio_g, ativa)')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true),
    ])
    setProdutos((prods ?? []) as ProdutoComJoins[])
    setFichas((fichasData ?? []) as FichaOption[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  function openNew() {
    setEditing(null)
    setForm(emptyForm())
    setError('')
    setModalOpen(true)
  }

  function openEdit(prod: ProdutoComJoins) {
    setEditing(prod)
    setForm({
      codigo: prod.codigo,
      nome: prod.nome,
      descricao: prod.descricao ?? '',
      ficha_tecnica_id: prod.ficha_tecnica_id ?? '',
      peso_unitario_g: prod.peso_unitario_g?.toString() ?? '',
      validade_dias: prod.validade_dias?.toString() ?? '',
      ativo: prod.ativo,
      niveis: (prod.embalagens ?? [])
        .sort((a, b) => a.nivel - b.nivel)
        .map(e => ({ nome: e.nome, quantidade: e.quantidade.toString() })),
    })
    setError('')
    setModalOpen(true)
  }

  function set(field: keyof FormState, value: string | boolean | NivelEmbalagem[]) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handleFichaChange(fichaId: string) {
    set('ficha_tecnica_id', fichaId)
    if (fichaId) {
      const ficha = fichas.find(f => f.id === fichaId)
      if (ficha) {
        const versaoAtiva = ficha.versoes.find(v => v.ativa)
        if (versaoAtiva?.peso_medio_g != null) {
          set('peso_unitario_g', versaoAtiva.peso_medio_g.toString())
        }
      }
    }
  }

  function addNivel() {
    setForm(prev => ({
      ...prev,
      niveis: [...prev.niveis, { nome: '', quantidade: '' }],
    }))
  }

  function removeNivel(index: number) {
    setForm(prev => ({
      ...prev,
      niveis: prev.niveis.filter((_, i) => i !== index),
    }))
  }

  function updateNivel(index: number, field: keyof NivelEmbalagem, value: string) {
    setForm(prev => ({
      ...prev,
      niveis: prev.niveis.map((n, i) => i === index ? { ...n, [field]: value } : n),
    }))
  }

  function calcUnidadeMinima(): number | null {
    if (form.niveis.length === 0) return null
    const vals = form.niveis.map(n => parseInt(n.quantidade))
    if (vals.some(v => isNaN(v) || v <= 0)) return null
    return vals.reduce((acc, v) => acc * v, 1)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.codigo.trim()) { setError('Codigo e obrigatorio.'); return }
    if (!form.nome.trim()) { setError('Nome e obrigatorio.'); return }
    setError('')
    setSaving(true)

    const payload = {
      empresa_id: profile.empresa_id,
      codigo: form.codigo.trim(),
      nome: form.nome.trim(),
      descricao: form.descricao.trim() || null,
      ficha_tecnica_id: form.ficha_tecnica_id || null,
      peso_unitario_g: form.peso_unitario_g ? parseFloat(form.peso_unitario_g) : null,
      validade_dias: form.validade_dias ? parseInt(form.validade_dias) : null,
      ativo: form.ativo,
    }

    let produtoId: string

    if (editing) {
      const { error: err } = await supabase.from('produtos').update(payload).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
      produtoId = editing.id
    } else {
      const { data: inserted, error: err } = await supabase
        .from('produtos')
        .insert(payload)
        .select('id')
        .single()
      if (err || !inserted) { setError(err?.message ?? 'Erro ao criar produto.'); setSaving(false); return }
      produtoId = inserted.id
    }

    // Upsert embalagens: delete old + insert new
    await supabase.from('produtos_embalagens').delete().eq('produto_id', produtoId)

    if (form.niveis.length > 0) {
      const embalagens = form.niveis.map((n, i) => ({
        produto_id: produtoId,
        nivel: i + 1,
        nome: n.nome.trim(),
        quantidade: parseInt(n.quantidade) || 1,
      }))
      const { error: embErr } = await supabase.from('produtos_embalagens').insert(embalagens)
      if (embErr) { setError(embErr.message); setSaving(false); return }
    }

    setModalOpen(false)
    setSaving(false)
    load()
  }

  async function toggleAtivo(prod: ProdutoComJoins) {
    await supabase.from('produtos').update({ ativo: !prod.ativo }).eq('id', prod.id)
    load()
  }

  const filtered = produtos.filter(p =>
    p.nome.toLowerCase().includes(search.toLowerCase()) ||
    p.codigo.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Produtos</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cadastro de produtos acabados</p>
        </div>
        <Button onClick={openNew} icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        }>
          Novo Produto
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Buscar por nome ou codigo..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">Nenhum produto encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Nome</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Codigo</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Receita vinculada</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Validade (dias)</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Peso (g)</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(prod => (
                  <tr key={prod.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => openEdit(prod)}>
                    <td className="px-4 py-3 font-medium text-gray-900">{prod.nome}</td>
                    <td className="px-4 py-3 font-mono text-gray-500 text-xs">{prod.codigo}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {prod.ficha_tecnica
                        ? <span className="text-xs">{prod.ficha_tecnica.codigo} - {prod.ficha_tecnica.nome}</span>
                        : <span className="text-gray-400 text-xs">--</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {prod.validade_dias != null
                        ? `${prod.validade_dias}d`
                        : <span className="text-gray-400">--</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {prod.peso_unitario_g != null
                        ? `${prod.peso_unitario_g}g`
                        : <span className="text-gray-400">--</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        prod.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {prod.ativo ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => toggleAtivo(prod)}
                        className="text-brand-600 hover:text-brand-800 text-xs font-medium"
                      >
                        {prod.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Modal add/edit */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">
                {editing ? 'Editar Produto' : 'Novo Produto'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Codigo"
                  required
                  value={form.codigo}
                  onChange={e => set('codigo', e.target.value)}
                  placeholder="Ex: PROD001"
                />
                <Input
                  label="Nome"
                  required
                  value={form.nome}
                  onChange={e => set('nome', e.target.value)}
                  placeholder="Ex: Trufa de chocolate"
                />
              </div>

              <Textarea
                label="Descricao"
                value={form.descricao}
                onChange={e => set('descricao', e.target.value)}
                rows={2}
              />

              <Select
                label="Ficha tecnica vinculada"
                value={form.ficha_tecnica_id}
                onChange={e => handleFichaChange(e.target.value)}
              >
                <option value="">Nenhuma</option>
                {fichas.map(f => (
                  <option key={f.id} value={f.id}>{f.codigo} - {f.nome}</option>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Peso unitario (g)"
                  type="number" inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={form.peso_unitario_g}
                  onChange={e => set('peso_unitario_g', e.target.value)}
                  placeholder="Ex: 30"
                  hint="Peso do produto em gramas"
                />
                <Input
                  label="Validade (dias)"
                  type="number" inputMode="decimal"
                  step="1"
                  min="1"
                  value={form.validade_dias}
                  onChange={e => set('validade_dias', e.target.value)}
                  placeholder="Ex: 90"
                  hint="Validade em dias apos producao"
                />
              </div>

              {/* Niveis de embalagem */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Niveis de embalagem</p>

                {form.niveis.length === 0 && (
                  <p className="text-xs text-gray-400">Nenhum nivel de embalagem definido.</p>
                )}

                {form.niveis.map((nivel, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={`Nivel ${i + 1} - Nome`}
                        value={nivel.nome}
                        onChange={e => updateNivel(i, 'nome', e.target.value)}
                        placeholder="Ex: Caixa, Bandeja, Display"
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        label="Qtd"
                        type="number" inputMode="decimal"
                        step="1"
                        min="1"
                        value={nivel.quantidade}
                        onChange={e => updateNivel(i, 'quantidade', e.target.value)}
                        placeholder="0"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeNivel(i)}
                      className="mb-1 p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      title="Remover nivel"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addNivel}
                  className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-800"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  Adicionar nivel de embalagem
                </button>

                {(() => {
                  const total = calcUnidadeMinima()
                  if (total == null) return null
                  return (
                    <div className="mt-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-600">
                      Unidade minima: <span className="font-semibold text-gray-900">{total} un</span>
                      {' '}({form.niveis.map(n => n.quantidade).join(' x ')})
                    </div>
                  )
                })()}
              </div>

              {editing && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.ativo}
                    onChange={e => set('ativo', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">Produto ativo</span>
                </label>
              )}

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" fullWidth loading={saving}>
                  {editing ? 'Salvar alteracoes' : 'Cadastrar produto'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

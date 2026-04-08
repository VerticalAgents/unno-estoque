import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Fornecedor, Insumo, Marca, FornecedorInsumoMarca } from '../../types/database.types'
import { Input, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

type FormState = {
  nome: string
  marca: string
  cnpj: string
  contato: string
  telefone: string
  email: string
  cidade: string
  observacoes: string
  ativo: boolean
}

const emptyForm = (): FormState => ({
  nome: '',
  marca: '',
  cnpj: '',
  contato: '',
  telefone: '',
  email: '',
  cidade: '',
  observacoes: '',
  ativo: true,
})

type VinculoComNomes = FornecedorInsumoMarca & { insumo: Insumo; marca: Marca }

export function FornecedorListPage() {
  const { profile } = useAuth()
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Fornecedor | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Seção "Produtos que fornece"
  const [vinculos, setVinculos] = useState<VinculoComNomes[]>([])
  const [todosInsumos, setTodosInsumos] = useState<Insumo[]>([])
  const [marcasParaInsumo, setMarcasParaInsumo] = useState<Marca[]>([])
  const [novoInsumoId, setNovoInsumoId] = useState('')
  const [novaMarcaId, setNovaMarcaId] = useState('')
  const [savingVinculo, setSavingVinculo] = useState(false)
  const [vinculoError, setVinculoError] = useState('')

  async function load() {
    if (!profile) return
    const { data } = await supabase
      .from('fornecedores')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setFornecedores((data ?? []) as Fornecedor[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  async function loadVinculos(fornecedorId: string) {
    const { data } = await supabase
      .from('fornecedores_insumos_marcas')
      .select('*, insumo:insumos(*), marca:marcas(*)')
      .eq('fornecedor_id', fornecedorId)
    setVinculos((data ?? []) as VinculoComNomes[])
  }

  async function loadTodosInsumos() {
    if (!profile) return
    const { data } = await supabase
      .from('insumos')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .order('nome')
    setTodosInsumos((data ?? []) as Insumo[])
  }

  // Quando muda o insumo no formulário de vínculo, carrega marcas desse insumo
  useEffect(() => {
    if (!novoInsumoId) {
      setMarcasParaInsumo([])
      setNovaMarcaId('')
      return
    }
    supabase
      .from('insumos_marcas')
      .select('marca:marcas(id, nome, empresa_id, created_at)')
      .eq('insumo_id', novoInsumoId)
      .then(({ data }) => {
        const marcas = (data ?? []).map((r: any) => Array.isArray(r.marca) ? r.marca[0] : r.marca).filter(Boolean) as Marca[]
        setMarcasParaInsumo(marcas)
        setNovaMarcaId('')
      })
  }, [novoInsumoId])

  function openNew() {
    setEditing(null)
    setForm(emptyForm())
    setError('')
    setVinculos([])
    setNovoInsumoId('')
    setNovaMarcaId('')
    setVinculoError('')
    setModalOpen(true)
  }

  function openEdit(f: Fornecedor) {
    setEditing(f)
    setForm({
      nome: f.nome,
      marca: f.marca ?? '',
      cnpj: f.cnpj ?? '',
      contato: f.contato ?? '',
      telefone: f.telefone ?? '',
      email: f.email ?? '',
      cidade: f.cidade ?? '',
      observacoes: f.observacoes ?? '',
      ativo: f.ativo,
    })
    setError('')
    setNovoInsumoId('')
    setNovaMarcaId('')
    setVinculoError('')
    loadVinculos(f.id)
    loadTodosInsumos()
    setModalOpen(true)
  }

  function set(field: keyof FormState, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.nome.trim()) { setError('Nome é obrigatório.'); return }
    setError('')
    setSaving(true)

    const payload = {
      empresa_id: profile.empresa_id,
      nome: form.nome.trim(),
      marca: form.marca || null,
      cnpj: form.cnpj || null,
      contato: form.contato || null,
      telefone: form.telefone || null,
      email: form.email || null,
      cidade: form.cidade || null,
      observacoes: form.observacoes || null,
      ativo: form.ativo,
    }

    if (editing) {
      const { error: err } = await supabase.from('fornecedores').update(payload).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
    } else {
      const { error: err } = await supabase.from('fornecedores').insert(payload)
      if (err) { setError(err.message); setSaving(false); return }
    }

    setModalOpen(false)
    setSaving(false)
    load()
  }

  async function handleAdicionarVinculo() {
    if (!editing || !novoInsumoId || !novaMarcaId) return
    setVinculoError('')
    setSavingVinculo(true)

    // Evita duplicata
    if (vinculos.some(v => v.insumo_id === novoInsumoId && v.marca_id === novaMarcaId)) {
      setVinculoError('Este par insumo/marca já está cadastrado.')
      setSavingVinculo(false)
      return
    }

    const { error: err } = await supabase.from('fornecedores_insumos_marcas').insert({
      fornecedor_id: editing.id,
      insumo_id: novoInsumoId,
      marca_id: novaMarcaId,
    })
    if (err) { setVinculoError(err.message); setSavingVinculo(false); return }

    setNovoInsumoId('')
    setNovaMarcaId('')
    await loadVinculos(editing.id)
    setSavingVinculo(false)
  }

  async function handleRemoverVinculo(vinculoId: string) {
    if (!editing) return
    await supabase.from('fornecedores_insumos_marcas').delete().eq('id', vinculoId)
    await loadVinculos(editing.id)
  }

  const filtered = fornecedores.filter(f =>
    f.nome.toLowerCase().includes(search.toLowerCase()) ||
    (f.marca ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (f.cidade ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Fornecedores</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cadastro de fornecedores e marcas</p>
        </div>
        <Button onClick={openNew} icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        }>
          Novo Fornecedor
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Buscar por nome, marca ou cidade..."
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
          <div className="p-8 text-center text-sm text-gray-500">Nenhum fornecedor cadastrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Nome</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Marca</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">CNPJ</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Contato</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Cidade</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(f => (
                  <tr key={f.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{f.nome}</td>
                    <td className="px-4 py-3 text-gray-600">{f.marca ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{f.cnpj ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3 text-gray-600">
                      <div>{f.contato ?? ''}</div>
                      {f.telefone && <div className="text-xs text-gray-400">{f.telefone}</div>}
                      {f.email && <div className="text-xs text-gray-400">{f.email}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{f.cidade ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        f.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {f.ativo ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openEdit(f)}
                        className="text-brand-600 hover:text-brand-800 text-xs font-medium"
                      >
                        Editar
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
                {editing ? 'Editar Fornecedor' : 'Novo Fornecedor'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              <Input
                label="Nome"
                required
                value={form.nome}
                onChange={e => set('nome', e.target.value)}
                placeholder="Ex: Açucareira do Brasil"
              />

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Marca"
                  value={form.marca}
                  onChange={e => set('marca', e.target.value)}
                  placeholder="Ex: União"
                />
                <Input
                  label="CNPJ"
                  value={form.cnpj}
                  onChange={e => set('cnpj', e.target.value)}
                  placeholder="00.000.000/0001-00"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Contato (nome)"
                  value={form.contato}
                  onChange={e => set('contato', e.target.value)}
                />
                <Input
                  label="Telefone"
                  value={form.telefone}
                  onChange={e => set('telefone', e.target.value)}
                  placeholder="(11) 99999-9999"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="E-mail"
                  type="email"
                  value={form.email}
                  onChange={e => set('email', e.target.value)}
                />
                <Input
                  label="Cidade"
                  value={form.cidade}
                  onChange={e => set('cidade', e.target.value)}
                />
              </div>

              <Textarea
                label="Observações"
                value={form.observacoes}
                onChange={e => set('observacoes', e.target.value)}
                rows={2}
              />

              {editing && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.ativo}
                    onChange={e => set('ativo', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">Fornecedor ativo</span>
                </label>
              )}

              {/* ── Seção "Produtos que fornece" (só ao editar) ── */}
              {editing && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Produtos que fornece</p>

                  {/* Lista de vínculos */}
                  {vinculos.length === 0 ? (
                    <p className="text-xs text-gray-400">Nenhum produto cadastrado.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {vinculos.map(v => (
                        <div key={v.id} className="flex items-center justify-between gap-2 py-1 px-2 bg-gray-50 rounded-lg">
                          <span className="text-sm text-gray-700">
                            <span className="font-medium">{v.insumo?.nome ?? '—'}</span>
                            <span className="text-gray-400 mx-1">·</span>
                            <span className="text-gray-500">{v.marca?.nome ?? '—'}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoverVinculo(v.id)}
                            className="text-gray-400 hover:text-red-500 shrink-0"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Adicionar novo vínculo */}
                  <div className="space-y-2">
                    <select
                      value={novoInsumoId}
                      onChange={e => setNovoInsumoId(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">Selecionar insumo...</option>
                      {todosInsumos.map(i => (
                        <option key={i.id} value={i.id}>{i.nome}</option>
                      ))}
                    </select>

                    {novoInsumoId && (
                      <div className="flex gap-2">
                        <select
                          value={novaMarcaId}
                          onChange={e => setNovaMarcaId(e.target.value)}
                          disabled={marcasParaInsumo.length === 0}
                          className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50 disabled:text-gray-400"
                        >
                          <option value="">
                            {marcasParaInsumo.length === 0
                              ? 'Nenhuma marca cadastrada para este insumo'
                              : 'Selecionar marca...'}
                          </option>
                          {marcasParaInsumo.map(m => (
                            <option key={m.id} value={m.id}>{m.nome}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!novaMarcaId || savingVinculo}
                          onClick={handleAdicionarVinculo}
                          className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-xs font-medium text-white disabled:opacity-50 whitespace-nowrap"
                        >
                          Adicionar
                        </button>
                      </div>
                    )}
                  </div>

                  {vinculoError && (
                    <p className="text-xs text-red-600">{vinculoError}</p>
                  )}
                </div>
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
                  {editing ? 'Salvar alterações' : 'Cadastrar fornecedor'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Insumo, CategoriaInsumo, Marca, InsumoMarca, InsumoNutrientes, UnidadeMedida } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

const UNIDADES: UnidadeMedida[] = ['kg', 'g', 'L', 'ml', 'unid']

const SUBTIPOS_RECIPIENTE = [
  { value: 'balde',              label: 'Balde' },
  { value: 'balde_fornecedor',   label: 'Balde do fornecedor' },
  { value: 'caixa_plastica',     label: 'Caixa plástica' },
  { value: 'garrafa',            label: 'Garrafa' },
  { value: 'garrafa_fornecedor', label: 'Garrafa do fornecedor' },
  { value: 'saco_confeitar',     label: 'Saco de confeitar' },
  { value: 'lata',               label: 'Lata' },
  { value: 'prateleira',         label: 'Prateleira' },
]

type FormState = {
  nome: string
  categoria_id: string
  unidade_medida: UnidadeMedida
  estoque_minimo: string
  estoque_minimo_ec: string
  estoque_maximo_ec: string
  estoque_minimo_ep: string
  estoque_maximo_ep: string
  shelf_life_dias_pos_abertura: string
  tamanho_embalagem: string
  observacoes: string
  ativo: boolean
  recipiente_subtipo: string
  recipiente_capacidade_max: string
  recipiente_unidade_cap: UnidadeMedida
}

const emptyForm = (): FormState => ({
  nome: '',
  categoria_id: '',
  unidade_medida: 'kg',
  estoque_minimo: '',
  estoque_minimo_ec: '',
  estoque_maximo_ec: '',
  estoque_minimo_ep: '',
  estoque_maximo_ep: '',
  shelf_life_dias_pos_abertura: '',
  tamanho_embalagem: '',
  observacoes: '',
  ativo: true,
  recipiente_subtipo: '',
  recipiente_capacidade_max: '',
  recipiente_unidade_cap: 'kg',
})

export function InsumoListPage() {
  const { profile } = useAuth()
  const [insumos, setInsumos] = useState<(Insumo & { categoria?: CategoriaInsumo })[]>([])
  const [categorias, setCategorias] = useState<CategoriaInsumo[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Insumo | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Marcas
  const [marcasVinculadas, setMarcasVinculadas] = useState<(InsumoMarca & { marca: Marca })[]>([])
  const [todasMarcas, setTodasMarcas] = useState<Marca[]>([])
  const [selectedMarcaId, setSelectedMarcaId] = useState('')
  const [novaMarcaNome, setNovaMarcaNome] = useState('')
  const [savingMarca, setSavingMarca] = useState(false)
  const [marcaError, setMarcaError] = useState('')

  // Nutrientes
  const NUTRI_FIELDS = [
    { key: 'energia_kcal', label: 'Energia (kcal)' },
    { key: 'carboidratos', label: 'Carboidratos (g)' },
    { key: 'acucares_totais', label: 'Acucares totais (g)' },
    { key: 'acucares_adicionados', label: 'Acucares adicionados (g)' },
    { key: 'proteinas', label: 'Proteinas (g)' },
    { key: 'gorduras_totais', label: 'Gorduras totais (g)' },
    { key: 'gorduras_saturadas', label: 'Gorduras saturadas (g)' },
    { key: 'gorduras_trans', label: 'Gorduras trans (g)' },
    { key: 'fibras', label: 'Fibras (g)' },
    { key: 'sodio_mg', label: 'Sodio (mg)' },
  ] as const
  const emptyNutri = (): Record<string, string> => Object.fromEntries(NUTRI_FIELDS.map(f => [f.key, '']))
  const [nutri, setNutri] = useState<Record<string, string>>(emptyNutri())
  const [savingNutri, setSavingNutri] = useState(false)
  const [nutriMsg, setNutriMsg] = useState('')

  async function loadNutrientes(insumoId: string) {
    const { data } = await supabase.from('insumos_nutrientes').select('*').eq('insumo_id', insumoId).single()
    if (data) {
      const n = data as InsumoNutrientes
      setNutri(Object.fromEntries(NUTRI_FIELDS.map(f => [f.key, (n[f.key as keyof InsumoNutrientes] ?? 0).toString()])))
    } else {
      setNutri(emptyNutri())
    }
  }

  async function handleSaveNutri() {
    if (!editing) return
    setSavingNutri(true)
    setNutriMsg('')
    const payload: Record<string, unknown> = { insumo_id: editing.id }
    for (const f of NUTRI_FIELDS) {
      payload[f.key] = nutri[f.key] ? parseFloat(nutri[f.key]) : 0
    }
    const { error: err } = await supabase.from('insumos_nutrientes').upsert(payload, { onConflict: 'insumo_id' })
    if (err) {
      setNutriMsg('Erro: ' + err.message)
    } else {
      setNutriMsg('Nutrientes salvos!')
    }
    setSavingNutri(false)
  }

  async function load() {
    if (!profile) return
    const [{ data: ins }, { data: cats }] = await Promise.all([
      supabase
        .from('insumos')
        .select('*, categoria:categorias_insumo(*)')
        .eq('empresa_id', profile.empresa_id)
        .order('nome'),
      supabase
        .from('categorias_insumo')
        .select('*')
        .eq('empresa_id', profile.empresa_id)
        .order('nome'),
    ])
    setInsumos((ins ?? []) as (Insumo & { categoria?: CategoriaInsumo })[])
    setCategorias((cats ?? []) as CategoriaInsumo[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  async function loadMarcasInsumo(insumoId: string) {
    const { data } = await supabase
      .from('insumos_marcas')
      .select('*, marca:marcas(*)')
      .eq('insumo_id', insumoId)
    setMarcasVinculadas((data ?? []) as (InsumoMarca & { marca: Marca })[])
  }

  async function loadTodasMarcas() {
    if (!profile) return
    const { data } = await supabase
      .from('marcas')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setTodasMarcas((data ?? []) as Marca[])
  }

  function openNew() {
    setEditing(null)
    setForm(emptyForm())
    setError('')
    setMarcasVinculadas([])
    setTodasMarcas([])
    setSelectedMarcaId('')
    setNovaMarcaNome('')
    setMarcaError('')
    setModalOpen(true)
  }

  function openEdit(ins: Insumo) {
    setEditing(ins)
    setForm({
      nome: ins.nome,
      categoria_id: ins.categoria_id ?? '',
      unidade_medida: ins.unidade_medida,
      estoque_minimo: ins.estoque_minimo?.toString() ?? '',
      estoque_minimo_ec: ins.estoque_minimo_ec?.toString() ?? '',
      estoque_maximo_ec: ins.estoque_maximo_ec?.toString() ?? '',
      estoque_minimo_ep: ins.estoque_minimo_ep?.toString() ?? '',
      estoque_maximo_ep: ins.estoque_maximo_ep?.toString() ?? '',
      shelf_life_dias_pos_abertura: ins.shelf_life_dias_pos_abertura?.toString() ?? '',
      tamanho_embalagem: ins.tamanho_embalagem?.toString() ?? '',
      observacoes: ins.observacoes ?? '',
      ativo: ins.ativo,
      recipiente_subtipo: ins.recipiente_subtipo ?? '',
      recipiente_capacidade_max: ins.recipiente_capacidade_max?.toString() ?? '',
      recipiente_unidade_cap: (ins.recipiente_unidade_cap as UnidadeMedida) ?? 'kg',
    })
    setError('')
    setSelectedMarcaId('')
    setNovaMarcaNome('')
    setMarcaError('')
    loadMarcasInsumo(ins.id)
    loadTodasMarcas()
    loadNutrientes(ins.id)
    setNutriMsg('')
    setModalOpen(true)
  }

  function set(field: keyof FormState, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.nome.trim()) { setError('Nome é obrigatório.'); return }
    if (!editing && !form.recipiente_subtipo) { setError('Tipo de recipiente padrão é obrigatório.'); return }
    setError('')
    setSaving(true)

    const payload = {
      empresa_id: profile.empresa_id,
      nome: form.nome.trim(),
      categoria_id: form.categoria_id || null,
      unidade_medida: form.unidade_medida,
      estoque_minimo: form.estoque_minimo ? parseFloat(form.estoque_minimo) : null,
      estoque_minimo_ec: form.estoque_minimo_ec ? parseFloat(form.estoque_minimo_ec) : null,
      estoque_maximo_ec: form.estoque_maximo_ec ? parseFloat(form.estoque_maximo_ec) : null,
      estoque_minimo_ep: form.estoque_minimo_ep ? parseFloat(form.estoque_minimo_ep) : null,
      estoque_maximo_ep: form.estoque_maximo_ep ? parseFloat(form.estoque_maximo_ep) : null,
      shelf_life_dias_pos_abertura: form.shelf_life_dias_pos_abertura
        ? parseInt(form.shelf_life_dias_pos_abertura)
        : null,
      tamanho_embalagem: form.tamanho_embalagem ? parseFloat(form.tamanho_embalagem) : null,
      observacoes: form.observacoes || null,
      ativo: form.ativo,
      recipiente_subtipo: form.recipiente_subtipo || null,
      recipiente_capacidade_max: form.recipiente_capacidade_max ? parseFloat(form.recipiente_capacidade_max) : null,
      recipiente_unidade_cap: form.recipiente_capacidade_max ? form.recipiente_unidade_cap : null,
    }

    if (editing) {
      const { error: err } = await supabase.from('insumos').update(payload).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
    } else {
      const { data: existing } = await supabase
        .from('insumos')
        .select('codigo')
        .eq('empresa_id', profile.empresa_id)
        .like('codigo', 'INS%')
        .order('codigo', { ascending: false })
        .limit(1)
      const lastNum = existing?.[0]
        ? parseInt(existing[0].codigo.replace('INS', '')) || 0
        : 0
      const codigo = 'INS' + String(lastNum + 1).padStart(3, '0')

      const { error: err } = await supabase.from('insumos').insert({ ...payload, codigo })
      if (err) { setError(err.message); setSaving(false); return }
    }

    setModalOpen(false)
    setSaving(false)
    load()
  }

  // Vincular marca existente ao insumo
  async function handleVincularMarca() {
    if (!editing || !selectedMarcaId) return
    setMarcaError('')
    setSavingMarca(true)

    // Evita duplicata
    if (marcasVinculadas.some(mv => mv.marca_id === selectedMarcaId)) {
      setMarcaError('Esta marca já está vinculada.')
      setSavingMarca(false)
      return
    }

    const { error: err } = await supabase.from('insumos_marcas').insert({
      insumo_id: editing.id,
      marca_id: selectedMarcaId,
    })
    if (err) { setMarcaError(err.message); setSavingMarca(false); return }

    setSelectedMarcaId('')
    await loadMarcasInsumo(editing.id)
    setSavingMarca(false)
  }

  // Criar nova marca e vincular
  async function handleCriarVincularMarca() {
    if (!editing || !novaMarcaNome.trim() || !profile) return
    setMarcaError('')
    setSavingMarca(true)

    // Verifica se já existe marca com esse nome na empresa
    const { data: existing } = await supabase
      .from('marcas')
      .select('id, nome')
      .eq('empresa_id', profile.empresa_id)
      .ilike('nome', novaMarcaNome.trim())
      .maybeSingle()

    let marcaId: string
    if (existing) {
      marcaId = existing.id
    } else {
      const { data: nova, error: errCriar } = await supabase
        .from('marcas')
        .insert({ empresa_id: profile.empresa_id, nome: novaMarcaNome.trim() })
        .select()
        .single()
      if (errCriar || !nova) { setMarcaError(errCriar?.message ?? 'Erro ao criar marca.'); setSavingMarca(false); return }
      marcaId = nova.id
    }

    if (marcasVinculadas.some(mv => mv.marca_id === marcaId)) {
      setMarcaError('Esta marca já está vinculada.')
      setSavingMarca(false)
      return
    }

    const { error: errLink } = await supabase.from('insumos_marcas').insert({
      insumo_id: editing.id,
      marca_id: marcaId,
    })
    if (errLink) { setMarcaError(errLink.message); setSavingMarca(false); return }

    setNovaMarcaNome('')
    await Promise.all([loadMarcasInsumo(editing.id), loadTodasMarcas()])
    setSavingMarca(false)
  }

  // Remover vínculo de marca
  async function handleRemoverMarca(vinculoId: string) {
    if (!editing) return
    await supabase.from('insumos_marcas').delete().eq('id', vinculoId)
    await loadMarcasInsumo(editing.id)
  }

  // Marcas que ainda não estão vinculadas (para o select)
  const marcasNaoVinculadas = todasMarcas.filter(
    m => !marcasVinculadas.some(mv => mv.marca_id === m.id)
  )

  const filtered = insumos.filter(i =>
    i.nome.toLowerCase().includes(search.toLowerCase()) ||
    i.codigo.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Insumos</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cadastro de insumos e matérias-primas</p>
        </div>
        <Button onClick={openNew} icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        }>
          Novo Insumo
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Buscar por nome ou código..."
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
          <div className="p-8 text-center text-sm text-gray-500">Nenhum insumo encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Código</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Nome</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Categoria</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Unid.</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Estoque mín.</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Embalagem</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Shelf life</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(ins => (
                  <tr key={ins.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-500 text-xs">{ins.codigo}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{ins.nome}</td>
                    <td className="px-4 py-3">
                      {ins.categoria ? (
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: ins.categoria.cor_hex ?? '#9CA3AF' }}
                          />
                          {ins.categoria.nome}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{ins.unidade_medida}</td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {ins.estoque_minimo != null ? ins.estoque_minimo : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {ins.tamanho_embalagem != null
                        ? `${ins.tamanho_embalagem} ${ins.unidade_medida}`
                        : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {ins.shelf_life_dias_pos_abertura != null
                        ? `${ins.shelf_life_dias_pos_abertura}d`
                        : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        ins.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {ins.ativo ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openEdit(ins)}
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
                {editing ? 'Editar Insumo' : 'Novo Insumo'}
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
                placeholder="Ex: Açúcar Cristal"
              />

              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Categoria"
                  value={form.categoria_id}
                  onChange={e => set('categoria_id', e.target.value)}
                >
                  <option value="">Sem categoria</option>
                  {categorias.map(c => (
                    <option key={c.id} value={c.id}>{c.nome}</option>
                  ))}
                </Select>

                <Select
                  label="Unidade de medida"
                  required
                  value={form.unidade_medida}
                  onChange={e => set('unidade_medida', e.target.value as UnidadeMedida)}
                >
                  {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Tamanho da embalagem"
                  type="number" inputMode="decimal"
                  step="0.001"
                  min="0"
                  value={form.tamanho_embalagem}
                  onChange={e => set('tamanho_embalagem', e.target.value)}
                  placeholder="Ex: 10"
                  hint={`${form.unidade_medida} por embalagem/fardo`}
                />
              </div>

              {/* Limites EC */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Estoque Central (EC)</p>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={`Mínimo EC (${form.unidade_medida})`}
                    type="number" inputMode="decimal" step="0.001" min="0"
                    value={form.estoque_minimo_ec}
                    onChange={e => set('estoque_minimo_ec', e.target.value)}
                    placeholder="0"
                    hint="Alerta para comprar"
                  />
                  <Input
                    label={`Máximo EC (${form.unidade_medida})`}
                    type="number" inputMode="decimal" step="0.001" min="0"
                    value={form.estoque_maximo_ec}
                    onChange={e => set('estoque_maximo_ec', e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>

              {/* Limites EP */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Estoque Produtivo (EP)</p>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={`Mínimo EP (${form.unidade_medida})`}
                    type="number" inputMode="decimal" step="0.001" min="0"
                    value={form.estoque_minimo_ep}
                    onChange={e => set('estoque_minimo_ep', e.target.value)}
                    placeholder="0"
                    hint="Alerta para transferir"
                  />
                  <Input
                    label={`Máximo EP (${form.unidade_medida})`}
                    type="number" inputMode="decimal" step="0.001" min="0"
                    value={form.estoque_maximo_ep}
                    onChange={e => set('estoque_maximo_ep', e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>

              <Input
                label="Shelf life após abertura (dias)"
                type="number" inputMode="decimal"
                min="1"
                step="1"
                value={form.shelf_life_dias_pos_abertura}
                onChange={e => set('shelf_life_dias_pos_abertura', e.target.value)}
                placeholder="Ex: 30"
                hint="Validade após transferência para o EP"
              />

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
                  <span className="text-sm text-gray-700">Insumo ativo</span>
                </label>
              )}

              {/* ── Modelo de recipiente padrão ── */}
              <div className={`rounded-lg border p-3 space-y-3 ${!editing && !form.recipiente_subtipo ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Modelo de recipiente padrão</p>
                  {!editing && <span className="text-xs text-red-500 font-medium">*obrigatório</span>}
                </div>
                <p className="text-xs text-gray-400">Usado para pré-preencher o cadastro de novos recipientes para este insumo.</p>
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Tipo de recipiente"
                    value={form.recipiente_subtipo}
                    onChange={e => set('recipiente_subtipo', e.target.value)}
                  >
                    <option value="">{editing ? 'Não definido' : 'Selecionar...'}</option>
                    {SUBTIPOS_RECIPIENTE.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </Select>
                  <div className="flex gap-2">
                    <Input
                      label="Capacidade"
                      type="number" inputMode="decimal"
                      step="0.001"
                      min="0"
                      value={form.recipiente_capacidade_max}
                      onChange={e => set('recipiente_capacidade_max', e.target.value)}
                      placeholder="Ex: 10"
                    />
                    <Select
                      label="Unid."
                      value={form.recipiente_unidade_cap}
                      onChange={e => set('recipiente_unidade_cap', e.target.value as UnidadeMedida)}
                    >
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </div>
                </div>
              </div>

              {/* ── Seção de Marcas (só ao editar) ── */}
              {editing && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Marcas deste insumo</p>

                  {/* Lista de marcas vinculadas */}
                  {marcasVinculadas.length === 0 ? (
                    <p className="text-xs text-gray-400">Nenhuma marca vinculada.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {marcasVinculadas.map(mv => (
                        <span
                          key={mv.id}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-full text-xs text-gray-700"
                        >
                          {mv.marca.nome}
                          <button
                            type="button"
                            onClick={() => handleRemoverMarca(mv.id)}
                            className="text-gray-400 hover:text-red-500 ml-0.5"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Vincular marca existente */}
                  {marcasNaoVinculadas.length > 0 && (
                    <div className="flex gap-2">
                      <select
                        value={selectedMarcaId}
                        onChange={e => setSelectedMarcaId(e.target.value)}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      >
                        <option value="">Selecionar marca existente...</option>
                        {marcasNaoVinculadas.map(m => (
                          <option key={m.id} value={m.id}>{m.nome}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!selectedMarcaId || savingMarca}
                        onClick={handleVincularMarca}
                        className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs font-medium text-gray-700 disabled:opacity-50"
                      >
                        Vincular
                      </button>
                    </div>
                  )}

                  {/* Criar nova marca */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Nova marca..."
                      value={novaMarcaNome}
                      onChange={e => setNovaMarcaNome(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCriarVincularMarca() } }}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      type="button"
                      disabled={!novaMarcaNome.trim() || savingMarca}
                      onClick={handleCriarVincularMarca}
                      className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Criar e vincular
                    </button>
                  </div>

                  {marcaError && (
                    <p className="text-xs text-red-600">{marcaError}</p>
                  )}
                </div>
              )}

              {/* ── Seção de Nutrientes (só ao editar) ── */}
              {editing && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Dados Nutricionais (por 100g)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {NUTRI_FIELDS.map(f => (
                      <Input
                        key={f.key}
                        label={f.label}
                        type="number" inputMode="decimal"
                        step="0.01"
                        min="0"
                        value={nutri[f.key]}
                        onChange={e => setNutri(prev => ({ ...prev, [f.key]: e.target.value }))}
                      />
                    ))}
                  </div>
                  {nutriMsg && (
                    <p className={`text-xs ${nutriMsg.startsWith('Erro') ? 'text-red-600' : 'text-emerald-600'}`}>{nutriMsg}</p>
                  )}
                  <Button type="button" size="sm" variant="secondary" loading={savingNutri} onClick={handleSaveNutri}>
                    Salvar nutrientes
                  </Button>
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
                  {editing ? 'Salvar alterações' : 'Cadastrar insumo'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

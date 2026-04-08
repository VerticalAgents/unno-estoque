import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Local, Insumo, Marca, UnidadeMedida } from '../../types/database.types'
import { Input, Select } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmModal } from '../../components/ui/ConfirmModal'

const SUBTIPOS = [
  { value: 'balde',              label: 'Balde' },
  { value: 'balde_fornecedor',   label: 'Balde do fornecedor' },
  { value: 'caixa_plastica',     label: 'Caixa plástica' },
  { value: 'garrafa',            label: 'Garrafa' },
  { value: 'garrafa_fornecedor', label: 'Garrafa do fornecedor' },
  { value: 'saco_confeitar',     label: 'Saco de confeitar' },
  { value: 'lata',               label: 'Lata' },
  { value: 'prateleira',         label: 'Prateleira' },
] as const

const UNIDADES: UnidadeMedida[] = ['kg', 'g', 'L', 'ml', 'unid']

type FormState = {
  nome: string
  subtipo: string
  insumo_id: string
  marca_id: string
  capacidade_max: string
  unidade_capacidade: UnidadeMedida
  peso_tara: string
  observacoes: string
  ativo: boolean
}

const emptyForm = (): FormState => ({
  nome: '',
  subtipo: 'balde',
  insumo_id: '',
  marca_id: '',
  capacidade_max: '',
  unidade_capacidade: 'kg',
  peso_tara: '',
  observacoes: '',
  ativo: true,
})

function gerarQrRecipiente(): string {
  return `QR-EP-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

type LocalComMarca = Local & { marca?: Marca | null }

export function RecipienteListPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [recipientes, setRecipientes] = useState<LocalComMarca[]>([])
  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Local | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Local | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteBlocked, setDeleteBlocked] = useState(false)

  // Marcas disponíveis para o insumo selecionado no form
  const [marcasParaInsumo, setMarcasParaInsumo] = useState<Marca[]>([])

  // Quando true, o submit também salva os valores como template no insumo
  const [isSavingTemplate, setIsSavingTemplate] = useState(false)

  // Grupos expandidos
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['__genericos__']))

  async function load() {
    if (!profile) return
    const [{ data: locais }, { data: ins }] = await Promise.all([
      supabase
        .from('locais')
        .select('*, marca:marcas(id, nome, empresa_id, created_at)')
        .eq('empresa_id', profile.empresa_id)
        .eq('tipo', 'estoque_produtivo')
        .order('nome'),
      supabase
        .from('insumos')
        .select('id, nome, unidade_medida, codigo, recipiente_subtipo, recipiente_capacidade_max, recipiente_unidade_cap, estoque_minimo_ep, estoque_maximo_ep')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true)
        .order('nome'),
    ])
    setRecipientes((locais ?? []) as LocalComMarca[])
    setInsumos((ins ?? []) as Insumo[])
    setLoading(false)
  }

  useEffect(() => { load() }, [profile])

  // Quando insumo muda no form, carrega marcas
  useEffect(() => {
    if (!form.insumo_id) {
      setMarcasParaInsumo([])
      setForm(prev => ({ ...prev, marca_id: '' }))
      return
    }
    supabase
      .from('insumos_marcas')
      .select('marca:marcas(id, nome, empresa_id, created_at)')
      .eq('insumo_id', form.insumo_id)
      .then(({ data }) => {
        const marcas = (data ?? []).map((r: any) => Array.isArray(r.marca) ? r.marca[0] : r.marca).filter(Boolean) as Marca[]
        setMarcasParaInsumo(marcas)
        setForm(prev => ({
          ...prev,
          marca_id: marcas.some(m => m.id === prev.marca_id) ? prev.marca_id : '',
        }))
      })
  }, [form.insumo_id])

  function openNew() {
    setEditing(null)
    setIsSavingTemplate(false)
    setForm(emptyForm())
    setError('')
    setModalOpen(true)
  }

  // Abre form pré-preenchido + ao salvar persiste como template no insumo
  function openCreateWithTemplate(ins: Insumo) {
    setEditing(null)
    setIsSavingTemplate(true)
    setForm({
      nome: '',
      subtipo: ins.recipiente_subtipo ?? 'balde',
      insumo_id: ins.id,
      marca_id: '',
      capacidade_max: ins.recipiente_capacidade_max?.toString() ?? '',
      unidade_capacidade: (ins.recipiente_unidade_cap as UnidadeMedida) ?? ins.unidade_medida ?? 'kg',
      peso_tara: '',
      observacoes: '',
      ativo: true,
    })
    setError('')
    setModalOpen(true)
  }

  // Abre form pré-preenchido com insumo + template do insumo (sem salvar template)
  function openCreateForInsumo(ins: Insumo) {
    setEditing(null)
    setIsSavingTemplate(false)
    setForm({
      nome: '',
      subtipo: ins.recipiente_subtipo ?? 'balde',
      insumo_id: ins.id,
      marca_id: '',
      capacidade_max: ins.recipiente_capacidade_max?.toString() ?? '',
      unidade_capacidade: (ins.recipiente_unidade_cap as UnidadeMedida) ?? ins.unidade_medida ?? 'kg',
      peso_tara: '',
      observacoes: '',
      ativo: true,
    })
    setError('')
    setModalOpen(true)
  }

  // Duplica recipiente existente (pré-preenche tudo, novo QR é gerado no submit)
  function openDuplicate(r: LocalComMarca) {
    setEditing(null)
    setIsSavingTemplate(false)
    setForm({
      nome: r.nome,
      subtipo: r.subtipo ?? 'balde',
      insumo_id: r.insumo_id ?? '',
      marca_id: r.marca_id ?? '',
      capacidade_max: r.capacidade_max?.toString() ?? '',
      unidade_capacidade: r.unidade_capacidade ?? 'kg',
      peso_tara: r.peso_tara?.toString() ?? '',
      observacoes: r.observacoes ?? '',
      ativo: true,
    })
    setError('')
    setModalOpen(true)
  }

  function openEdit(r: Local) {
    setEditing(r)
    setIsSavingTemplate(false)
    setForm({
      nome: r.nome,
      subtipo: r.subtipo ?? 'balde',
      insumo_id: r.insumo_id ?? '',
      marca_id: r.marca_id ?? '',
      capacidade_max: r.capacidade_max?.toString() ?? '',
      unidade_capacidade: r.unidade_capacidade ?? 'kg',
      peso_tara: r.peso_tara?.toString() ?? '',
      observacoes: r.observacoes ?? '',
      ativo: r.ativo,
    })
    setError('')
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
      tipo: 'estoque_produtivo' as const,
      subtipo: form.subtipo || null,
      insumo_id: form.insumo_id || null,
      marca_id: form.marca_id || null,
      capacidade_max: form.capacidade_max ? parseFloat(form.capacidade_max) : null,
      unidade_capacidade: form.capacidade_max ? form.unidade_capacidade : null,
      peso_tara: form.peso_tara ? parseFloat(form.peso_tara) : 0,
      observacoes: form.observacoes || null,
      ativo: form.ativo,
    }

    if (editing) {
      const { error: err } = await supabase.from('locais').update(payload).eq('id', editing.id)
      if (err) { setError(err.message); setSaving(false); return }
      setModalOpen(false)
      setSaving(false)
      load()
    } else {
      const qr = gerarQrRecipiente()
      const { data, error: err } = await supabase
        .from('locais')
        .insert({ ...payload, qr_code_fixo: qr })
        .select()
        .single()
      if (err) { setError(err.message); setSaving(false); return }

      // Salva também como template no insumo
      if (isSavingTemplate && form.insumo_id) {
        await supabase.from('insumos').update({
          recipiente_subtipo: form.subtipo || null,
          recipiente_capacidade_max: form.capacidade_max ? parseFloat(form.capacidade_max) : null,
          recipiente_unidade_cap: form.capacidade_max ? form.unidade_capacidade : null,
        }).eq('id', form.insumo_id)
      }

      setModalOpen(false)
      setSaving(false)
      load()
      if (data) navigate(`/recipientes/${data.id}/etiqueta`)
    }
  }

  async function openDelete(r: Local) {
    const { data } = await supabase
      .from('locais_estado_atual')
      .select('quantidade')
      .eq('local_id', r.id)
      .maybeSingle()
    const temEstoque = data && data.quantidade > 0
    setDeleting(r)
    setDeleteBlocked(!!temEstoque)
    setConfirmDelete(true)
  }

  async function handleDelete() {
    if (!deleting) return
    const { error: err } = await supabase.from('locais').delete().eq('id', deleting.id)
    if (err) { setError(err.message); setConfirmDelete(false); return }
    setConfirmDelete(false)
    setDeleting(null)
    load()
  }

  function nomeExibido(r: LocalComMarca): string {
    if (r.marca) return `${r.marca.nome.toUpperCase()}: ${r.nome}`
    return r.nome
  }

  const subtipLabel = (v?: string) => SUBTIPOS.find(s => s.value === v)?.label ?? v ?? '—'

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // ── Computed groupings ────────────────────────────────────

  const searchLow = search.toLowerCase()

  const filteredRecipientes = recipientes.filter(r =>
    nomeExibido(r).toLowerCase().includes(searchLow) ||
    (r.subtipo ?? '').toLowerCase().includes(searchLow)
  )

  // Recipientes com insumo, agrupados por insumo_id
  const comInsumo = filteredRecipientes.filter(r => r.insumo_id)
  const genericos = filteredRecipientes.filter(r => !r.insumo_id)

  // Insumos que têm ao menos 1 recipiente
  const insumoIdsComRecipiente = new Set(comInsumo.map(r => r.insumo_id))

  // Insumos sem nenhum recipiente
  const insumosSemRecipiente = !search
    ? insumos.filter(i => !insumoIdsComRecipiente.has(i.id))
    : []

  // Todos os insumos sem modelo padrão definido (independente de ter recipiente)
  const insumosComRecipienteSemModelo = !search
    ? insumos.filter(i => !i.recipiente_subtipo)
    : []

  // Grupos: insumo → recipientes
  const grupos: { insumo: Insumo; recipientes: LocalComMarca[] }[] = insumos
    .filter(i => insumoIdsComRecipiente.has(i.id))
    .map(i => ({
      insumo: i,
      recipientes: comInsumo.filter(r => r.insumo_id === i.id),
    }))
    .filter(g => g.recipientes.length > 0)

  const totalRecipientes = recipientes.length

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Recipientes</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {loading ? '...' : `${totalRecipientes} recipiente${totalRecipientes !== 1 ? 's' : ''} no EP`}
          </p>
        </div>
        <Button onClick={openNew} icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        }>
          Novo Recipiente
        </Button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-sm text-gray-500">Carregando...</div>
      ) : (
        <div className="space-y-5">

          {/* ── Insumos sem recipiente (prioridade) ── */}
          {insumosSemRecipiente.length > 0 && (
            <div className="rounded-xl border-2 border-amber-200 bg-amber-50 overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <p className="text-sm font-semibold text-amber-800">
                  {insumosSemRecipiente.length} insumo{insumosSemRecipiente.length !== 1 ? 's' : ''} sem recipiente no EP
                </p>
              </div>
              <div className="divide-y divide-amber-100">
                {insumosSemRecipiente.map(ins => (
                  <div key={ins.id} className="flex items-center justify-between px-4 py-2.5 bg-white/60">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{ins.nome}</span>
                      <span className="text-xs text-gray-400 ml-2 font-mono">{ins.codigo}</span>
                    </div>
                    <button
                      onClick={() => openCreateForInsumo(ins)}
                      className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-800 bg-brand-50 hover:bg-brand-100 px-2.5 py-1.5 rounded-lg transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Criar recipiente
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Insumos sem modelo padrão ── */}
          {insumosComRecipienteSemModelo.length > 0 && (
            <div className="rounded-xl border-2 border-blue-200 bg-blue-50 overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
                <p className="text-sm font-semibold text-blue-800">
                  {insumosComRecipienteSemModelo.length} insumo{insumosComRecipienteSemModelo.length !== 1 ? 's' : ''} sem modelo de recipiente padrão
                </p>
              </div>
              <div className="divide-y divide-blue-100">
                {insumosComRecipienteSemModelo.map(ins => (
                  <div key={ins.id} className="flex items-center justify-between px-4 py-2.5 bg-white/60">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{ins.nome}</span>
                      <span className="text-xs text-gray-400 ml-2 font-mono">{ins.codigo}</span>
                    </div>
                    <button
                      onClick={() => openCreateWithTemplate(ins)}
                      className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                      Cadastrar modelo padrão
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Busca ── */}
          {totalRecipientes > 0 && (
            <input
              type="text"
              placeholder="Buscar recipiente..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="block w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          )}

          {/* ── Grupos por insumo ── */}
          {grupos.map(({ insumo, recipientes: recs }) => (
            <Card key={insumo.id} className="overflow-hidden">
              {/* Group header */}
              <button
                onClick={() => toggleGroup(insumo.id)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${expandedGroups.has(insumo.id) ? 'rotate-90' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className="text-sm font-semibold text-gray-800">{insumo.nome}</span>
                  <span className="text-xs text-gray-400 font-mono">{insumo.codigo}</span>
                </div>
                <div className="flex items-center gap-3">
                  {/* Limites EP */}
                  {(insumo.estoque_minimo_ep != null || insumo.estoque_maximo_ep != null) && (
                    <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                      EP{' '}
                      {insumo.estoque_minimo_ep != null ? `mín ${insumo.estoque_minimo_ep}` : ''}
                      {insumo.estoque_minimo_ep != null && insumo.estoque_maximo_ep != null ? ' · ' : ''}
                      {insumo.estoque_maximo_ep != null ? `máx ${insumo.estoque_maximo_ep}` : ''}
                      {' '}{insumo.unidade_medida}
                    </span>
                  )}
                  <span className="text-xs text-gray-400">{recs.length} recipiente{recs.length !== 1 ? 's' : ''}</span>
                  <button
                    onClick={e => { e.stopPropagation(); openCreateForInsumo(insumo) }}
                    className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                  >
                    + Novo
                  </button>
                </div>
              </button>

              {/* Group rows */}
              {expandedGroups.has(insumo.id) && (
                <div className="border-t border-gray-100">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nome</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Tipo</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Capacidade</th>
                        <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">Status</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {recs.map(r => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-900">{nomeExibido(r)}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">{subtipLabel(r.subtipo)}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">
                            {r.capacidade_max != null
                              ? `${r.capacidade_max} ${r.unidade_capacidade ?? ''}`
                              : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                              r.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {r.ativo ? 'Ativo' : 'Inativo'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <RowActions
                              onEtiqueta={() => navigate(`/recipientes/${r.id}/etiqueta`)}
                              onEditar={() => openEdit(r)}
                              onDuplicar={() => openDuplicate(r)}
                              onExcluir={() => openDelete(r)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}

          {/* ── Genéricos (sem insumo) ── */}
          {genericos.length > 0 && (
            <Card className="overflow-hidden">
              <button
                onClick={() => toggleGroup('__genericos__')}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${expandedGroups.has('__genericos__') ? 'rotate-90' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className="text-sm font-semibold text-gray-500">Sem insumo associado</span>
                </div>
                <span className="text-xs text-gray-400">{genericos.length} recipiente{genericos.length !== 1 ? 's' : ''}</span>
              </button>

              {expandedGroups.has('__genericos__') && (
                <div className="border-t border-gray-100">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nome</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Tipo</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Capacidade</th>
                        <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">Status</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {genericos.map(r => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-900">{nomeExibido(r)}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">{subtipLabel(r.subtipo)}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">
                            {r.capacidade_max != null
                              ? `${r.capacidade_max} ${r.unidade_capacidade ?? ''}`
                              : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                              r.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {r.ativo ? 'Ativo' : 'Inativo'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <RowActions
                              onEtiqueta={() => navigate(`/recipientes/${r.id}/etiqueta`)}
                              onEditar={() => openEdit(r)}
                              onDuplicar={() => openDuplicate(r)}
                              onExcluir={() => openDelete(r)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {/* Estado vazio quando nenhum resultado de busca */}
          {search && grupos.length === 0 && genericos.length === 0 && (
            <div className="p-8 text-center text-sm text-gray-500">
              Nenhum recipiente encontrado para "{search}".
            </div>
          )}

          {/* Estado vazio total */}
          {!search && totalRecipientes === 0 && insumosSemRecipiente.length === 0 && !loading && (
            <div className="p-8 text-center text-sm text-gray-500">
              Nenhum recipiente cadastrado e nenhum insumo ativo.
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmDelete}
        variant={deleteBlocked ? 'default' : 'danger'}
        title={deleteBlocked ? 'Recipiente com estoque' : 'Excluir recipiente'}
        description={
          deleteBlocked
            ? `"${deleting?.nome}" ainda possui insumo armazenado. Esvazie o recipiente antes de excluí-lo.`
            : `Tem certeza que deseja excluir "${deleting?.nome}"? Esta ação não pode ser desfeita.`
        }
        confirmLabel={deleteBlocked ? 'Entendi' : 'Excluir'}
        cancelLabel={deleteBlocked ? undefined : 'Cancelar'}
        onConfirm={deleteBlocked ? () => { setConfirmDelete(false); setDeleting(null) } : handleDelete}
        onCancel={() => { setConfirmDelete(false); setDeleting(null) }}
      />

      {/* Modal add/edit/duplicate */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">
                {editing ? 'Editar Recipiente' : 'Novo Recipiente'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {!editing && (
                <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
                  <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                  </svg>
                  Um QR code será gerado automaticamente e você será redirecionado para imprimir a etiqueta.
                </div>
              )}

              <Select
                label="Insumo associado"
                value={form.insumo_id}
                onChange={e => set('insumo_id', e.target.value)}
              >
                <option value="">Nenhum (recipiente genérico)</option>
                {insumos.map(i => (
                  <option key={i.id} value={i.id}>{i.nome}</option>
                ))}
              </Select>

              {marcasParaInsumo.length > 0 && (
                <Select
                  label="Marca"
                  value={form.marca_id}
                  onChange={e => set('marca_id', e.target.value)}
                >
                  <option value="">Sem marca específica</option>
                  {marcasParaInsumo.map(m => (
                    <option key={m.id} value={m.id}>{m.nome}</option>
                  ))}
                </Select>
              )}

              <Input
                label="Nome"
                required
                value={form.nome}
                onChange={e => set('nome', e.target.value)}
                placeholder={form.marca_id
                  ? `Ex: balde 10kg  (será exibido como "${(marcasParaInsumo.find(m => m.id === form.marca_id)?.nome ?? '').toUpperCase()}: balde 10kg")`
                  : 'Ex: Balde Nutella 1kg'
                }
              />

              <Select
                label="Tipo de recipiente"
                value={form.subtipo}
                onChange={e => set('subtipo', e.target.value)}
              >
                {SUBTIPOS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Capacidade máxima"
                  type="number"
                  step="0.001"
                  min="0"
                  value={form.capacidade_max}
                  onChange={e => set('capacidade_max', e.target.value)}
                  placeholder="Ex: 5"
                />
                <Select
                  label="Unidade"
                  value={form.unidade_capacidade}
                  onChange={e => set('unidade_capacidade', e.target.value as UnidadeMedida)}
                >
                  {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                </Select>
              </div>

              <Input
                label="Peso tara (g)"
                type="number"
                step="1"
                min="0"
                value={form.peso_tara}
                onChange={e => set('peso_tara', e.target.value)}
                placeholder="Peso do recipiente vazio em gramas"
              />

              <Input
                label="Observações"
                value={form.observacoes}
                onChange={e => set('observacoes', e.target.value)}
              />

              {editing && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.ativo}
                    onChange={e => set('ativo', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">Recipiente ativo</span>
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
                  {editing ? 'Salvar alterações' : 'Cadastrar e imprimir etiqueta'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-component para botões de ação de cada linha ──────────

function RowActions({
  onEtiqueta,
  onEditar,
  onDuplicar,
  onExcluir,
}: {
  onEtiqueta: () => void
  onEditar: () => void
  onDuplicar: () => void
  onExcluir: () => void
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      <button onClick={onEtiqueta} className="text-gray-500 hover:text-gray-700 text-xs font-medium">
        Etiqueta
      </button>
      <button onClick={onEditar} className="text-brand-600 hover:text-brand-800 text-xs font-medium">
        Editar
      </button>
      <button onClick={onDuplicar} className="text-gray-500 hover:text-gray-700 text-xs font-medium">
        Duplicar
      </button>
      <button onClick={onExcluir} className="text-red-500 hover:text-red-700 text-xs font-medium">
        Excluir
      </button>
    </div>
  )
}

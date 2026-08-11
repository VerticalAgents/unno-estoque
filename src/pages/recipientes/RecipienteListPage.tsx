import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Local, Insumo, Marca, UnidadeMedida } from '../../types/database.types'
import { Input, Select } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import { CartaoLista, ListaResponsiva } from '../../components/ui/ListaResponsiva'
import { combina } from '../../lib/busca'

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

type LocalComMarca = Local & {
  marca?: Marca | null
  /** Embalagem do fornecedor: nasce na transferência e some quando esvazia. */
  efemero?: boolean
  origem_lote_id?: string | null
}

/** Conteúdo atual do recipiente — view v_recipientes_composicao (migration 034) */
interface Composicao {
  local_id: string
  qtd_lotes: number
  quantidade_total: number
  unidade_medida: string
  validade_ep: string | null
}

/**
 * O que está dentro do pote. "Misturado" não é erro — é o estado normal desde
 * que RO-003 foi revogada. Mas precisa ficar visível, porque enquanto o
 * recipiente não for esgotado, toda produção que usá-lo fica ligada a todos os
 * lotes de dentro.
 */
/**
 * O recipiente como cartão, no celular.
 *
 * As duas listas da tela (por insumo e genéricos) mostram os mesmos dados e
 * mudam só a última coluna — conteúdo numa, status na outra. Por isso o
 * cartão recebe essa parte pronta em vez de decidir sozinho.
 */
function CartaoRecipiente({
  r, conteudo, rotuloConteudo = 'Conteúdo', acoes,
}: {
  r: Local
  conteudo: React.ReactNode
  rotuloConteudo?: string
  acoes: React.ReactNode
}) {
  const subtip = SUBTIPOS.find(s => s.value === r.subtipo)?.label ?? r.subtipo ?? '—'
  const nome = r.insumo_id && (r as Local & { insumo?: { nome: string } }).insumo?.nome
    ? `${(r as Local & { insumo?: { nome: string } }).insumo!.nome} · ${r.nome}`
    : r.nome

  return (
    <CartaoLista
      titulo={<span className="font-medium text-gray-900 dark:text-unno-text">{nome}</span>}
      subtitulo={subtip}
      campos={[
        {
          rotulo: 'Capacidade',
          valor: r.capacidade_max != null
            ? `${r.capacidade_max} ${r.unidade_capacidade ?? ''}`
            : '—',
        },
        { rotulo: rotuloConteudo, valor: conteudo },
      ]}
      acoes={acoes}
    />
  )
}

/** Botão de esgotar, igual nas duas apresentações. */
function BotaoEsgotar({ r, esgotando, esgotar }: {
  r: Local
  esgotando: string | null
  esgotar: (r: Local) => void
}) {
  return (
    <button
      onClick={() => esgotar(r)}
      disabled={esgotando === r.id}
      title="Marcar como esgotado: zera a sobra e encerra a mistura"
      className="text-[0.65rem] font-semibold uppercase tracking-wide px-2 py-1 rounded
                 border border-gray-300 text-gray-600 hover:border-unno-amber hover:text-unno-amber
                 disabled:opacity-50 dark:border-white/[.08] dark:text-unno-muted"
    >
      {esgotando === r.id ? '...' : 'Esgotar'}
    </button>
  )
}

function ConteudoCell({ comp }: { comp?: Composicao }) {
  const total = comp?.quantidade_total ?? 0
  if (total <= 0) {
    return <span className="text-xs text-gray-400">vazio</span>
  }

  const qtd = Number(total).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
  const misturado = (comp?.qtd_lotes ?? 0) > 1

  return (
    <div className="leading-tight">
      <span className="text-xs font-medium text-gray-900 dark:text-unno-text">
        {qtd} {comp?.unidade_medida}
      </span>
      {misturado && (
        <span className="block text-[0.65rem] font-semibold uppercase tracking-wide text-unno-amber">
          {comp!.qtd_lotes} lotes misturados
        </span>
      )}
    </div>
  )
}

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
  const [composicao, setComposicao] = useState<Record<string, Composicao>>({})
  // Insumos cujo ponto de consumo é a própria embalagem do fornecedor: eles não
  // têm recipiente cadastrado de propósito (migration 073), e cobrar um seria
  // pedir de volta o cadastro que foi eliminado.
  const [semRecipientePorConfig, setSemRecipientePorConfig] = useState<Set<string>>(new Set())
  const [esgotando, setEsgotando] = useState<string | null>(null)
  // Aposentados ficam escondidos, mas continuam alcançáveis: sem isso não
  // haveria como reativar um pote pela interface.
  const [mostrarInativos, setMostrarInativos] = useState(false)

  async function load() {
    if (!profile) return
    const [{ data: locais }, { data: ins }, { data: comp }, { data: configs }] = await Promise.all([
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
      // Quantos lotes há dentro de cada recipiente (view da migration 034)
      supabase
        .from('v_recipientes_composicao')
        .select('local_id, qtd_lotes, quantidade_total, unidade_medida, validade_ep')
        .eq('empresa_id', profile.empresa_id),
      supabase
        .from('insumos_armazenamento_config')
        .select('insumo_id, modo_ep')
        .eq('modo_ep', 'embalagem_fornecedor'),
    ])
    setRecipientes((locais ?? []) as LocalComMarca[])
    setInsumos((ins ?? []) as Insumo[])
    setComposicao(
      Object.fromEntries(
        ((comp ?? []) as Composicao[]).map(c => [c.local_id, c]),
      ),
    )
    setSemRecipientePorConfig(
      new Set(((configs ?? []) as { insumo_id: string }[]).map(c => c.insumo_id)),
    )
    setLoading(false)
  }

  // ── Esgotar recipiente ────────────────────────────────────
  // Com rateio proporcional o saldo raramente chega a zero exato; sobra poeira
  // de cada lote. Quem raspa o pote marca aqui e a sobra vira ajuste registrado.
  async function esgotar(local: LocalComMarca) {
    if (!profile) return
    setEsgotando(local.id)
    const { data, error: err } = await supabase.rpc('esgotar_recipiente', {
      p_local_id:       local.id,
      p_responsavel_id: profile.id,
      p_empresa_id:     profile.empresa_id,
      p_observacoes:    null,
    })
    setEsgotando(null)
    if (err || !(data as { ok: boolean })?.ok) {
      setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro ao esgotar recipiente.')
      return
    }
    await load()
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

  const casaComBusca = (r: LocalComMarca) =>
    combina(search, nomeExibido(r), r.subtipo)

  /**
   * Três populações diferentes, que a tela tratava como uma só:
   *
   * - os DURÁVEIS: potes e caixas da cozinha, que se cadastram uma vez;
   * - os TEMPORÁRIOS: embalagens do fornecedor que estão no EP agora e somem
   *   quando esvaziam (migration 073) — não se editam nem se excluem;
   * - os INATIVOS: aposentados, que ficam por causa do histórico.
   *
   * Os inativos apareciam misturados aos ativos, sem nada indicando. Pior: o
   * planejador já os ignorava, então a tela mostrava recipientes que a conta da
   * produção não enxergava.
   */
  const efemeros = recipientes.filter(r => r.ativo && r.efemero && casaComBusca(r))
  const inativos = recipientes.filter(r => !r.ativo && casaComBusca(r))
  const filteredRecipientes = recipientes.filter(r =>
    !r.efemero && (r.ativo || mostrarInativos) && casaComBusca(r),
  )

  // Recipientes com insumo, agrupados por insumo_id
  const comInsumo = filteredRecipientes.filter(r => r.insumo_id)
  const genericos = filteredRecipientes.filter(r => !r.insumo_id)

  // Insumos que têm ao menos 1 recipiente
  const insumoIdsComRecipiente = new Set(comInsumo.map(r => r.insumo_id))

  // Insumos sem nenhum recipiente — fora os que não devem ter mesmo, porque
  // ficam na embalagem do fornecedor.
  const insumosSemRecipiente = !search
    ? insumos.filter(i => !insumoIdsComRecipiente.has(i.id) && !semRecipientePorConfig.has(i.id))
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
        <div className="flex items-center gap-2 shrink-0">
          {/* Etiquetar o estoque inteiro de um em um são dezenas de idas e
              voltas; e num rolo de várias colunas cada impressão avulsa ainda
              desperdiça a linha. */}
          <Button
            variant="secondary"
            onClick={() => navigate('/recipientes/etiquetas')}
            disabled={totalRecipientes === 0}
            icon={
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
              </svg>
            }
          >
            Imprimir etiquetas
          </Button>
          <Button onClick={openNew} icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          }>
            Novo Recipiente
          </Button>
        </div>
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

          {/* Aposentados ficam fora por padrão: eles não contam para a produção
              — o planejador já os ignora — e misturados davam a impressão de
              que havia recipiente onde não há. */}
          {inativos.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={mostrarInativos}
                onChange={e => setMostrarInativos(e.target.checked)}
                className="rounded"
              />
              Mostrar {inativos.length} recipiente{inativos.length > 1 ? 's' : ''} desativado
              {inativos.length > 1 ? 's' : ''}
            </label>
          )}

          {/* ── No EP agora: embalagens do fornecedor ──
              Não se editam nem se excluem: a identidade delas é o lote, e a
              etiqueta é a que já está colada desde o recebimento. O que dá para
              fazer é esgotar (o fim de vida) e reimprimir a etiqueta DO LOTE —
              imprimir uma de recipiente criaria a segunda identidade que a
              migration 073 eliminou. */}
          {efemeros.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-800">No EP agora</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {efemeros.length} embalagem{efemeros.length > 1 ? 'ns' : ''} do fornecedor
                  em uso. Somem da lista sozinhas quando você marcar como esgotadas.
                </p>
              </div>
              <ListaResponsiva
                cartoes={efemeros.map(r => (
                  <CartaoRecipiente
                    key={r.id}
                    r={r}
                    conteudo={<ConteudoCell comp={composicao[r.id]} />}
                    acoes={<AcoesTemporario r={r} esgotando={esgotando} esgotar={esgotar} navigate={navigate} />}
                  />
                ))}
                tabela={
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Pacote</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Insumo</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Capacidade</th>
                        <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">Conteúdo</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {efemeros.map(r => (
                        <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-gray-900">{r.nome}</td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">
                            {(r as LocalComMarca & { insumo?: { nome: string } }).insumo?.nome ?? '—'}
                          </td>
                          <td className="px-4 py-2.5 text-gray-600 text-xs">
                            {r.capacidade_max != null
                              ? `${r.capacidade_max} ${r.unidade_capacidade ?? ''}`
                              : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <ConteudoCell comp={composicao[r.id]} />
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <AcoesTemporario r={r} esgotando={esgotando} esgotar={esgotar} navigate={navigate} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                }
              />
            </Card>
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
                  <ListaResponsiva
                    cartoes={recs.map(r => (
                      <CartaoRecipiente
                        key={r.id}
                        r={r}
                        conteudo={<ConteudoCell comp={composicao[r.id]} />}
                        acoes={
                          <>
                            {(composicao[r.id]?.quantidade_total ?? 0) > 0 && (
                              <BotaoEsgotar r={r} esgotando={esgotando} esgotar={esgotar} />
                            )}
                            <RowActions
                              efemero={(r as Local & { efemero?: boolean }).efemero}
                              onEtiqueta={() => navigate(`/recipientes/${r.id}/etiqueta`)}
                              onEditar={() => openEdit(r)}
                              onDuplicar={() => openDuplicate(r)}
                              onExcluir={() => openDelete(r)}
                            />
                          </>
                        }
                      />
                    ))}
                    tabela={
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nome</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Tipo</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Capacidade</th>
                        <th className="text-center px-4 py-2 text-xs font-medium text-gray-500">Conteúdo</th>
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
                            <ConteudoCell comp={composicao[r.id]} />
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {(composicao[r.id]?.quantidade_total ?? 0) > 0 && (
                                <button
                                  onClick={() => esgotar(r)}
                                  disabled={esgotando === r.id}
                                  title="Marcar como esgotado: zera a sobra e encerra a mistura"
                                  className="text-[0.65rem] font-semibold uppercase tracking-wide px-2 py-1 rounded
                                             border border-gray-300 text-gray-600 hover:border-unno-amber hover:text-unno-amber
                                             disabled:opacity-50 dark:border-white/[.08] dark:text-unno-muted"
                                >
                                  {esgotando === r.id ? '...' : 'Esgotar'}
                                </button>
                              )}
                              <RowActions
                                efemero={(r as Local & { efemero?: boolean }).efemero}
                                onEtiqueta={() => navigate(`/recipientes/${r.id}/etiqueta`)}
                                onEditar={() => openEdit(r)}
                                onDuplicar={() => openDuplicate(r)}
                                onExcluir={() => openDelete(r)}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                    }
                  />
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
                  <ListaResponsiva
                    cartoes={genericos.map(r => (
                      <CartaoRecipiente
                        key={r.id}
                        r={r}
                        conteudo={
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            r.ativo ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {r.ativo ? 'Ativo' : 'Inativo'}
                          </span>
                        }
                        rotuloConteudo="Status"
                        acoes={
                          <RowActions
                            efemero={(r as Local & { efemero?: boolean }).efemero}
                            onEtiqueta={() => navigate(`/recipientes/${r.id}/etiqueta`)}
                            onEditar={() => openEdit(r)}
                            onDuplicar={() => openDuplicate(r)}
                            onExcluir={() => openDelete(r)}
                          />
                        }
                      />
                    ))}
                    tabela={
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
                              efemero={(r as Local & { efemero?: boolean }).efemero}
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
                    }
                  />
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
                  type="number" inputMode="decimal"
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
                type="number" inputMode="decimal"
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

/**
 * O que se pode fazer com uma embalagem do fornecedor que está no EP.
 *
 * Editar e excluir não entram: ela não é um bem cadastrado, é um lote que está
 * na bancada — mexer no nome ou apagar a linha desencontraria do lote. E a
 * etiqueta é a DO LOTE, que já foi impressa no recebimento; gerar uma de
 * recipiente recriaria a segunda identidade que a migration 073 eliminou.
 */
function AcoesTemporario({ r, esgotando, esgotar, navigate }: {
  r: LocalComMarca
  esgotando: string | null
  esgotar: (r: LocalComMarca) => void
  navigate: (to: string) => void
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {r.origem_lote_id && (
        <button
          onClick={() => navigate(`/recebimento/imprimir/${r.origem_lote_id}`)}
          className="text-gray-500 hover:text-gray-700 text-xs font-medium"
        >
          Etiqueta do lote
        </button>
      )}
      <BotaoEsgotar r={r} esgotando={esgotando} esgotar={esgotar} />
    </div>
  )
}

// ── Sub-component para botões de ação de cada linha ──────────

function RowActions({
  onEtiqueta,
  onEditar,
  onDuplicar,
  onExcluir,
  efemero,
}: {
  onEtiqueta: () => void
  onEditar: () => void
  onDuplicar: () => void
  onExcluir: () => void
  /** Embalagem do fornecedor: já tem a etiqueta do lote colada. */
  efemero?: boolean
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {/* Imprimir etiqueta para a embalagem do fornecedor criaria uma segunda
          identidade para o mesmo balde — o defeito que a migration 073 tirou. */}
      {!efemero && (
        <button onClick={onEtiqueta} className="text-gray-500 hover:text-gray-700 text-xs font-medium">
          Etiqueta
        </button>
      )}
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

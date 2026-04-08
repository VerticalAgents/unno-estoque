import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Insumo, Lote, Local, MotivoPerdaEnum } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { today, formatDate } from '../../lib/utils'

const MOTIVOS: { value: MotivoPerdaEnum; label: string }[] = [
  { value: 'vencimento', label: 'Vencimento' },
  { value: 'embalagem_danificada', label: 'Embalagem danificada' },
  { value: 'contaminacao', label: 'Contaminação' },
  { value: 'queda_acidente', label: 'Queda / Acidente' },
  { value: 'qualidade_reprovada', label: 'Qualidade reprovada' },
  { value: 'outro', label: 'Outro' },
]

export function NovaPerdaPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [lotes, setLotes] = useState<Lote[]>([])
  const [locais, setLocais] = useState<Local[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    insumo_id: '',
    lote_id: '',
    local_id: '',
    data: today(),
    quantidade: '',
    motivo: '' as MotivoPerdaEnum | '',
    descricao: '',
  })

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

  // Load lotes ativos when insumo changes
  useEffect(() => {
    if (!form.insumo_id || !profile) {
      setLotes([])
      setForm((prev) => ({ ...prev, lote_id: '' }))
      return
    }
    supabase
      .from('lotes')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .eq('insumo_id', form.insumo_id)
      .eq('status', 'ativo')
      .order('validade_pos_abertura')
      .then(({ data }) => {
        setLotes((data ?? []) as Lote[])
        setForm((prev) => ({ ...prev, lote_id: '' }))
      })
  }, [form.insumo_id, profile])

  // Load locais EP when insumo changes
  useEffect(() => {
    if (!form.insumo_id || !profile) {
      setLocais([])
      setForm((prev) => ({ ...prev, local_id: '' }))
      return
    }
    supabase
      .from('locais')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .eq('insumo_id', form.insumo_id)
      .eq('ativo', true)
      .order('nome')
      .then(({ data }) => {
        setLocais((data ?? []) as Local[])
        setForm((prev) => ({ ...prev, local_id: '' }))
      })
  }, [form.insumo_id, profile])

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const selectedInsumo = insumos.find((i) => i.id === form.insumo_id)
  const selectedLote = lotes.find((l) => l.id === form.lote_id)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.insumo_id || !form.lote_id || !form.quantidade || !form.motivo) {
      setError('Preencha todos os campos obrigatórios.')
      return
    }
    setError('')
    setLoading(true)

    const { data, error: rpcError } = await supabase.rpc('registrar_perda_insumo', {
      p_empresa_id:     profile.empresa_id,
      p_lote_id:        form.lote_id,
      p_insumo_id:      form.insumo_id,
      p_local_id:       form.local_id || null,
      p_quantidade:     parseFloat(form.quantidade),
      p_unidade:        selectedInsumo?.unidade_medida ?? 'kg',
      p_motivo:         form.motivo,
      p_descricao:      form.descricao || null,
      p_responsavel_id: profile.id,
    })

    setLoading(false)
    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao registrar perda.')
      return
    }
    navigate('/perdas')
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/perdas')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Registrar Perda</h1>
        <p className="text-sm text-gray-500 mt-0.5">Descarte de insumo por motivo externo à produção</p>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="p-5 space-y-4">
          <Select
            label="Insumo"
            required
            value={form.insumo_id}
            onChange={(e) => set('insumo_id', e.target.value)}
          >
            <option value="">Selecionar insumo...</option>
            {insumos.map((i) => (
              <option key={i.id} value={i.id}>{i.codigo} — {i.nome}</option>
            ))}
          </Select>

          {form.insumo_id && (
            <Select
              label="Lote"
              required
              value={form.lote_id}
              onChange={(e) => set('lote_id', e.target.value)}
            >
              <option value="">Selecionar lote...</option>
              {lotes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.codigo} — Disp: {l.quantidade_disponivel} {l.unidade} · Val: {formatDate(l.validade_pos_abertura)}
                </option>
              ))}
              {lotes.length === 0 && <option disabled>Nenhum lote ativo para este insumo</option>}
            </Select>
          )}

          {selectedLote && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              Disponível: <strong>{selectedLote.quantidade_disponivel} {selectedLote.unidade}</strong>
              {' · '}Validade: <strong>{formatDate(selectedLote.validade_pos_abertura)}</strong>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label={`Quantidade${selectedInsumo ? ` (${selectedInsumo.unidade_medida})` : ''}`}
              type="number"
              step="0.001"
              min="0.001"
              required
              value={form.quantidade}
              onChange={(e) => set('quantidade', e.target.value)}
              placeholder="0.000"
            />
            <Input
              label="Data"
              type="date"
              required
              value={form.data}
              onChange={(e) => set('data', e.target.value)}
            />
          </div>

          <Select
            label="Motivo"
            required
            value={form.motivo}
            onChange={(e) => set('motivo', e.target.value)}
          >
            <option value="">Selecionar motivo...</option>
            {MOTIVOS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>

          {locais.length > 0 && (
            <Select
              label="Local (onde estava o insumo)"
              value={form.local_id}
              onChange={(e) => set('local_id', e.target.value)}
            >
              <option value="">Não informar</option>
              {locais.map((l) => (
                <option key={l.id} value={l.id}>{l.nome}</option>
              ))}
            </Select>
          )}

          <Textarea
            label="Descrição / Observações"
            value={form.descricao}
            onChange={(e) => set('descricao', e.target.value)}
            placeholder="Descreva o ocorrido..."
          />
        </Card>

        {error && (
          <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/perdas')}>
            Cancelar
          </Button>
          <Button type="submit" variant="danger" size="lg" fullWidth loading={loading}>
            Registrar Perda
          </Button>
        </div>
      </form>
    </div>
  )
}

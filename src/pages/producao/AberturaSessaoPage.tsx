import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

interface FichaOption {
  id: string
  codigo: string
  nome: string
  versao_id: string
  rendimento_fornada: number
  peso_medio_g: number | null
}

export function AberturaSessaoPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<{ codigo: string; locais: number; planejada: number } | null>(null)

  const [fichaId, setFichaId] = useState('')
  const [multiplicador, setMultiplicador] = useState('1')
  const [dataProducao, setDataProducao] = useState(new Date().toISOString().split('T')[0])
  const [observacoes, setObservacoes] = useState('')

  useEffect(() => {
    if (!profile) return
    // Load active fichas that have rendimento_fornada set
    supabase
      .from('fichas_tecnicas')
      .select(`
        id, codigo, nome,
        versoes:fichas_tecnicas_versoes!inner(id, rendimento_fornada, peso_medio_g, ativa)
      `)
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .then(({ data }) => {
        const opts: FichaOption[] = []
        for (const f of (data ?? []) as unknown as { id: string; codigo: string; nome: string; versoes: { id: string; rendimento_fornada: number | null; peso_medio_g: number | null; ativa: boolean }[] }[]) {
          // Get active version with rendimento
          const versaoAtiva = f.versoes.find((v) => v.ativa && v.rendimento_fornada != null)
          if (versaoAtiva?.rendimento_fornada) {
            opts.push({
              id: f.id,
              codigo: f.codigo,
              nome: f.nome,
              versao_id: versaoAtiva.id,
              rendimento_fornada: versaoAtiva.rendimento_fornada,
              peso_medio_g: versaoAtiva.peso_medio_g ?? null,
            })
          }
        }
        setFichas(opts)
      })
  }, [profile])

  const fichaSelected = fichas.find((f) => f.id === fichaId)
  const mult = parseInt(multiplicador) || 1
  const unidadesPlanejadas = fichaSelected ? fichaSelected.rendimento_fornada * mult : 0

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return

    if (!fichaId) { setError('Selecione uma ficha técnica.'); return }
    if (!fichaSelected) { setError('Ficha inválida.'); return }
    if (mult < 1) { setError('Número de fornadas deve ser pelo menos 1.'); return }

    setError('')
    setLoading(true)

    const { data, error: rpcError } = await supabase.rpc('abrir_sessao_producao', {
      p_empresa_id:       profile.empresa_id,
      p_responsavel_id:   profile.id,
      p_data_producao:    dataProducao,
      p_ficha_tecnica_id: fichaId,
      p_ficha_versao_id:  fichaSelected.versao_id,
      p_multiplicador:    mult,
      p_observacoes:      observacoes || null,
    })

    setLoading(false)
    if (rpcError || !(data as { ok: boolean })?.ok) {
      setError(rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao abrir sessão.')
      return
    }

    const result = data as { codigo: string; locais_vinculados: number; quantidade_planejada: number }
    setSuccess({
      codigo: result.codigo,
      locais: result.locais_vinculados,
      planejada: result.quantidade_planejada,
    })
  }

  if (success) {
    return (
      <div className="p-4 sm:p-6 max-w-lg mx-auto">
        <div className="text-center py-10">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Sessão aberta!</h2>
          <p className="text-gray-600 mb-1">
            <span className="font-mono font-semibold">{success.codigo}</span> — {success.planejada} unidades planejadas
          </p>
          <p className="text-sm text-gray-500 mb-6">
            {success.locais > 0
              ? `${success.locais} recipiente(s) EP vinculado(s) automaticamente.`
              : 'Nenhum recipiente EP com estoque encontrado para esta ficha.'}
          </p>
          <Button onClick={() => navigate('/producao')} fullWidth size="lg">
            Ver sessões
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/producao')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Abrir Sessão de Produção</h1>
        <p className="text-sm text-gray-500 mt-0.5">Uma sessão por dia — uma ficha por sessão</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card className="p-5 space-y-4">
          <Input
            label="Data de produção"
            type="date"
            required
            value={dataProducao}
            onChange={(e) => setDataProducao(e.target.value)}
          />

          <Select
            label="Ficha técnica"
            required
            value={fichaId}
            onChange={(e) => setFichaId(e.target.value)}
          >
            <option value="">Selecionar ficha...</option>
            {fichas.map((f) => (
              <option key={f.id} value={f.id}>
                {f.codigo} — {f.nome} ({f.rendimento_fornada} un/fornada)
              </option>
            ))}
          </Select>

          {fichas.length === 0 && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2">
              Nenhuma ficha com rendimento cadastrado. Cadastre o rendimento nas fichas técnicas antes de abrir uma sessão.
            </p>
          )}

          {fichaSelected && (
            <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600">
              Rendimento: <strong>{fichaSelected.rendimento_fornada}</strong> un/fornada
              {fichaSelected.peso_medio_g && <> · Peso médio: <strong>{fichaSelected.peso_medio_g}g</strong></>}
            </div>
          )}

          <Input
            label="Número de fornadas"
            type="number"
            min="1"
            step="1"
            required
            value={multiplicador}
            onChange={(e) => setMultiplicador(e.target.value)}
            hint={fichaSelected && mult >= 1
              ? `${mult} fornada(s) × ${fichaSelected.rendimento_fornada} un = ${unidadesPlanejadas} unidades planejadas`
              : undefined}
          />

          <Textarea
            label="Observações (opcional)"
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={2}
            placeholder="Ex: produção de Natal, 3 fornos simultâneos..."
          />
        </Card>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/producao')}>
            Cancelar
          </Button>
          <Button type="submit" size="lg" fullWidth loading={loading} disabled={!fichaId}>
            Abrir sessão
          </Button>
        </div>
      </form>
    </div>
  )
}

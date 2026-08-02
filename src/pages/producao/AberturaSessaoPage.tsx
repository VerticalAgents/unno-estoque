import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Input, Textarea } from '../../components/ui/Input'
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

/**
 * Uma sessão pode ter mais de uma ficha: a fábrica mistura receitas no mesmo
 * dia ("24 formas de Tradicional + 20 de Doce de Leite"). Cada ficha entra
 * com a sua quantidade de formas; 1 forma = 1 fornada da ficha.
 *
 * Pode chegar aqui já preenchido pelo Planejador de Recipientes, via
 * navigate('/producao/abrir', { state: { formas } }).
 */
export function AberturaSessaoPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const formasIniciais = (location.state as { formas?: Record<string, string> } | null)?.formas
  // A mesma tela serve para abrir e para editar: com :id na rota, está editando
  // uma sessão já aberta (/producao/:id/editar).
  const { id: sessaoEditandoId } = useParams<{ id: string }>()
  const editando = !!sessaoEditandoId

  const [fichas, setFichas] = useState<FichaOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<{ codigo: string; locais: number; planejada: number } | null>(null)

  const [formas, setFormas] = useState<Record<string, string>>(formasIniciais ?? {})
  // Trava sessao_sem_insumo: lista o que falta em vez de só recusar.
  // O modo decide a tela: em `bloqueia` não há caminho para a frente, então
  // não faz sentido mostrar campo de motivo nem botão de abrir.
  const [faltantes, setFaltantes] = useState<
    { codigo: string; nome: string; falta: number; unidade: string }[] | null
  >(null)
  const [travaModo, setTravaModo] = useState<'bloqueia' | 'avisa' | null>(null)
  const [justificativa, setJustificativa] = useState('')

  const bloqueado = travaModo === 'bloqueia'
  const faltaJustificar = travaModo === 'avisa' && justificativa.trim().length < 5

  // Mexeu nas formas: o diagnóstico anterior não vale mais.
  function mudarFormas(fichaId: string, valor: string) {
    setFormas(s => ({ ...s, [fichaId]: valor }))
    if (faltantes) {
      setFaltantes(null)
      setTravaModo(null)
      setError('')
    }
  }
  const [dataProducao, setDataProducao] = useState(new Date().toISOString().split('T')[0])
  const [observacoes, setObservacoes] = useState('')

  useEffect(() => {
    if (!profile) return
    // Só fichas ativas que têm rendimento cadastrado — sem ele não dá para
    // saber quantas unidades saem de uma forma.
    supabase
      .from('fichas_tecnicas')
      .select(`
        id, codigo, nome,
        versoes:fichas_tecnicas_versoes!inner(id, rendimento_fornada, peso_medio_g, ativa)
      `)
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .order('codigo')
      .then(({ data }) => {
        const opts: FichaOption[] = []
        for (const f of (data ?? []) as unknown as { id: string; codigo: string; nome: string; versoes: { id: string; rendimento_fornada: number | null; peso_medio_g: number | null; ativa: boolean }[] }[]) {
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

  // Modo edição: carrega as formas que a sessão já tem
  useEffect(() => {
    if (!sessaoEditandoId) return
    supabase
      .from('sessoes_producao_skus')
      .select('ficha_tecnica_id, multiplicador')
      .eq('sessao_id', sessaoEditandoId)
      .then(({ data }) => {
        setFormas(
          Object.fromEntries(
            (data ?? []).map(r => [r.ficha_tecnica_id, String(r.multiplicador ?? 0)]),
          ),
        )
      })
  }, [sessaoEditandoId])

  const plano = fichas
    .map((f) => ({ ficha: f, formas: parseInt(formas[f.id] ?? '') || 0 }))
    .filter((p) => p.formas > 0)

  const totalFormas = plano.reduce((s, p) => s + p.formas, 0)
  const totalUnidades = plano.reduce((s, p) => s + p.formas * p.ficha.rendimento_fornada, 0)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return

    if (plano.length === 0) {
      setError('Informe a quantidade de formas de pelo menos uma ficha.')
      return
    }

    setError('')
    setLoading(true)

    // Editando: só recalcula o plano. Não mexe em quantidade_inicial dos
    // recipientes — é a foto do que havia neles quando a sessão abriu, e é
    // dela que sai o consumo real no fechamento.
    if (editando) {
      const { data, error: err } = await supabase.rpc('atualizar_plano_sessao', {
        p_sessao_id:  sessaoEditandoId,
        p_empresa_id: profile.empresa_id,
        p_plano:      plano.map(p => ({
          ficha_id: p.ficha.id, versao_id: p.ficha.versao_id, formas: p.formas,
        })),
      })
      setLoading(false)
      if (err || !(data as { ok: boolean })?.ok) {
        setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro ao atualizar.')
        return
      }
      navigate('/producao')
      return
    }

    const { data, error: rpcError } = await supabase.rpc('abrir_sessao_producao_v2', {
      p_empresa_id:     profile.empresa_id,
      p_responsavel_id: profile.id,
      p_data_producao:  dataProducao,
      p_plano:          plano.map((p) => ({
        ficha_id:  p.ficha.id,
        versao_id: p.ficha.versao_id,
        formas:    p.formas,
      })),
      p_observacoes:    observacoes || null,
      p_justificativa:  justificativa.trim() || null,
    })

    setLoading(false)

    const resp = data as {
      ok: boolean; trava?: string; modo?: string; mensagem?: string; erro?: string
      faltantes?: { codigo: string; nome: string; falta: number; unidade: string }[]
    } | null

    // Insumo insuficiente: mostra o que falta e oferece ir ao planejador,
    // em vez de deixar a produção parar no meio para abastecer.
    if (resp?.trava === 'sessao_sem_insumo') {
      setFaltantes(resp.faltantes ?? [])
      setTravaModo(resp.modo === 'bloqueia' ? 'bloqueia' : 'avisa')
      setError(resp.mensagem ?? '')
      return
    }

    if (rpcError || !resp?.ok) {
      setError(rpcError?.message ?? resp?.erro ?? 'Erro ao abrir sessão.')
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
          <div className="w-16 h-16 bg-brand-500/15 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-brand-600 dark:text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-unno-text mb-2">Sessão aberta!</h2>
          <p className="text-gray-600 dark:text-unno-muted mb-1">
            <span className="font-mono font-semibold">{success.codigo}</span> — {success.planejada} unidades planejadas
          </p>
          <p className="text-sm text-gray-500 dark:text-unno-muted mb-6">
            {success.locais > 0
              ? `${success.locais} recipiente(s) EP vinculado(s) automaticamente.`
              : 'Nenhum recipiente EP com estoque encontrado para estas fichas.'}
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
          className="text-sm text-gray-500 hover:text-gray-700 dark:text-unno-muted flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900 dark:text-unno-text">
          {editando ? 'Editar formas da sessão' : 'Abrir Sessão de Produção'}
        </h1>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
          {editando
            ? 'Muda o planejado e o consumo teórico. O que já estava nos recipientes não é alterado.'
            : 'Uma sessão por dia — pode misturar fichas'}
        </p>
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

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted">
              Formas por ficha
            </p>

            {fichas.length === 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 dark:bg-unno-amber/10 dark:text-unno-amber rounded px-3 py-2">
                Nenhuma ficha com rendimento cadastrado. Cadastre o rendimento nas fichas
                técnicas antes de abrir uma sessão.
              </p>
            )}

            {fichas.map((f) => (
              <div key={f.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text truncate">
                    {f.codigo} — {f.nome}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-unno-dim">
                    {f.rendimento_fornada} un/forma
                    {f.peso_medio_g && <> · {f.peso_medio_g} g/un</>}
                  </p>
                </div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={formas[f.id] ?? ''}
                  onChange={(e) => mudarFormas(f.id, e.target.value)}
                  placeholder="0"
                  className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                             focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                             dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
                />
              </div>
            ))}

            {totalFormas > 0 && (
              <div className="bg-gray-50 dark:bg-white/[.03] rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-unno-muted">
                {totalFormas} forma(s) — <strong>{totalUnidades}</strong> unidades planejadas
                {plano.length > 1 && <> · {plano.length} fichas na mesma sessão</>}
              </div>
            )}
          </div>

          <Textarea
            label="Observações (opcional)"
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={2}
            placeholder="Ex: produção de Natal, 3 fornos simultâneos..."
          />
        </Card>

        {/* Insumo insuficiente: o problema é resolvível, então a tela mostra o
            que falta e leva ao planejador já preenchido — em vez de só recusar.
            Em modo `bloqueia` some o campo de motivo: não existe caminho para a
            frente, e oferecer um seria mentir para o operador. */}
        {faltantes && (
          <div className={`rounded-xl border p-4 space-y-3 ${
            bloqueado
              ? 'border-red-300 bg-red-50 dark:border-unno-danger/40 dark:bg-unno-danger/10'
              : 'border-unno-amber/40 bg-unno-amber/10'
          }`}>
            <div>
              <p className="font-medium text-gray-900 dark:text-unno-text">
                {bloqueado
                  ? 'Não dá para abrir a sessão: falta insumo'
                  : 'Falta insumo nos recipientes'}
              </p>
              <p className="text-sm text-gray-600 dark:text-unno-muted mt-0.5">
                {bloqueado
                  ? 'Abasteça os recipientes antes de abrir. A regra está como "Bloqueia" em Configurações → Travas.'
                  : 'Se abrir assim, a produção para no meio para abastecer.'}
              </p>
            </div>

            <div className="max-h-44 overflow-y-auto space-y-1">
              {faltantes.map(f => (
                <div key={f.codigo} className="flex justify-between text-xs">
                  <span className="text-gray-700 dark:text-unno-text truncate">
                    <span className="text-gray-400 mr-1.5">{f.codigo}</span>
                    {f.nome}
                  </span>
                  <span className="tabular-nums text-gray-900 dark:text-unno-text whitespace-nowrap ml-3">
                    faltam {f.falta.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} {f.unidade}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => navigate('/producao/planejador', { state: { formas } })}
              >
                Ver o que abastecer
              </Button>
            </div>

            {/* Só em modo "avisa": aí dá para seguir assumindo o risco, desde
                que explique. */}
            {!bloqueado && (
            <div className="pt-2 border-t border-unno-amber/30">
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-unno-muted">
                Abrir mesmo assim? Explique por quê
              </label>
              <textarea
                rows={2}
                value={justificativa}
                onChange={e => setJustificativa(e.target.value)}
                placeholder="Ex: o abastecimento será feito durante a primeira fornada"
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                           focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                           dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
              />
              <p className="text-[0.7rem] text-gray-500 dark:text-unno-muted mt-1">
                {faltaJustificar
                  ? 'Escreva pelo menos algumas palavras para liberar o botão.'
                  : 'Fica registrado em Configurações → Travas, com seu nome.'}
              </p>
            </div>
            )}
          </div>
        )}

        {error && !faltantes && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700
                          dark:bg-unno-danger/10 dark:border-unno-danger/30 dark:text-unno-danger">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/producao')}>
            Cancelar
          </Button>
          {/* Em `bloqueia` o botão sai da tela: insistir nele não leva a lugar
              nenhum, e um botão que não faz nada parece defeito. */}
          {!bloqueado && (
            <Button
              type="submit"
              size="lg"
              fullWidth
              loading={loading}
              disabled={plano.length === 0 || faltaJustificar}
            >
              {editando
                ? 'Salvar formas'
                : travaModo === 'avisa'
                  ? 'Abrir mesmo assim'
                  : 'Abrir sessão'}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

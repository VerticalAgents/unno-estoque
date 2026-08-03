import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import type { ContagemInsumo, ContagemEpLocal, StatusFisico } from '../../types/contagem'
import { bancada, daBancada, emBancada, usaTara } from '../../lib/unidades'

type InsumoJoined = ContagemInsumo & {
  insumo: { nome: string; codigo: string; unidade_medida: string }
}

/**
 * UNIDADES NESTA TELA — a confusão aqui inflava o estoque em mil vezes.
 *
 * `contagem_ep_locais.peso_bruto` e `peso_tara` são em GRAMAS: é peso de
 * recipiente, mesma convenção de `locais.peso_tara`.
 *
 * `qtd_liquida` e `qtd_estado_atual` são na UNIDADE DO INSUMO (kg, quase
 * sempre), porque `aplicar_contagem` entrega `qtd_liquida` direto a
 * `ajustar_conteudo_recipiente`, que escreve em `locais_lotes`.
 *
 * Converter na fronteira, portanto: a balança fala grama, o banco fala quilo.
 */

export function NovaContagemEpPage() {
  const { id } = useParams<{ id: string }>()
  useAuth()
  const navigate = useNavigate()

  const [itens, setItens] = useState<InsumoJoined[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [locais, setLocais] = useState<ContagemEpLocal[]>([])
  const [loading, setLoading] = useState(true)
  const [scanError, setScanError] = useState('')
  const [saving, setSaving] = useState(false)

  // Local sendo configurado (após scan)
  const [activeLocalId, setActiveLocalId] = useState<string | null>(null)
  const [pesoBruto, setPesoBruto] = useState('')
  const [taraInput, setTaraInput] = useState('')
  const [showTaraPrompt, setShowTaraPrompt] = useState(false)

  useEffect(() => {
    if (!id) return
    supabase
      .from('contagem_insumos')
      .select('*, insumo:insumos(nome, codigo, unidade_medida)')
      .eq('contagem_id', id)
      .order('created_at')
      .then(({ data }) => {
        const items = (data ?? []) as unknown as InsumoJoined[]
        setItens(items)
        const idx = items.findIndex(i => i.status !== 'finalizado')
        setCurrentIdx(idx >= 0 ? idx : items.length)
        setLoading(false)
      })
  }, [id])

  const currentItem = itens[currentIdx]
  // A balança fala a unidade da bancada; o banco, a do cadastro.
  const unidade = currentItem?.insumo?.unidade_medida ?? ''
  const b = bancada(unidade)

  useEffect(() => {
    if (!currentItem) return
    supabase
      .from('contagem_ep_locais')
      .select('*')
      .eq('contagem_insumo_id', currentItem.id)
      .order('local_nome')
      .then(({ data }) => {
        setLocais((data ?? []) as ContagemEpLocal[])
      })

    if (currentItem.status === 'pendente') {
      supabase.from('contagem_insumos').update({ status: 'em_contagem' }).eq('id', currentItem.id)
    }

    // Reset state
    setActiveLocalId(null)
    setPesoBruto('')
    setScanError('')
  }, [currentItem?.id])

  async function handleScan(qrValue: string) {
    setScanError('')
    setActiveLocalId(null)
    setPesoBruto('')
    setShowTaraPrompt(false)

    // Busca o local pelo QR code fixo
    const { data: localData } = await supabase
      .from('locais')
      .select('id, qr_code_fixo')
      .eq('qr_code_fixo', qrValue)
      .single()

    if (!localData) {
      setScanError('QR code não reconhecido como recipiente.')
      return
    }

    const localMatch = locais.find(l => l.local_id === localData.id)
    if (!localMatch) {
      setScanError('Este recipiente não pertence ao insumo atual.')
      return
    }

    if (localMatch.escaneado) {
      setScanError('Este recipiente já foi escaneado.')
      return
    }

    // Tara só faz sentido onde se pesa. Em insumo medido em mL ou unidade o
    // operador informa o conteúdo direto, sem descontar recipiente.
    if (usaTara(unidade) && !localMatch.peso_tara) {
      setShowTaraPrompt(true)
      setTaraInput('')
    }

    setActiveLocalId(localMatch.id)
  }

  async function salvarTara() {
    if (!activeLocalId || !taraInput) return
    const tara = parseFloat(taraInput)
    if (isNaN(tara) || tara < 0) return

    const localItem = locais.find(l => l.id === activeLocalId)
    if (!localItem) return

    // Salva no locais (tabela principal)
    await supabase.from('locais').update({ peso_tara: tara }).eq('id', localItem.local_id)

    // Atualiza no registro da contagem
    await supabase.from('contagem_ep_locais').update({ peso_tara: tara }).eq('id', activeLocalId)

    setLocais(prev => prev.map(l => l.id === activeLocalId ? { ...l, peso_tara: tara } : l))
    setShowTaraPrompt(false)
  }

  async function selecionarStatus(status: StatusFisico) {
    if (!activeLocalId) return
    const localItem = locais.find(l => l.id === activeLocalId)
    if (!localItem) return

    if (status === 'usado') {
      // Não salva ainda, espera o peso
      setLocais(prev => prev.map(l => l.id === activeLocalId ? { ...l, status_fisico: 'usado' } : l))
      return
    }

    // Cheio ou vazio: salva direto
    await supabase.from('contagem_ep_locais').update({
      status_fisico: status,
      escaneado: true,
      peso_bruto: null,
      qtd_liquida: null,
    }).eq('id', activeLocalId)

    setLocais(prev => prev.map(l =>
      l.id === activeLocalId ? { ...l, status_fisico: status, escaneado: true } : l
    ))
    setActiveLocalId(null)
  }

  async function salvarPeso() {
    if (!activeLocalId || !pesoBruto) return
    const peso = parseFloat(pesoBruto)
    if (isNaN(peso) || peso < 0) return

    const localItem = locais.find(l => l.id === activeLocalId)
    if (!localItem) return

    // Peso e tara vêm da balança, em gramas. `qtd_liquida` vai para o banco na
    // unidade do insumo — era aqui que 4,8 kg viravam 4800 e o estoque físico
    // saía mil vezes maior.
    const tara = usaTara(unidade) ? (localItem.peso_tara ?? 0) : 0
    const liquidoNaBalanca = Math.max(0, peso - tara)
    const liquido = daBancada(liquidoNaBalanca, b.fator)

    await supabase.from('contagem_ep_locais').update({
      status_fisico: 'usado',
      escaneado: true,
      peso_bruto: peso,
      qtd_liquida: liquido,
    }).eq('id', activeLocalId)

    setLocais(prev => prev.map(l =>
      l.id === activeLocalId ? { ...l, status_fisico: 'usado' as const, escaneado: true, peso_bruto: peso, qtd_liquida: liquido } : l
    ))
    setActiveLocalId(null)
    setPesoBruto('')
  }

  async function finalizarInsumo() {
    if (!currentItem) return
    setSaving(true)

    // Busca capacidade dos locais para calcular 'cheio'
    const localIds = locais.map(l => l.local_id)
    const { data: locaisData } = await supabase
      .from('locais')
      .select('id, capacidade_max')
      .in('id', localIds)

    const capacidadeMap = new Map<string, number>()
    ;(locaisData ?? []).forEach((l: { id: string; capacidade_max: number | null }) => {
      capacidadeMap.set(l.id, l.capacidade_max ?? 0)
    })

    let qtdFisica = 0
    for (const local of locais) {
      if (!local.escaneado) {
        qtdFisica += local.qtd_estado_atual // mantém teórico
      } else if (local.status_fisico === 'cheio') {
        qtdFisica += capacidadeMap.get(local.local_id) ?? 0
      } else if (local.status_fisico === 'vazio') {
        qtdFisica += 0
      } else if (local.status_fisico === 'usado') {
        qtdFisica += local.qtd_liquida ?? 0
      }
    }

    await supabase.from('contagem_insumos').update({
      status: 'finalizado',
      qtd_fisica: qtdFisica,
    }).eq('id', currentItem.id)

    setItens(prev => prev.map((item, idx) =>
      idx === currentIdx ? { ...item, status: 'finalizado' as const, qtd_fisica: qtdFisica } : item
    ))

    const nextIdx = currentIdx + 1
    if (nextIdx >= itens.length) {
      await supabase.from('contagens').update({
        status: 'finalizada',
        finalizada_at: new Date().toISOString(),
      }).eq('id', id)

      navigate(`/contagem/resumo/${id}`)
    } else {
      setCurrentIdx(nextIdx)
      setLocais([])
    }
    setSaving(false)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (currentIdx >= itens.length) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500">Contagem EP finalizada.</p>
        <Link to={`/contagem/resumo/${id}`} className="text-brand-600 text-sm mt-2 inline-block">Ver resumo</Link>
      </div>
    )
  }

  const escaneados = locais.filter(l => l.escaneado).length
  const totalLocais = locais.length
  const finalizados = itens.filter(i => i.status === 'finalizado').length
  const activeLocal = locais.find(l => l.id === activeLocalId)

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="mb-4">
        <Link to="/contagem" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Contagem
        </Link>
        <h1 className="text-lg font-bold text-gray-900">Contagem EP</h1>

        <div className="flex items-center gap-2 mt-2">
          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-600 rounded-full transition-all"
              style={{ width: `${((finalizados) / itens.length) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 whitespace-nowrap">{finalizados + 1} de {itens.length}</span>
        </div>
      </div>

      {/* Insumo atual */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="font-semibold text-gray-900">{currentItem.insumo.nome}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {currentItem.insumo.codigo} · Recipientes: {totalLocais} · Escaneados: {escaneados}
        </p>
      </div>

      {/* Lista de recipientes */}
      <div className="space-y-2 mb-4">
        {locais.map(local => (
          <div
            key={local.id}
            className={[
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm',
              local.escaneado
                ? local.status_fisico === 'cheio' ? 'bg-emerald-50 border-emerald-200'
                : local.status_fisico === 'vazio' ? 'bg-red-50 border-red-200'
                : 'bg-amber-50 border-amber-200'
                : local.id === activeLocalId ? 'bg-blue-50 border-blue-300'
                : 'bg-gray-50 border-gray-200',
            ].join(' ')}
          >
            <div>
              <span className={local.escaneado ? 'font-medium' : 'text-gray-600'}>
                {local.local_nome}
              </span>
              {local.escaneado && local.status_fisico && (
                <span className={[
                  'ml-2 text-xs font-medium',
                  local.status_fisico === 'cheio' ? 'text-emerald-700'
                    : local.status_fisico === 'vazio' ? 'text-red-700'
                    : 'text-amber-700',
                ].join(' ')}>
                  {local.status_fisico === 'cheio' ? 'Cheio'
                    : local.status_fisico === 'vazio' ? 'Vazio'
                    : `Usado (${local.qtd_liquida?.toFixed(0)}g)`}
                </span>
              )}
            </div>
            {local.escaneado ? (
              <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <span className="text-xs text-gray-400">Pendente</span>
            )}
          </div>
        ))}
      </div>

      {/* Painel de configuração do local ativo */}
      {activeLocal && !activeLocal.escaneado && (
        <div className="bg-white border-2 border-blue-300 rounded-xl p-4 mb-4">
          <h3 className="font-semibold text-gray-900 text-sm mb-3">{activeLocal.local_nome}</h3>

          {/* Prompt de tara se necessário */}
          {showTaraPrompt && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
              <p className="text-xs text-amber-800 font-medium mb-2">Tara não cadastrada para este recipiente</p>
              <div className="flex gap-2">
                <Input
                  type="number" inputMode="decimal"
                  step="1"
                  min="0"
                  value={taraInput}
                  onChange={e => setTaraInput(e.target.value)}
                  placeholder={`Peso do recipiente vazio (${b.rotulo})`}
                />
                <Button size="sm" onClick={salvarTara} disabled={!taraInput}>
                  Salvar
                </Button>
              </div>
            </div>
          )}

          {/* Botões de status */}
          {(!showTaraPrompt || activeLocal.peso_tara > 0) && (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <button
                  onClick={() => selecionarStatus('cheio')}
                  className={[
                    'py-3 rounded-lg text-sm font-medium border-2 transition-colors',
                    activeLocal.status_fisico === 'cheio'
                      ? 'bg-emerald-100 border-emerald-400 text-emerald-800'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50',
                  ].join(' ')}
                >
                  Cheio
                </button>
                <button
                  onClick={() => selecionarStatus('vazio')}
                  className={[
                    'py-3 rounded-lg text-sm font-medium border-2 transition-colors',
                    activeLocal.status_fisico === 'vazio'
                      ? 'bg-red-100 border-red-400 text-red-800'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50',
                  ].join(' ')}
                >
                  Vazio
                </button>
                <button
                  onClick={() => selecionarStatus('usado')}
                  className={[
                    'py-3 rounded-lg text-sm font-medium border-2 transition-colors',
                    activeLocal.status_fisico === 'usado'
                      ? 'bg-amber-100 border-amber-400 text-amber-800'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50',
                  ].join(' ')}
                >
                  Usado
                </button>
              </div>

              {/* Input de peso para "usado" */}
              {activeLocal.status_fisico === 'usado' && (
                <div className="space-y-2">
                  <Input
                    label={usaTara(unidade)
                      ? `Peso na balança, com recipiente (${b.rotulo})`
                      : `Conteúdo do recipiente (${b.rotulo})`}
                    type="number" inputMode="decimal"
                    step={b.fator === 1 ? '0.001' : '1'}
                    min="0"
                    value={pesoBruto}
                    onChange={e => setPesoBruto(e.target.value)}
                    placeholder={usaTara(unidade) ? 'Peso na balança com recipiente' : 'Quanto há dentro'}
                  />
                  {pesoBruto && (() => {
                    // A conta fica à vista: sem mostrar, a subtração da tara é
                    // um ato de fé, e tara errada passa despercebida.
                    const tara = usaTara(unidade) ? (activeLocal.peso_tara ?? 0) : 0
                    const liquidoBalanca = Math.max(0, parseFloat(pesoBruto) - tara)
                    return (
                      <div className="text-xs text-gray-600 space-y-0.5">
                        {tara > 0 && <p>Tara: {tara} {b.rotulo}</p>}
                        <p className="font-semibold text-gray-900">
                          Conteúdo: {Math.round(liquidoBalanca * 1000) / 1000} {b.rotulo}
                          {b.fator !== 1 && (
                            <span className="font-normal text-gray-500">
                              {' '}({emBancada(daBancada(liquidoBalanca, b.fator), 1)} {unidade})
                            </span>
                          )}
                        </p>
                      </div>
                    )
                  })()}
                  <Button size="md" fullWidth onClick={salvarPeso} disabled={!pesoBruto}>
                    Confirmar peso
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Scanner (só mostra se não tem local ativo) */}
      {!activeLocalId && (
        <div className="mb-4">
          <QRScanner
            onScan={handleScan}
            label="Escaneie o QR code do recipiente"
          />
        </div>
      )}

      {scanError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {scanError}
        </div>
      )}

      {/* Finalizar insumo */}
      <Button
        size="lg"
        fullWidth
        onClick={finalizarInsumo}
        disabled={saving}
      >
        {escaneados === totalLocais
          ? 'Todos escaneados — Próximo insumo'
          : `Finalizar insumo (${totalLocais - escaneados} pendente${totalLocais - escaneados > 1 ? 's' : ''})`
        }
      </Button>
    </div>
  )
}

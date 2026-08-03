import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { today, formatDate } from '../../lib/utils'
import type { Produto, ProdutoEmbalagem, LoteProduto } from '../../types/database.types'

// ── Local types ─────────────────────────────────────────────

interface ProdutoComEmbalagens extends Produto {
  embalagens: ProdutoEmbalagem[]
}

interface LoteDisponivel extends LoteProduto {
  // extra fields for display
}

interface ItemExpedicao {
  key: number
  produto_id: string
  produto_nome: string
  lote_produto_id: string
  lote_codigo: string
  quantidade: number
}

// ── Component ───────────────────────────────────────────────

export function NovaExpedicaoPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  // Form header
  const [dataExpedicao, setDataExpedicao] = useState(today())
  const [destinatario, setDestinatario] = useState('')
  const [observacoes, setObservacoes] = useState('')

  // Produto selection
  const [produtos, setProdutos] = useState<ProdutoComEmbalagens[]>([])
  const [produtoId, setProdutoId] = useState('')
  const [lotes, setLotes] = useState<LoteDisponivel[]>([])
  const [quantidade, setQuantidade] = useState('')

  // Items list
  const [itens, setItens] = useState<ItemExpedicao[]>([])
  const [nextKey, setNextKey] = useState(1)

  // Submit
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sucesso, setSucesso] = useState('')

  // ── Load produtos ativos ──────────────────────────────────

  useEffect(() => {
    if (!profile) return
    supabase
      .from('produtos')
      .select('*, embalagens:produtos_embalagens(*)')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .order('nome')
      .then(({ data }) => {
        setProdutos((data ?? []) as unknown as ProdutoComEmbalagens[])
      })
  }, [profile])

  // ── Load lotes when produto changes ───────────────────────

  useEffect(() => {
    if (!produtoId || !profile) {
      setLotes([])
      return
    }
    supabase
      .from('lotes_produto')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .eq('produto_id', produtoId)
      .eq('status', 'ativo')
      .gt('quantidade_disponivel', 0)
      .order('data_producao', { ascending: true })
      .then(({ data }) => {
        setLotes((data ?? []) as LoteDisponivel[])
      })
  }, [produtoId, profile])

  // ── Selected produto helpers ──────────────────────────────

  const selectedProduto = produtos.find((p) => p.id === produtoId)

  function getEmbalagemInfo(produto: ProdutoComEmbalagens): { text: string; totalUnidades: number } | null {
    const embs = (produto.embalagens ?? []).sort((a, b) => a.nivel - b.nivel)
    if (embs.length === 0) return null

    // Calculate total units for the highest-level packaging
    // e.g. nivel 1 = display (12 un), nivel 2 = caixa embarque (16 displays)
    // totalUnidades = 12 * 16 = 192
    let totalUnidades = 1
    const parts: string[] = []
    for (const emb of embs) {
      totalUnidades *= emb.quantidade
      parts.push(`${emb.quantidade} ${emb.nome}`)
    }

    // Build description like "192 un = 1 caixa embarque (16 displays x 12 un)"
    const topEmb = embs[embs.length - 1]
    const innerParts = embs.map((e) => `${e.quantidade} ${e.nome}`).reverse().join(' x ')
    const text = `${totalUnidades} un = 1 ${topEmb.nome} (${innerParts})`

    return { text, totalUnidades }
  }

  const embInfo = selectedProduto ? getEmbalagemInfo(selectedProduto) : null

  const qtdNum = parseFloat(quantidade) || 0
  const isMultipleWarning = embInfo && qtdNum > 0 && qtdNum % embInfo.totalUnidades !== 0

  // ── Available quantity across lots ────────────────────────

  const totalDisponivel = lotes.reduce((sum, l) => sum + l.quantidade_disponivel, 0)

  // ── FIFO split logic ──────────────────────────────────────

  function fifoSplit(qtd: number): ItemExpedicao[] {
    if (!selectedProduto) return []

    // Build a map of already-reserved quantities per lote
    const reservado: Record<string, number> = {}
    for (const item of itens) {
      if (item.produto_id === produtoId) {
        reservado[item.lote_produto_id] = (reservado[item.lote_produto_id] ?? 0) + item.quantidade
      }
    }

    let restante = qtd
    const result: ItemExpedicao[] = []

    for (const lote of lotes) {
      if (restante <= 0) break
      const disponivelNoLote = lote.quantidade_disponivel - (reservado[lote.id] ?? 0)
      if (disponivelNoLote <= 0) continue

      const usar = Math.min(restante, disponivelNoLote)
      result.push({
        key: nextKey + result.length,
        produto_id: produtoId,
        produto_nome: selectedProduto.nome,
        lote_produto_id: lote.id,
        lote_codigo: lote.codigo,
        quantidade: usar,
      })
      restante -= usar
    }

    return result
  }

  // ── Add item ──────────────────────────────────────────────

  function handleAdicionarItem() {
    if (!produtoId || qtdNum <= 0) {
      setError('Selecione um produto e informe a quantidade.')
      return
    }

    // Check available stock (minus already added items)
    const jaAdicionado = itens
      .filter((i) => i.produto_id === produtoId)
      .reduce((sum, i) => sum + i.quantidade, 0)

    if (qtdNum > totalDisponivel - jaAdicionado) {
      setError(`Estoque insuficiente. Disponível: ${totalDisponivel - jaAdicionado} un.`)
      return
    }

    const novosItens = fifoSplit(qtdNum)
    if (novosItens.length === 0) {
      setError('Não há lotes disponíveis para este produto.')
      return
    }

    setItens((prev) => [...prev, ...novosItens])
    setNextKey((k) => k + novosItens.length)
    setQuantidade('')
    setError('')
  }

  function handleRemoverItem(key: number) {
    setItens((prev) => prev.filter((i) => i.key !== key))
  }

  // ── Submit ────────────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (itens.length === 0) {
      setError('Adicione pelo menos um item à expedição.')
      return
    }

    setError('')
    setLoading(true)

    const p_itens = itens.map((i) => ({
      lote_produto_id: i.lote_produto_id,
      produto_id: i.produto_id,
      quantidade: i.quantidade,
    }))

    const { data, error: rpcError } = await supabase.rpc('criar_expedicao', {
      p_empresa_id: profile.empresa_id,
      p_responsavel_id: profile.id,
      p_data_expedicao: dataExpedicao,
      p_destinatario: destinatario || null,
      p_observacoes: observacoes || null,
      p_itens,
    })

    setLoading(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }

    const result = data as { ok: boolean; erro?: string; codigo?: string }
    if (!result?.ok) {
      setError(result?.erro ?? 'Erro ao criar expedição.')
      return
    }

    setSucesso(`Expedição ${result.codigo} registrada.`)
  }

  // ── Success screen ────────────────────────────────────────

  if (sucesso) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <Card className="p-8 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-1">{sucesso}</h2>
          <p className="text-sm text-gray-500 mb-6">A saída foi registrada e o estoque atualizado.</p>
          <div className="flex gap-3 justify-center">
            <Button variant="secondary" onClick={() => navigate('/expedicao')}>
              Voltar para lista
            </Button>
            <Button onClick={() => {
              setSucesso('')
              setItens([])
              setDestinatario('')
              setObservacoes('')
              setDataExpedicao(today())
              setProdutoId('')
              setQuantidade('')
            }}>
              Nova expedição
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  // ── Form ──────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/expedicao')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Nova Expedição</h1>
        <p className="text-sm text-gray-500 mt-0.5">Registrar saída de produtos acabados</p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Header fields */}
        <Card className="p-5 space-y-4 mb-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Data da expedição"
              type="date"
              required
              value={dataExpedicao}
              onChange={(e) => setDataExpedicao(e.target.value)}
            />
            <Input
              label="Destinatário"
              type="text"
              value={destinatario}
              onChange={(e) => setDestinatario(e.target.value)}
              placeholder="Nome do cliente / ponto de venda"
            />
          </div>
          <Textarea
            label="Observações"
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            placeholder="Observações sobre a expedição..."
          />
        </Card>

        {/* Items section */}
        <Card className="p-5 space-y-4 mb-4">
          <h2 className="text-base font-semibold text-gray-900">Itens</h2>

          <Select
            label="Produto"
            value={produtoId}
            onChange={(e) => {
              setProdutoId(e.target.value)
              setQuantidade('')
            }}
          >
            <option value="">Selecionar produto...</option>
            {produtos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.codigo} — {p.nome}
              </option>
            ))}
          </Select>

          {/* Show available lots FIFO */}
          {produtoId && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Lotes disponíveis (FIFO)
              </p>
              {lotes.length === 0 ? (
                <p className="text-sm text-gray-400">Nenhum lote ativo para este produto.</p>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 text-left">
                        <th className="px-3 py-2 font-medium text-gray-500">Código</th>
                        <th className="px-3 py-2 font-medium text-gray-500">Produção</th>
                        <th className="px-3 py-2 font-medium text-gray-500">Validade</th>
                        <th className="px-3 py-2 font-medium text-gray-500 text-right">Disponível</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {lotes.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 font-mono text-gray-600">{l.codigo}</td>
                          <td className="px-3 py-2 text-gray-600">{formatDate(l.data_producao)}</td>
                          <td className="px-3 py-2 text-gray-600">{formatDate(l.validade)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-900">{l.quantidade_disponivel}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Quantity input */}
          {produtoId && (
            <>
              <Input
                label="Quantidade (unidades)"
                type="number" inputMode="decimal"
                min="1"
                step="1"
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
                placeholder="0"
              />

              {/* Embalagem info */}
              {embInfo && (
                <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">
                  {embInfo.text}
                </div>
              )}

              {/* Warning: not a multiple */}
              {isMultipleWarning && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                  A quantidade {qtdNum} não é múltiplo de {embInfo!.totalUnidades} (embalagem completa).
                </div>
              )}

              <Button
                type="button"
                variant="secondary"
                onClick={handleAdicionarItem}
              >
                + Adicionar item
              </Button>
            </>
          )}

          {/* Items list */}
          {itens.length > 0 && (
            <div className="border-t border-gray-200 pt-4 mt-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Itens adicionados
              </p>
              <div className="space-y-2">
                {itens.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{item.produto_nome}</p>
                      <p className="text-xs text-gray-500">
                        Lote {item.lote_codigo} — {item.quantidade} un
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoverItem(item.key)}
                      className="ml-3 text-gray-400 hover:text-red-600 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Error */}
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 acoes-fixas">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/expedicao')}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} disabled={itens.length === 0}>
            Confirmar expedição
          </Button>
        </div>
      </form>
    </div>
  )
}

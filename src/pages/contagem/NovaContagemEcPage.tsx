import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { parseQRLoteCodigo } from '../../lib/qr'
import { NavegadorInsumos } from './NavegadorInsumos'
import type { ContagemInsumo, ContagemEcLote } from '../../types/contagem'

type InsumoJoined = ContagemInsumo & {
  insumo: { nome: string; codigo: string; unidade_medida: string }
}

export function NovaContagemEcPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [itens, setItens] = useState<InsumoJoined[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  const [lotes, setLotes] = useState<ContagemEcLote[]>([])
  const [loading, setLoading] = useState(true)
  const [scanError, setScanError] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusContagem, setStatusContagem] = useState('em_andamento')

  // Carrega todos os itens da contagem
  useEffect(() => {
    if (!id) return
    Promise.all([
      supabase
        .from('contagem_insumos')
        .select('*, insumo:insumos(nome, codigo, unidade_medida)')
        .eq('contagem_id', id)
        .order('created_at'),
      supabase.from('contagens').select('status').eq('id', id).single(),
    ]).then(([itensRes, contRes]) => {
      const items = (itensRes.data ?? []) as unknown as InsumoJoined[]
      setItens(items)
      setStatusContagem((contRes.data as { status: string } | null)?.status ?? 'em_andamento')
      // Começa no primeiro que falta; se estiver tudo feito, no último, para
      // a fila de insumos continuar à vista e permitir voltar em algum.
      const idx = items.findIndex(i => i.status !== 'finalizado')
      setCurrentIdx(idx >= 0 ? idx : Math.max(items.length - 1, 0))
      setLoading(false)
    })
  }, [id])

  /**
   * Volta (ou pula) para um insumo qualquer da fila.
   *
   * Reabrir um insumo já finalizado devolve a contagem para "em andamento":
   * ela não pode continuar marcada como finalizada enquanto alguém mexe nela,
   * senão o resumo ofereceria "Aplicar" sobre um número em edição.
   */
  async function irParaInsumo(idx: number) {
    const item = itens[idx]
    if (!item || statusContagem === 'aplicada') return
    setScanError('')
    setCurrentIdx(idx)

    if (item.status === 'finalizado') {
      await supabase.from('contagem_insumos').update({ status: 'em_contagem' }).eq('id', item.id)
      setItens(prev => prev.map((it, i) =>
        i === idx ? { ...it, status: 'em_contagem' as const } : it
      ))
      if (statusContagem === 'finalizada') {
        await supabase.from('contagens')
          .update({ status: 'em_andamento', finalizada_at: null })
          .eq('id', id)
        setStatusContagem('em_andamento')
      }
    }
  }

  /** Marcado por engano tem volta — antes não tinha. */
  async function desmarcarLote(loteId: string) {
    await supabase.from('contagem_ec_lotes').update({ encontrado: false }).eq('id', loteId)
    setLotes(prev => prev.map(l => (l.id === loteId ? { ...l, encontrado: false } : l)))
  }

  // Carrega lotes do insumo atual
  const currentItem = itens[currentIdx]

  useEffect(() => {
    if (!currentItem) return
    supabase
      .from('contagem_ec_lotes')
      .select('*')
      .eq('contagem_insumo_id', currentItem.id)
      .order('lote_codigo')
      .then(({ data }) => {
        setLotes((data ?? []) as ContagemEcLote[])
      })

    // Marca como em_contagem se ainda pendente
    if (currentItem.status === 'pendente') {
      supabase.from('contagem_insumos').update({ status: 'em_contagem' }).eq('id', currentItem.id)
    }
  }, [currentItem?.id])

  async function handleScan(qrValue: string) {
    setScanError('')

    /**
     * A etiqueta impressa não carrega o `qr_code` do banco: ela carrega
     * `codigo|data|nf` (ver EtiquetaLote). Comparar o valor lido direto com
     * `lotes.qr_code` — que é "QR-" + código — nunca casava, e toda leitura
     * caía em "QR code não reconhecido". A Transferência já traduzia; esta
     * tela não, e o defeito só apareceu quando as etiquetas foram para o
     * estoque de verdade.
     */
    const codigo = parseQRLoteCodigo(qrValue)

    const { data: loteData } = await supabase
      .from('lotes')
      .select('id')
      .eq('codigo', codigo)
      .maybeSingle()

    if (!loteData) {
      setScanError(`Lote ${codigo} não encontrado no sistema.`)
      return
    }

    // Verifica se está na lista de lotes esperados
    const match = lotes.find(l => l.lote_id === loteData.id)
    if (!match) {
      setScanError('Este lote não pertence ao insumo atual.')
      return
    }

    if (match.encontrado) {
      setScanError('Este lote já foi escaneado.')
      return
    }

    // Marca como encontrado
    await supabase
      .from('contagem_ec_lotes')
      .update({ encontrado: true })
      .eq('id', match.id)

    setLotes(prev => prev.map(l => l.id === match.id ? { ...l, encontrado: true } : l))
  }

  async function finalizarInsumo() {
    if (!currentItem) return
    setSaving(true)

    const qtdFisica = lotes
      .filter(l => l.encontrado)
      .reduce((sum, l) => sum + l.qtd_lote, 0)

    await supabase.from('contagem_insumos').update({
      status: 'finalizado',
      qtd_fisica: qtdFisica,
    }).eq('id', currentItem.id)

    // Atualiza local
    setItens(prev => prev.map((item, idx) =>
      idx === currentIdx ? { ...item, status: 'finalizado' as const, qtd_fisica: qtdFisica } : item
    ))

    // Vai para o próximo que ainda falta, e não simplesmente para o de baixo:
    // com a fila navegável, quem voltou para corrigir um insumo no meio
    // seria jogado para o vizinho já conferido.
    const restantes = itens
      .map((it, i) => ({ i, status: i === currentIdx ? 'finalizado' : it.status }))
      .filter(x => x.status !== 'finalizado')

    if (restantes.length === 0) {
      await supabase.from('contagens').update({
        status: 'finalizada',
        finalizada_at: new Date().toISOString(),
      }).eq('id', id)

      navigate(`/contagem/resumo/${id}`)
    } else {
      const proximo = restantes.find(x => x.i > currentIdx) ?? restantes[0]
      setCurrentIdx(proximo.i)
      setLotes([])
      setScanError('')
    }
    setSaving(false)
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  // Todos finalizados
  if (currentIdx >= itens.length) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500">Contagem EC finalizada.</p>
        <Link to={`/contagem/resumo/${id}`} className="text-brand-600 text-sm mt-2 inline-block">Ver resumo</Link>
      </div>
    )
  }

  const encontrados = lotes.filter(l => l.encontrado).length
  const totalLotes = lotes.length
  const finalizados = itens.filter(i => i.status === 'finalizado').length

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
        <h1 className="text-lg font-bold text-gray-900">Contagem EC</h1>

        {/* Progresso */}
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

      <NavegadorInsumos
        itens={itens}
        atual={currentIdx}
        bloqueado={statusContagem === 'aplicada'}
        onIr={idx => void irParaInsumo(idx)}
      />

      {/* Insumo atual */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="font-semibold text-gray-900">{currentItem.insumo.nome}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {currentItem.insumo.codigo} · Lotes esperados: {totalLotes} · Escaneados: {encontrados}
        </p>
        {currentItem.status === 'finalizado' && (
          <p className="text-xs text-amber-700 mt-1.5">
            Já conferido. Escanear ou desmarcar aqui reabre este insumo.
          </p>
        )}
      </div>

      {/* Lista de lotes */}
      <div className="space-y-2 mb-4">
        {lotes.map(lote => (
          <div
            key={lote.id}
            className={[
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm',
              lote.encontrado
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-gray-50 border-gray-200',
            ].join(' ')}
          >
            <div>
              <span className={lote.encontrado ? 'text-emerald-800 font-medium' : 'text-gray-600'}>
                {lote.lote_codigo}
              </span>
              <span className="text-xs text-gray-400 ml-2">
                {lote.qtd_lote} {currentItem.insumo.unidade_medida}
              </span>
            </div>
            {lote.encontrado ? (
              <button
                onClick={() => void desmarcarLote(lote.id)}
                className="flex items-center gap-1.5 text-xs text-emerald-700 hover:underline"
              >
                <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                desmarcar
              </button>
            ) : (
              <span className="text-xs text-gray-400">Pendente</span>
            )}
          </div>
        ))}
      </div>

      {/* Scanner — leva o contexto para dentro da câmera: qual insumo, quanto
          falta e quais lotes, marcando-se sozinho a cada bipada. Sem isso a
          camada de leitura tapava justamente a lista que orienta o trabalho. */}
      <div className="mb-4">
        <QRScanner
          onScan={handleScan}
          continuo
          titulo={currentItem.insumo.nome}
          label={`${encontrados} de ${totalLotes} lotes encontrados`}
          acaoConcluir={{
            rotulo: encontrados === totalLotes
              ? 'Todos encontrados — próximo insumo'
              : `Finalizar com ${totalLotes - encontrados} faltante${totalLotes - encontrados > 1 ? 's' : ''}`,
            onClick: () => { void finalizarInsumo() },
          }}
          painel={
            <div>
              {scanError && (
                <p className="text-xs font-semibold text-red-700 mb-2">{scanError}</p>
              )}
              <div className="space-y-1">
                {lotes.map(lote => (
                  <div key={lote.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className={lote.encontrado ? 'text-emerald-700 font-semibold' : 'text-gray-600'}>
                      {lote.encontrado ? '✓ ' : '○ '}{lote.lote_codigo}
                    </span>
                    <span className="text-gray-400 shrink-0">
                      {lote.qtd_lote} {currentItem.insumo.unidade_medida}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          }
        />
      </div>

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
        {encontrados === totalLotes
          ? 'Todos encontrados — Próximo insumo'
          : `Finalizar insumo (${totalLotes - encontrados} faltante${totalLotes - encontrados > 1 ? 's' : ''})`
        }
      </Button>
    </div>
  )
}

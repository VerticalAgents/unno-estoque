import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { QRScanner } from '../../components/qr/QRScanner'
import { Button } from '../../components/ui/Button'
import { parseQRLoteCodigo } from '../../lib/qr'
import { NavegadorInsumos } from './NavegadorInsumos'
import { formatQty, ordemNatural } from '../../lib/utils'
import type { UnidadeMedida } from '../../types/database.types'
import { avisoCancelamento, cancelarContagem } from '../../lib/contagem'
import { ConfirmModal } from '../../components/ui/ConfirmModal'
import type { ContagemInsumo, ContagemEcLote } from '../../types/contagem'

type InsumoJoined = ContagemInsumo & {
  insumo: { nome: string; codigo: string; unidade_medida: string; tamanho_embalagem: number | null }
}

/**
 * O lote esperado, com o quanto a embalagem trouxe de fábrica.
 *
 * `qtd_lote` é o saldo no momento em que a contagem começou; comparado com o
 * recebido, diz se o fardo já foi aberto. Sem isso, quem conta vê "15 kg" num
 * fardo de 25 e não sabe se é um fardo menor, se falta produto, ou se alguém
 * já transferiu parte dele — três situações bem diferentes.
 */
type LoteEsperado = ContagemEcLote & {
  lote?: {
    quantidade_recebida: number
    quantidade_disponivel: number
    observacoes: string | null
    embalagem_aberta?: boolean
  } | null
}

/**
 * Quanto o sistema acredita que tem HOJE naquele fardo.
 *
 * `qtd_lote` é a fotografia do instante em que a contagem começou. Numa
 * contagem que fica dias aberta ela envelhece: o fardo do qual se transferiu
 * 10 kg continuava anunciando 25. Quem conta precisa do número de agora — a
 * fotografia serve ao histórico, não a quem está de pé na prateleira.
 */
function saldoAtual(l: LoteEsperado): number {
  return Number(l.lote?.quantidade_disponivel ?? l.qtd_lote ?? 0)
}

/**
 * O que este lote tem, segundo a contagem.
 *
 * Quem declarou um número manda; quem só bipou está confirmando o do sistema.
 * `null` não é zero — é "não declarei", e por isso o `??` e não um `||`.
 */
function contado(l: LoteEsperado): number {
  return l.qtd_contada ?? saldoAtual(l)
}

/**
 * Quanto cabe na embalagem cheia.
 *
 * O tamanho vem do cadastro do insumo. Quando o lote nasceu de uma embalagem
 * já começada, ele foi registrado com o que SOBROU (20 kg), e não com o que o
 * saco comporta (25) — por isso o maior dos dois é que descreve a embalagem.
 *
 * Sem tamanho cadastrado sobra o próprio recebido, e aí só dá para dizer que
 * está aberto, não quanto saiu.
 */
function pacoteCheio(l: LoteEsperado, tamanhoEmbalagem?: number | null): number {
  return Math.max(Number(tamanhoEmbalagem ?? 0), Number(l.lote?.quantidade_recebida ?? 0))
}

/**
 * Fardo aberto: tem menos do que a embalagem cheia comporta.
 *
 * Uma regra só cobre os dois caminhos — o fardo do qual já se transferiu, e a
 * embalagem que já estava começada quando o estoque foi cadastrado. A segunda
 * cai aqui naturalmente: registrada com 20 kg num saco de 25, ela já nasce
 * abaixo do cheio.
 *
 * A observação da abertura (migration 069) fica como rede de segurança, para
 * o insumo cujo tamanho de embalagem ninguém cadastrou.
 */
function foiAberto(l: LoteEsperado, tamanhoEmbalagem?: number | null): boolean {
  return nasceuAberto(l) || quantoSaiu(l, tamanhoEmbalagem) > 0.0005
}

function nasceuAberto(l: LoteEsperado): boolean {
  // Coluna desde a migration 077; a observação fica como reserva para os lotes
  // gravados antes dela.
  return l.lote?.embalagem_aberta === true
    || (l.lote?.observacoes ?? '').toLowerCase().includes('embalagem aberta')
}

/** Quanto falta para a embalagem estar cheia. */
function quantoSaiu(l: LoteEsperado, tamanhoEmbalagem?: number | null): number {
  return Number((pacoteCheio(l, tamanhoEmbalagem) - saldoAtual(l)).toFixed(3))
}

export function NovaContagemEcPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [itens, setItens] = useState<InsumoJoined[]>([])
  const [currentIdx, setCurrentIdx] = useState(0)
  /** Qual saída está esperando confirmação — as duas usam o modal do sistema. */
  const [confirmando, setConfirmando] = useState<'encerrar' | 'cancelar' | null>(null)
  const [lotes, setLotes] = useState<LoteEsperado[]>([])
  /**
   * O que está sendo digitado no campo de quantidade, por lote.
   *
   * Texto, e não número: converter cedo transforma "12," em 12 e a pessoa
   * perde a vírgula no meio da digitação.
   */
  const [qtdDigitada, setQtdDigitada] = useState<Record<string, string>>({})
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
        .select('*, insumo:insumos(nome, codigo, unidade_medida, tamanho_embalagem)')
        .eq('contagem_id', id)
        .order('created_at'),
      supabase.from('contagens').select('status').eq('id', id).single(),
    ]).then(([itensRes, contRes]) => {
      // Ordena na exibição, e não só na criação: contagens abertas antes da
      // migration 070 têm a ordem aleatória gravada e só se consertam aqui.
      const items = ((itensRes.data ?? []) as unknown as InsumoJoined[])
        .sort((a, b) => ordemNatural(a.insumo.codigo, b.insumo.codigo))
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
  function irParaInsumo(idx: number) {
    if (!itens[idx]) return
    setScanError('')
    setCurrentIdx(idx)
  }

  /**
   * Reabre o insumo atual, se ele já estava conferido.
   *
   * Chamada só por quem MUDA alguma coisa — escanear ou desmarcar. Antes isso
   * acontecia no próprio clique de navegação, então quem tocava num insumo
   * conferido só para olhar o desfazia sem querer: o verde sumia e o contador
   * de conferidos caía. Olhar tem de ser inofensivo.
   */
  async function reabrirSeConferido() {
    const item = itens[currentIdx]
    if (!item || item.status !== 'finalizado') return
    // Contagem aplicada nao se reabre: o estoque ja foi ajustado por ela.
    if (statusContagem === 'aplicada') return

    await supabase.from('contagem_insumos').update({ status: 'em_contagem' }).eq('id', item.id)
    setItens(prev => prev.map((it, i) =>
      i === currentIdx ? { ...it, status: 'em_contagem' as const } : it
    ))

    // A contagem inteira volta a "em andamento": ela não pode seguir marcada
    // como finalizada enquanto alguém mexe nela.
    if (statusContagem === 'finalizada') {
      await supabase.from('contagens')
        .update({ status: 'em_andamento', finalizada_at: null })
        .eq('id', id)
      setStatusContagem('em_andamento')
    }
  }

  /**
   * Encerra a sessão sem passar por todos os insumos.
   *
   * Ninguém conta 20 insumos de uma vez: interrompe, vai produzir, volta
   * amanhã. Antes só havia saída conferindo tudo. O que não foi conferido fica
   * como está — a migration 071 garante que aplicar não encoste nesses.
   */
  async function encerrarContagem() {
    setConfirmando(null)
    await supabase.from('contagens').update({
      status: 'finalizada',
      finalizada_at: new Date().toISOString(),
    }).eq('id', id)
    navigate(`/contagem/resumo/${id}`)
  }

  /** Cancelar: nada é aplicado ao estoque e a contagem sai do caminho. */
  async function cancelar() {
    const erro = await cancelarContagem(id!)
    setConfirmando(null)
    if (erro) { alert(erro); return }
    navigate('/contagem')
  }

  /** Marcado por engano tem volta — antes não tinha. */
  async function desmarcarLote(loteId: string) {
    await reabrirSeConferido()
    await supabase.from('contagem_ec_lotes')
      .update({ encontrado: false, qtd_contada: null }).eq('id', loteId)
    setLotes(prev => prev.map(l =>
      (l.id === loteId ? { ...l, encontrado: false, qtd_contada: null } : l)))
  }

  /**
   * "Contei, e tem outra quantidade."
   *
   * `null` devolve o lote ao estado de só-bipado: o saldo do sistema vale.
   * Salva a cada dígito, como o resto da tela — contagem que perde o que foi
   * digitado é contagem refeita.
   */
  async function declararQtd(loteId: string, valor: number | null) {
    await reabrirSeConferido()
    await supabase.from('contagem_ec_lotes')
      .update({ qtd_contada: valor, encontrado: true }).eq('id', loteId)
    setLotes(prev => prev.map(l =>
      (l.id === loteId ? { ...l, qtd_contada: valor, encontrado: true } : l)))
  }

  // Carrega lotes do insumo atual
  const currentItem = itens[currentIdx]

  useEffect(() => {
    if (!currentItem) return
    supabase
      .from('contagem_ec_lotes')
      .select('*, lote:lotes(quantidade_recebida, quantidade_disponivel, observacoes, embalagem_aberta)')
      .eq('contagem_insumo_id', currentItem.id)
      .then(({ data }) => {
        // Ordem natural: no banco, "INS002-0001.10/12" vem antes de ".2/12".
        setLotes(((data ?? []) as unknown as LoteEsperado[])
          .sort((a, b) => ordemNatural(a.lote_codigo, b.lote_codigo)))
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

    // Bipar num insumo já conferido reabre — aí sim houve mudança.
    await reabrirSeConferido()

    await supabase
      .from('contagem_ec_lotes')
      .update({ encontrado: true })
      .eq('id', match.id)

    setLotes(prev => prev.map(l => l.id === match.id ? { ...l, encontrado: true } : l))
  }

  async function finalizarInsumo() {
    if (!currentItem) return
    setSaving(true)

    // Grava o mesmo número que a pessoa viu na tela — o saldo de agora, não a
    // fotografia do início. E recalcula o teórico junto, senão o resumo
    // compararia épocas diferentes e acusaria divergência onde não há: numa
    // contagem aberta há dias, qualquer transferência viraria "falta".
    // `contado` e não `saldoAtual`: quem declarou um número na mão manda sobre
    // o do sistema, senão o resumo da contagem mostraria o teórico de novo e
    // a divergência que a pessoa acabou de registrar sumiria do relatório.
    const qtdFisica = lotes.filter(l => l.encontrado).reduce((s, l) => s + contado(l), 0)
    const qtdTeorica = lotes.reduce((s, l) => s + saldoAtual(l), 0)

    await supabase.from('contagem_insumos').update({
      status: 'finalizado',
      qtd_fisica: qtdFisica,
      qtd_teorica: qtdTeorica,
    }).eq('id', currentItem.id)

    // Atualiza local
    setItens(prev => prev.map((item, idx) =>
      idx === currentIdx ? { ...item, status: 'finalizado' as const, qtd_fisica: qtdFisica, qtd_teorica: qtdTeorica } : item
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

  // O tamanho da embalagem cheia do insumo atual, usado pelo selo de aberto.
  const tamEmb = currentItem.insumo.tamanho_embalagem
  const encontrados = lotes.filter(l => l.encontrado).length
  const totalLotes = lotes.length

  /**
   * O total esperado, e o que já foi achado.
   *
   * A lista diz quanto tem em cada fardo, e o cabeçalho dizia quantos fardos —
   * mas o número que a pessoa usa para bater o olho na prateleira é a SOMA. O
   * Lucca contando açúcar via "21 lotes esperados" e tinha de somar 21 linhas
   * de cabeça para saber se aquilo parecia certo.
   *
   * Somar `saldoAtual` e não `qtd_lote`: é o mesmo número que cada linha
   * mostra, e numa contagem que fica dias aberta a fotografia do início
   * envelhece.
   */
  const totalEsperado = lotes.reduce((s, l) => s + saldoAtual(l), 0)
  const totalEncontrado = lotes
    .filter(l => l.encontrado)
    .reduce((s, l) => s + contado(l), 0)
  const divergencia = Number((totalEncontrado - totalEsperado).toFixed(3))
  const tudoBipado = encontrados === totalLotes && totalLotes > 0
  const finalizados = itens.filter(i => i.status === 'finalizado').length
  const conferidos = finalizados
  const faltamConferir = itens.length - finalizados

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
          {/* O mesmo fato da barra, em número. Antes dizia `finalizados + 1`,
              que não era nem quantos foram conferidos nem em qual a pessoa
              estava — e não batia com o preenchimento da barra ao lado: com 7
              conferidos, a barra mostrava 7/20 e o texto "8 de 20". */}
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {finalizados} de {itens.length} conferidos
          </span>
        </div>
      </div>

      <NavegadorInsumos
        itens={itens}
        atual={currentIdx}
        bloqueado={statusContagem === 'aplicada'}
        onIr={irParaInsumo}
      />

      {/* Insumo atual */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="font-semibold text-gray-900">{currentItem.insumo.nome}</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          {currentItem.insumo.codigo} · Lotes esperados: {totalLotes} · Escaneados: {encontrados}
        </p>

        {/* O peso somado, que é por onde se bate o olho. Grande e tabular: são
            dois números para comparar de relance, um embaixo do outro. */}
        <div className="mt-3 pt-3 border-t border-gray-100 flex items-end justify-between gap-4">
          <div>
            <p className="text-[0.6rem] font-semibold uppercase tracking-[1px] text-gray-400">
              O sistema espera
            </p>
            <p className="text-xl font-bold text-gray-900 tabular-nums leading-tight">
              {formatQty(totalEsperado, currentItem.insumo.unidade_medida as UnidadeMedida)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[0.6rem] font-semibold uppercase tracking-[1px] text-gray-400">
              Você contou
            </p>
            <p className={`text-xl font-bold tabular-nums leading-tight ${
              encontrados > 0 ? 'text-brand-700' : 'text-gray-300'
            }`}>
              {formatQty(totalEncontrado, currentItem.insumo.unidade_medida as UnidadeMedida)}
            </p>
          </div>
        </div>

        {/* A conta só fecha quando tudo foi bipado: com metade da prateleira
            lida, "faltam 80 kg" é o que ainda não passou pela câmera, não uma
            divergência. Dizer isso antes da hora só assusta. */}
        {tudoBipado && Math.abs(divergencia) > 0.0005 && (
          <p className="mt-2 text-xs font-semibold text-amber-700">
            {divergencia > 0 ? 'Sobrou ' : 'Faltou '}
            {formatQty(Math.abs(divergencia), currentItem.insumo.unidade_medida as UnidadeMedida)}
            {' '}em relação ao que o sistema esperava.
          </p>
        )}
        {tudoBipado && Math.abs(divergencia) <= 0.0005 && (
          <p className="mt-2 text-xs font-semibold text-emerald-700">
            Bateu com o sistema.
          </p>
        )}

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
              'px-3 py-2 rounded-lg border text-sm',
              lote.encontrado
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-gray-50 border-gray-200',
            ].join(' ')}
          >
            <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className={lote.encontrado ? 'text-emerald-800 font-medium' : 'text-gray-600'}>
                {lote.lote_codigo}
              </span>
              <span className="text-xs text-gray-400 ml-2">
                {saldoAtual(lote)} {currentItem.insumo.unidade_medida}
              </span>
              {/* Fardo aberto tem menos do que a embalagem diz. Sem este aviso,
                  quem conta vê "15 kg" num fardo de 25 e desconfia de falta. */}
              {foiAberto(lote, tamEmb) && (
                <span className="block text-xs font-semibold text-amber-700 mt-0.5">
                  {quantoSaiu(lote, tamEmb) > 0.0005
                    ? `ABERTO · já saíram ${quantoSaiu(lote, tamEmb)} de ${pacoteCheio(lote, tamEmb)} ${currentItem.insumo.unidade_medida}`
                    : 'ABERTO · embalagem começada'}
                </span>
              )}
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

            {/* "Bipei, mas tem outra quantidade."
                Só aparece depois de bipar: antes disso a pergunta é se o lote
                está lá, e responder quanto tem num lote que não se achou não
                quer dizer nada. Fica fechado por padrão — confirmar o número
                do sistema é o caso comum, e um campo aberto em cada linha
                convida a digitar onde não precisa. */}
            {lote.encontrado && (
              <div className="mt-2 pt-2 border-t border-emerald-200/70">
                {lote.qtd_contada === null ? (
                  <button
                    onClick={() => void declararQtd(lote.id, saldoAtual(lote))}
                    className="text-xs text-emerald-800 underline underline-offset-2"
                  >
                    Tem outra quantidade?
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-emerald-900 shrink-0">Contei</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      autoFocus
                      value={qtdDigitada[lote.id] ?? String(lote.qtd_contada)}
                      onChange={e => {
                        const txt = e.target.value
                        setQtdDigitada(v => ({ ...v, [lote.id]: txt }))
                        const n = parseFloat(txt.replace(',', '.'))
                        if (!isNaN(n) && n >= 0) void declararQtd(lote.id, n)
                      }}
                      className="w-24 px-2 py-1 rounded-controle border border-emerald-300 bg-white
                                 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                    <span className="text-xs text-emerald-900">
                      {currentItem.insumo.unidade_medida}
                    </span>
                    <button
                      onClick={() => {
                        setQtdDigitada(v => { const n = { ...v }; delete n[lote.id]; return n })
                        void declararQtd(lote.id, null)
                      }}
                      className="ml-auto text-xs text-gray-500 hover:underline shrink-0"
                    >
                      cancelar
                    </button>
                  </div>
                )}

                {lote.qtd_contada !== null
                  && Math.abs(lote.qtd_contada - saldoAtual(lote)) > 0.0005 && (
                  <p className="mt-1 text-xs font-semibold text-amber-700">
                    {lote.qtd_contada > saldoAtual(lote) ? '+' : '−'}
                    {formatQty(
                      Math.abs(lote.qtd_contada - saldoAtual(lote)),
                      currentItem.insumo.unidade_medida as UnidadeMedida,
                    )}
                    {' '}em relação ao sistema
                    {lote.qtd_contada === 0 && ' · vai ficar esgotado'}
                  </p>
                )}
              </div>
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
                      {foiAberto(lote, tamEmb) && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 font-semibold text-amber-800">
                          ABERTO
                        </span>
                      )}
                    </span>
                    <span className="text-gray-400 shrink-0">
                      {saldoAtual(lote)} {currentItem.insumo.unidade_medida}
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

      {/* Sair no meio é o caso normal: ninguém confere 20 insumos numa sentada.
          Discreto e separado, para não ser clicado no lugar do de cima. */}
      <div className="mt-6 pt-4 border-t border-gray-200 text-center">
        <button
          onClick={() => setConfirmando('encerrar')}
          className="text-xs font-medium text-gray-600 hover:underline"
        >
          Encerrar contagem e ver resumo
        </button>
        <p className="text-xs text-gray-400 mt-1">
          Insumo não conferido fica como está.
        </p>
        <button
          onClick={() => setConfirmando('cancelar')}
          className="text-xs font-medium text-gray-400 hover:text-red-600 mt-3"
        >
          Cancelar contagem
        </button>
        <p className="text-xs text-gray-400 mt-1">
          Descarta o que foi conferido. O estoque não muda.
        </p>
      </div>

      <ConfirmModal
        open={confirmando === 'encerrar'}
        title="Encerrar contagem?"
        summary={faltamConferir > 0
          ? `${faltamConferir} insumo${faltamConferir > 1 ? 's' : ''} sem conferir. `
            + 'O que não foi conferido não será alterado no estoque.'
          : 'Todos os insumos foram conferidos.'}
        confirmLabel="Encerrar e ver resumo"
        cancelLabel="Voltar"
        onConfirm={() => void encerrarContagem()}
        onCancel={() => setConfirmando(null)}
      />

      <ConfirmModal
        open={confirmando === 'cancelar'}
        variant="danger"
        title="Cancelar contagem?"
        summary={avisoCancelamento(conferidos)}
        confirmLabel="Cancelar contagem"
        cancelLabel="Voltar"
        onConfirm={() => void cancelar()}
        onCancel={() => setConfirmando(null)}
      />
    </div>
  )
}

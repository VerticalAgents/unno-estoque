import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { Insumo, Fornecedor, Marca } from '../../types/database.types'
import { Input, Select, Textarea } from '../../components/ui/Input'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { today } from '../../lib/utils'

/**
 * Recebimento de uma carga inteira, e não de um insumo por vez.
 *
 * Antes esta tela registrava UM lote: quem recebia doze insumos da mesma nota
 * digitava fornecedor, número da nota e data doze vezes — e bastava errar um
 * dígito para dois lotes da mesma entrega ficarem com notas diferentes.
 *
 * Agora a nota é o cabeçalho e os insumos pendem dela. Quem tem uma nota só
 * digita uma vez; quem recebeu várias monta uma nota de cada vez com os
 * insumos que vieram em cada uma.
 *
 * O gravar continua sendo uma chamada de `registrar_entrada_lote` por insumo —
 * a RPC não mudou. Se uma falhar no meio, as que já passaram ficam gravadas e
 * marcadas como tal; o botão passa a reenviar só o que faltou, para não criar
 * lote repetido.
 */

// ── Modelo da tela ───────────────────────────────────────────

type LoteGerado = { lote_id: string; codigo: string; qr_code: string; quantidade: number }

type Item = {
  key: string
  insumo_id: string
  marca_id: string
  validade_original: string
  quantidade_recebida: string
  /** Em °C. Só aparece nos insumos com `exige_temperatura` (migration 078). */
  temperatura: string
  /** Só usado quando o insumo não tem tamanho de embalagem cadastrado. */
  num_etiquetas: number
  observacoes: string
  obsAberta: boolean
  /** Preenchido quando o item já foi gravado — vira cartão verde e não reenvia. */
  gerados?: LoteGerado[]
  erro?: string
}

type Nota = {
  key: string
  fornecedor_id: string
  numero_nf: string
  data_recebimento: string
  itens: Item[]
}

type Vinculo = { fornecedor_id: string; insumo_id: string; marca: Marca | null }

type Modo = 'unica' | 'varias'

let seq = 0
const novaKey = () => `k${++seq}`

const novoItem = (): Item => ({
  key: novaKey(),
  insumo_id: '',
  marca_id: '',
  validade_original: '',
  quantidade_recebida: '',
  temperatura: '',
  num_etiquetas: 1,
  observacoes: '',
  obsAberta: false,
})

const novaNota = (): Nota => ({
  key: novaKey(),
  fornecedor_id: '',
  numero_nf: '',
  data_recebimento: today(),
  itens: [novoItem()],
})

/**
 * Quantas etiquetas o item gera.
 *
 * Com tamanho de embalagem cadastrado não é escolha: são os fardos cheios mais
 * o aberto, se sobrar — a mesma conta que a RPC faz no banco (migration 077).
 */
function etiquetasDoItem(item: Item, insumo?: Insumo): number {
  const tam = insumo?.tamanho_embalagem
  const qtd = parseFloat(item.quantidade_recebida) || 0
  if (tam && tam > 0 && qtd > 0) return Math.max(1, Math.ceil(qtd / tam))
  return Math.max(1, item.num_etiquetas)
}

/**
 * O que há de errado com a temperatura deste item, se houver.
 *
 * A RPC recusa de qualquer jeito (migration 078) — isto aqui é para o operador
 * ver antes de tentar gravar, com a carga ainda no caminhão.
 */
function problemaDeTemperatura(item: Item, insumo?: Insumo): string | null {
  if (!insumo?.exige_temperatura) return null
  const min = insumo.temperatura_min ?? 0
  const max = insumo.temperatura_max ?? 0
  if (item.temperatura.trim() === '') return 'Informe a temperatura medida.'
  const t = parseFloat(item.temperatura)
  if (Number.isNaN(t)) return 'Informe a temperatura medida.'
  if (t < min || t > max) {
    return `Fora da faixa aceita (${min} a ${max} °C). Esta carga deve ser recusada.`
  }
  return null
}

/** Como a quantidade se reparte entre as etiquetas, em português. */
function distribuicao(item: Item, insumo?: Insumo): string | null {
  const qtd = parseFloat(item.quantidade_recebida) || 0
  if (qtd <= 0 || !insumo) return null
  const un = insumo.unidade_medida ?? ''
  const tam = insumo.tamanho_embalagem

  if (tam && tam > 0) {
    const fechadas = Math.floor(qtd / tam)
    const resto = Math.round((qtd - fechadas * tam) * 1000) / 1000
    const partes: string[] = []
    if (fechadas > 0) partes.push(`${fechadas}× ${tam} ${un}`)
    if (resto > 0) partes.push(`1× ${resto} ${un} (embalagem aberta)`)
    return partes.join(' + ')
  }

  const n = etiquetasDoItem(item, insumo)
  if (n === 1) return `1 etiqueta de ${qtd} ${un}`
  const porEtiqueta = Math.floor((qtd / n) * 1000) / 1000
  const ultima = Math.round((qtd - porEtiqueta * (n - 1)) * 1000) / 1000
  if (porEtiqueta === ultima) return `${n}× ${porEtiqueta} ${un}`
  return `${n - 1}× ${porEtiqueta} ${un} + 1× ${ultima} ${un}`
}

// ── Página ───────────────────────────────────────────────────

export function NovoLotePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([])
  const [vinculos, setVinculos] = useState<Vinculo[]>([])

  const [modo, setModo] = useState<Modo | null>(null)
  const [notas, setNotas] = useState<Nota[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase.from('insumos').select('*').eq('empresa_id', profile.empresa_id).eq('ativo', true).order('nome'),
      supabase.from('fornecedores').select('*').eq('empresa_id', profile.empresa_id).eq('ativo', true).order('nome'),
      // A RLS já limita à empresa; a tabela é pequena e carregá-la inteira
      // evita uma consulta por item ao trocar de insumo.
      supabase.from('fornecedores_insumos_marcas').select('fornecedor_id, insumo_id, marca:marcas(id, nome, empresa_id, created_at)'),
    ]).then(([ins, forn, vinc]) => {
      setInsumos((ins.data ?? []) as Insumo[])
      setFornecedores((forn.data ?? []) as Fornecedor[])
      setVinculos((vinc.data ?? []).map((v: any) => ({
        fornecedor_id: v.fornecedor_id,
        insumo_id: v.insumo_id,
        marca: Array.isArray(v.marca) ? v.marca[0] ?? null : v.marca ?? null,
      })))
    })
  }, [profile])

  // ── Edição do modelo ───────────────────────────────────────

  function escolherModo(m: Modo) {
    setModo(m)
    setNotas([novaNota()])
  }

  function patchNota(notaKey: string, patch: Partial<Nota>) {
    setNotas(prev => prev.map(n => (n.key === notaKey ? { ...n, ...patch } : n)))
  }

  function patchItem(notaKey: string, itemKey: string, patch: Partial<Item>) {
    setNotas(prev => prev.map(n => n.key !== notaKey ? n : {
      ...n,
      itens: n.itens.map(i => (i.key === itemKey ? { ...i, ...patch } : i)),
    }))
  }

  function addItem(notaKey: string) {
    setNotas(prev => prev.map(n => (n.key === notaKey ? { ...n, itens: [...n.itens, novoItem()] } : n)))
  }

  function removeItem(notaKey: string, itemKey: string) {
    setNotas(prev => prev.map(n => (n.key === notaKey ? { ...n, itens: n.itens.filter(i => i.key !== itemKey) } : n)))
  }

  /** Trocar de fornecedor invalida a marca escolhida: ela é do par fornecedor+insumo. */
  function trocarFornecedor(notaKey: string, fornecedorId: string) {
    setNotas(prev => prev.map(n => n.key !== notaKey ? n : {
      ...n,
      fornecedor_id: fornecedorId,
      itens: n.itens.map(i => (i.gerados ? i : { ...i, marca_id: '' })),
    }))
  }

  // ── Gravação ───────────────────────────────────────────────

  const todosItens = notas.flatMap(n => n.itens)
  const pendentes = todosItens.filter(i => !i.gerados)
  const gravados = todosItens.filter(i => i.gerados)
  const lotesGravados = gravados.flatMap(i => i.gerados ?? [])
  const etiquetasPendentes = pendentes.reduce(
    (s, i) => s + etiquetasDoItem(i, insumos.find(x => x.id === i.insumo_id)), 0,
  )

  /** Primeira coisa errada, dita de um jeito que aponta onde. */
  function validar(): string | null {
    if (pendentes.length === 0) return 'Adicione pelo menos um insumo.'
    for (const [ni, nota] of notas.entries()) {
      const ondeNota = modo === 'varias' ? `Nota ${ni + 1}: ` : ''
      const itensPendentes = nota.itens.filter(i => !i.gerados)
      if (itensPendentes.length === 0) continue
      if (!nota.fornecedor_id) return `${ondeNota}escolha o fornecedor.`
      if (!nota.data_recebimento) return `${ondeNota}informe a data de recebimento.`
      for (const [ii, item] of nota.itens.entries()) {
        if (item.gerados) continue
        const onde = `${ondeNota}insumo ${ii + 1}: `
        if (!item.insumo_id) return `${onde}escolha o insumo.`
        if (!item.validade_original) return `${onde}informe a validade.`
        if (!(parseFloat(item.quantidade_recebida) > 0)) return `${onde}informe a quantidade.`
        const temp = problemaDeTemperatura(item, insumos.find(x => x.id === item.insumo_id))
        if (temp) return `${onde}${temp.charAt(0).toLowerCase()}${temp.slice(1)}`
      }
    }
    return null
  }

  function irParaImpressao(lotes: LoteGerado[]) {
    if (lotes.length === 1) navigate(`/recebimento/imprimir/${lotes[0].lote_id}`)
    else navigate('/recebimento/imprimir-lotes', { state: { lotes } })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!profile) return

    const problema = validar()
    if (problema) { setError(problema); return }

    setLoading(true)
    setError('')

    // Cópia local: as respostas chegam uma a uma e um `setNotas` por item
    // perderia atualizações. Grava tudo, depois publica o resultado.
    const proximas: Nota[] = notas.map(n => ({ ...n, itens: n.itens.map(i => ({ ...i })) }))

    for (const nota of proximas) {
      for (const item of nota.itens) {
        if (item.gerados) continue
        const insumo = insumos.find(i => i.id === item.insumo_id)

        const { data, error: rpcError } = await supabase.rpc('registrar_entrada_lote', {
          p_empresa_id:          profile.empresa_id,
          p_insumo_id:           item.insumo_id,
          p_fornecedor_id:       nota.fornecedor_id,
          p_marca_id:            item.marca_id || null,
          p_data_recebimento:    nota.data_recebimento,
          p_validade_original:   item.validade_original,
          p_quantidade_recebida: parseFloat(item.quantidade_recebida),
          p_unidade:             insumo?.unidade_medida ?? 'kg',
          p_num_etiquetas:       etiquetasDoItem(item, insumo),
          p_observacoes:         item.observacoes || null,
          p_responsavel_id:      profile.id,
          p_numero_nf:           nota.numero_nf || null,
          p_temperatura:         insumo?.exige_temperatura ? parseFloat(item.temperatura) : null,
        })

        const ok = !rpcError && (data as { ok?: boolean })?.ok
        if (!ok) {
          item.erro = rpcError?.message ?? (data as { erro?: string })?.erro ?? 'Erro ao registrar.'
          continue
        }
        item.gerados = (data as { lotes: LoteGerado[] }).lotes
        item.erro = undefined
      }
    }

    setNotas(proximas)
    setLoading(false)

    const falharam = proximas.flatMap(n => n.itens).filter(i => i.erro)
    const lotes = proximas.flatMap(n => n.itens).flatMap(i => i.gerados ?? [])

    if (falharam.length > 0) {
      setError(
        `${falharam.length} insumo(s) não foram registrados — veja a mensagem em cada um. `
        + `Os outros ${lotes.length ? 'já ficaram gravados' : ''}`,
      )
      return
    }
    irParaImpressao(lotes)
  }

  // ── Escolha do modo ────────────────────────────────────────

  if (!modo) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <Voltar onClick={() => navigate('/recebimento')} />
        <h1 className="text-xl font-bold text-gray-900">Registrar recebimento</h1>
        <p className="text-sm text-gray-500 mt-0.5 mb-6">Entrada no Estoque Central</p>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-gray-900">Como vieram as notas fiscais?</h2>
          <p className="text-sm text-gray-500 mt-0.5 mb-4">
            Isso só muda quantas vezes você digita fornecedor, número e data.
          </p>

          <div className="space-y-3">
            <OpcaoModo
              titulo="Uma nota só"
              descricao="Tudo veio do mesmo fornecedor, na mesma nota. Você preenche o cabeçalho uma vez e depois só vai lançando os insumos."
              onClick={() => escolherModo('unica')}
            />
            <OpcaoModo
              titulo="Várias notas"
              descricao="Chegou mais de uma nota. Você monta uma nota de cada vez e coloca embaixo dela os insumos que vieram nela."
              onClick={() => escolherModo('varias')}
            />
          </div>
        </Card>
      </div>
    )
  }

  // ── Formulário ─────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <Voltar onClick={() => navigate('/recebimento')} />
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Registrar recebimento</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {modo === 'unica' ? 'Uma nota fiscal' : `${notas.length} nota${notas.length > 1 ? 's' : ''} fiscai${notas.length > 1 ? 's' : 'l'}`}
            {' · '}{todosItens.length} insumo{todosItens.length > 1 ? 's' : ''}
          </p>
        </div>
        {gravados.length === 0 && (
          <button
            type="button"
            onClick={() => { setModo(null); setNotas([]); setError('') }}
            className="text-xs font-medium text-gray-500 hover:text-gray-700 shrink-0 mt-1"
          >
            Trocar
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* O fornecedor se resolve aqui mesmo; o insumo não — o cadastro dele
            tem decisões (recipiente, armazenamento no EP) que não cabem num
            campo de nome. Melhor dizer onde é do que travar sem explicação. */}
        {insumos.length === 0 && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            Você ainda não tem insumos cadastrados, e o recebimento é de um insumo.
            Cadastre em <strong>Insumos</strong> e volte aqui.
          </div>
        )}

        {notas.map((nota, ni) => (
          <BlocoNota
            key={nota.key}
            nota={nota}
            indice={ni}
            modo={modo}
            insumos={insumos}
            fornecedores={fornecedores}
            vinculos={vinculos}
            podeRemover={notas.length > 1 && nota.itens.every(i => !i.gerados)}
            onRemover={() => setNotas(prev => prev.filter(n => n.key !== nota.key))}
            onPatch={patch => patchNota(nota.key, patch)}
            onTrocarFornecedor={f => trocarFornecedor(nota.key, f)}
            onNovoFornecedor={f => {
              setFornecedores(prev => [...prev, f].sort((a, b) => a.nome.localeCompare(b.nome)))
              // Quem acabou de cadastrar quer usar agora: já deixa escolhido.
              trocarFornecedor(nota.key, f.id)
            }}
            onPatchItem={(itemKey, patch) => patchItem(nota.key, itemKey, patch)}
            onAddItem={() => addItem(nota.key)}
            onRemoveItem={itemKey => removeItem(nota.key, itemKey)}
          />
        ))}

        {modo === 'varias' && (
          <button
            type="button"
            onClick={() => setNotas(prev => [...prev, novaNota()])}
            className="w-full py-3 rounded-xl border-2 border-dashed border-gray-300 text-sm font-medium text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
          >
            + Adicionar outra nota
          </button>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {lotesGravados.length > 0 && (
          <button
            type="button"
            onClick={() => irParaImpressao(lotesGravados)}
            className="w-full py-2.5 rounded-lg border border-emerald-300 bg-emerald-50 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            Imprimir as {lotesGravados.length} etiqueta{lotesGravados.length > 1 ? 's' : ''} já gerada{lotesGravados.length > 1 ? 's' : ''}
          </button>
        )}

        <div className="flex gap-3 acoes-fixas">
          <Button type="button" variant="secondary" size="lg" onClick={() => navigate('/recebimento')}>
            Cancelar
          </Button>
          <Button type="submit" size="lg" fullWidth loading={loading} disabled={pendentes.length === 0}>
            {gravados.length > 0 ? 'Registrar o que faltou' : `Registrar e gerar ${etiquetasPendentes} etiqueta${etiquetasPendentes > 1 ? 's' : ''}`}
          </Button>
        </div>
      </form>
    </div>
  )
}

// ── Bloco de uma nota ────────────────────────────────────────

interface BlocoNotaProps {
  nota: Nota
  indice: number
  modo: Modo
  insumos: Insumo[]
  fornecedores: Fornecedor[]
  vinculos: Vinculo[]
  podeRemover: boolean
  onRemover: () => void
  onPatch: (patch: Partial<Nota>) => void
  onTrocarFornecedor: (fornecedorId: string) => void
  onNovoFornecedor: (f: Fornecedor) => void
  onPatchItem: (itemKey: string, patch: Partial<Item>) => void
  onAddItem: () => void
  onRemoveItem: (itemKey: string) => void
}

function BlocoNota({
  nota, indice, modo, insumos, fornecedores, vinculos,
  podeRemover, onRemover, onPatch, onTrocarFornecedor, onNovoFornecedor,
  onPatchItem, onAddItem, onRemoveItem,
}: BlocoNotaProps) {
  // Os insumos que este fornecedor comercializa sobem para o topo da lista.
  // Filtrar de vez esconderia os insumos ainda sem vínculo cadastrado — e há
  // muitos, porque o cadastro de vínculos é opcional.
  const idsDoFornecedor = new Set(
    vinculos.filter(v => v.fornecedor_id === nota.fornecedor_id).map(v => v.insumo_id),
  )
  const doFornecedor = insumos.filter(i => idsDoFornecedor.has(i.id))
  const demais = insumos.filter(i => !idsDoFornecedor.has(i.id))

  return (
    <Card className="p-5 space-y-4">
      {modo === 'varias' && (
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Nota {indice + 1}</h2>
          {podeRemover && (
            <button type="button" onClick={onRemover} className="text-xs font-medium text-red-500 hover:text-red-700">
              Remover nota
            </button>
          )}
        </div>
      )}

      {fornecedores.length > 0 && (
        <Select
          label="Fornecedor"
          required
          value={nota.fornecedor_id}
          onChange={e => onTrocarFornecedor(e.target.value)}
        >
          <option value="">Selecionar fornecedor...</option>
          {fornecedores.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
        </Select>
      )}

      <NovoFornecedor
        primeiro={fornecedores.length === 0}
        onCriado={onNovoFornecedor}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Número da NF"
          type="text"
          value={nota.numero_nf}
          onChange={e => onPatch({ numero_nf: e.target.value })}
          placeholder="Ex: 001234"
        />
        <Input
          label="Data de recebimento"
          type="date"
          required
          value={nota.data_recebimento}
          onChange={e => onPatch({ data_recebimento: e.target.value })}
        />
      </div>

      <div className="pt-1 space-y-3">
        {nota.itens.map((item, ii) => (
          <BlocoItem
            key={item.key}
            item={item}
            indice={ii}
            insumosDoFornecedor={doFornecedor}
            insumosDemais={demais}
            insumos={insumos}
            marcas={
              vinculos
                .filter(v => v.fornecedor_id === nota.fornecedor_id && v.insumo_id === item.insumo_id && v.marca)
                .map(v => v.marca as Marca)
                .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i)
            }
            podeRemover={nota.itens.length > 1}
            onRemover={() => onRemoveItem(item.key)}
            onPatch={patch => onPatchItem(item.key, patch)}
          />
        ))}

        <button
          type="button"
          onClick={onAddItem}
          className="w-full py-2.5 rounded-lg border border-dashed border-gray-300 text-sm font-medium text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
        >
          + Adicionar insumo desta nota
        </button>
      </div>
    </Card>
  )
}

// ── Bloco de um insumo ───────────────────────────────────────

interface BlocoItemProps {
  item: Item
  indice: number
  insumosDoFornecedor: Insumo[]
  insumosDemais: Insumo[]
  insumos: Insumo[]
  marcas: Marca[]
  podeRemover: boolean
  onRemover: () => void
  onPatch: (patch: Partial<Item>) => void
}

function BlocoItem({
  item, indice, insumosDoFornecedor, insumosDemais, insumos, marcas, podeRemover, onRemover, onPatch,
}: BlocoItemProps) {
  const insumo = insumos.find(i => i.id === item.insumo_id)
  const tamanhoEmbalagem = insumo?.tamanho_embalagem
  const quantidade = parseFloat(item.quantidade_recebida) || 0
  const reparticao = distribuicao(item, insumo)
  const problemaTemp = problemaDeTemperatura(item, insumo)
  // Campo em branco ainda não é erro para mostrar em vermelho: o operador
  // acabou de escolher o insumo e nem mediu ainda.
  const foraDaFaixa = problemaTemp !== null && item.temperatura.trim() !== ''

  // Já gravado: some com os campos para não haver dúvida do que ainda falta.
  if (item.gerados) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
        <p className="text-sm font-semibold text-emerald-800">
          ✓ {insumo?.nome} — {item.gerados.length} etiqueta{item.gerados.length > 1 ? 's' : ''}
        </p>
        <p className="font-mono text-xs text-emerald-600 mt-0.5">
          {item.gerados.map(l => l.codigo).join(' · ')}
        </p>
      </div>
    )
  }

  const opcoes = (lista: Insumo[]) => lista.map(ins => (
    <option key={ins.id} value={ins.id}>{ins.codigo} — {ins.nome}</option>
  ))

  return (
    <div className="rounded-lg border border-gray-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Insumo {indice + 1}
        </span>
        {podeRemover && (
          <button type="button" onClick={onRemover} className="text-xs font-medium text-gray-400 hover:text-red-600">
            Remover
          </button>
        )}
      </div>

      <Select
        label="Insumo"
        required
        value={item.insumo_id}
        onChange={e => onPatch({ insumo_id: e.target.value, marca_id: '' })}
      >
        <option value="">Selecionar insumo...</option>
        {insumosDoFornecedor.length > 0 ? (
          <>
            <optgroup label="Deste fornecedor">{opcoes(insumosDoFornecedor)}</optgroup>
            <optgroup label="Outros insumos">{opcoes(insumosDemais)}</optgroup>
          </>
        ) : opcoes(insumosDemais)}
      </Select>

      {marcas.length > 0 && (
        <Select label="Marca" value={item.marca_id} onChange={e => onPatch({ marca_id: e.target.value })}>
          <option value="">Sem marca</option>
          {marcas.map(m => <option key={m.id} value={m.id}>{m.nome}</option>)}
        </Select>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Validade (embalagem)"
          type="date"
          required
          value={item.validade_original}
          onChange={e => onPatch({ validade_original: e.target.value })}
        />
        <Input
          label={`Quantidade ${insumo ? `(${insumo.unidade_medida})` : ''}`}
          type="number" inputMode="decimal"
          step="0.001"
          min="0.001"
          required
          value={item.quantidade_recebida}
          onChange={e => onPatch({ quantidade_recebida: e.target.value })}
          placeholder="0.000"
        />
      </div>

      {insumo?.exige_temperatura && (
        <div className={`rounded-lg border p-3 ${
          foraDaFaixa ? 'border-red-300 bg-red-50' : 'border-cyan-200 bg-cyan-50'
        }`}>
          <Input
            label="Temperatura na chegada (°C)"
            type="number" inputMode="decimal"
            step="0.1"
            required
            value={item.temperatura}
            onChange={e => onPatch({ temperatura: e.target.value })}
            placeholder="Ex: 3.5"
            error={foraDaFaixa ? problemaTemp ?? undefined : undefined}
            hint={`Aceita de ${insumo.temperatura_min} a ${insumo.temperatura_max} °C`}
          />
        </div>
      )}

      {quantidade > 0 && item.insumo_id && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          {tamanhoEmbalagem ? (
            <p className="text-xs text-blue-700">
              Embalagem de {tamanhoEmbalagem} {insumo?.unidade_medida} — o sistema separa
              os fardos cheios do que sobrar.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700 whitespace-nowrap">Etiquetas a gerar:</label>
              <input
                type="number" inputMode="numeric"
                min="1"
                step="1"
                value={item.num_etiquetas}
                onChange={e => onPatch({ num_etiquetas: Math.max(1, parseInt(e.target.value) || 1) })}
                className="w-20 rounded-lg border border-blue-300 px-3 py-1.5 text-sm font-semibold text-blue-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          )}
          {reparticao && <p className="text-xs font-medium text-blue-700 mt-2">{reparticao}</p>}
        </div>
      )}

      {item.obsAberta ? (
        <Textarea
          label="Observações"
          rows={2}
          value={item.observacoes}
          onChange={e => onPatch({ observacoes: e.target.value })}
          placeholder="Condição da embalagem, temperatura de chegada..."
        />
      ) : (
        <button
          type="button"
          onClick={() => onPatch({ obsAberta: true })}
          className="text-xs font-medium text-gray-400 hover:text-brand-600"
        >
          + Observação
        </button>
      )}

      {item.erro && (
        <p className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
          {item.erro}
        </p>
      )}
    </div>
  )
}

/**
 * Cadastrar o fornecedor sem sair do recebimento.
 *
 * O fornecedor é obrigatório, e uma empresa que acabou de entrar no sistema
 * não tem nenhum: sem isto, a primeira coisa que o cliente novo encontra é uma
 * tela travada num select vazio. Mandar para a tela de fornecedores também
 * resolveria, mas ele perderia tudo o que já digitou aqui.
 *
 * Só o nome, que é o único campo obrigatório do cadastro. O resto — CNPJ,
 * contato, cidade — se completa depois, em Fornecedores, sem pressa e sem a
 * mercadoria esperando na porta.
 */
function NovoFornecedor({ primeiro, onCriado }: { primeiro: boolean; onCriado: (f: Fornecedor) => void }) {
  const { profile } = useAuth()
  const [aberto, setAberto] = useState(primeiro)
  const [nome, setNome] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')

  async function salvar() {
    if (!profile || !nome.trim()) { setErro('Escreva o nome do fornecedor.'); return }
    setSalvando(true)
    setErro('')
    const { data, error } = await supabase
      .from('fornecedores')
      .insert({ empresa_id: profile.empresa_id, nome: nome.trim(), ativo: true })
      .select('*')
      .single()
    setSalvando(false)
    if (error) { setErro(error.message); return }
    onCriado(data as Fornecedor)
    setNome('')
    setAberto(false)
  }

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="text-xs font-medium text-gray-400 hover:text-brand-600"
      >
        + Cadastrar fornecedor
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
      {primeiro && (
        <p className="text-xs text-gray-600">
          Você ainda não tem fornecedor cadastrado. Escreva o nome de quem entregou —
          o resto do cadastro pode ser completado depois, em Fornecedores.
        </p>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={nome}
          onChange={e => setNome(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); salvar() } }}
          placeholder="Nome do fornecedor"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
        />
        <Button type="button" size="md" loading={salvando} onClick={salvar}>Salvar</Button>
        {!primeiro && (
          <Button type="button" variant="ghost" size="md" onClick={() => { setAberto(false); setErro('') }}>
            Cancelar
          </Button>
        )}
      </div>
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </div>
  )
}

// ── Miudezas ─────────────────────────────────────────────────

function OpcaoModo({ titulo, descricao, onClick }: { titulo: string; descricao: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-4 rounded-xl border border-gray-200 hover:border-brand-500 hover:bg-brand-50/40 transition-colors"
    >
      <span className="block text-sm font-semibold text-gray-900">{titulo}</span>
      <span className="block text-xs text-gray-500 mt-1 leading-relaxed">{descricao}</span>
    </button>
  )
}

function Voltar({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
      </svg>
      Voltar
    </button>
  )
}

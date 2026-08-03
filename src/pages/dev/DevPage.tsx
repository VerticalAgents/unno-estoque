import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

interface ActionState {
  loading: boolean
  confirm: boolean
  result: string | null
}

const INIT: ActionState = { loading: false, confirm: false, result: null }

function useAction(fn: () => Promise<string>) {
  const [state, setState] = useState<ActionState>(INIT)

  async function run() {
    if (!state.confirm) {
      setState(s => ({ ...s, confirm: true, result: null }))
      return
    }
    setState({ loading: true, confirm: false, result: null })
    try {
      const msg = await fn()
      setState({ loading: false, confirm: false, result: `✓ ${msg}` })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setState({ loading: false, confirm: false, result: `✗ ${msg}` })
    }
  }

  function reset() { setState(INIT) }

  return { ...state, run, reset }
}

// ── Seção ────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-700 mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

// ── Action card ───────────────────────────────────────────────

function ActionCard({
  label,
  description,
  danger,
  action,
}: {
  label: string
  description: string
  danger?: boolean
  action: ReturnType<typeof useAction>
}) {
  return (
    <Card className="p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        {action.result && (
          <p className={`text-xs mt-1.5 font-mono ${action.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
            {action.result}
          </p>
        )}
      </div>
      <div className="flex gap-2 flex-shrink-0">
        {action.confirm && (
          <Button variant="ghost" size="sm" onClick={action.reset}>Cancelar</Button>
        )}
        <Button
          variant={action.confirm ? 'danger' : danger ? 'danger' : 'secondary'}
          size="sm"
          loading={action.loading}
          onClick={action.run}
        >
          {action.confirm ? 'Confirmar?' : label}
        </Button>
      </div>
    </Card>
  )
}

// ── DevPage ───────────────────────────────────────────────────

export function DevPage() {
  const { profile } = useAuth()
  const eid = profile?.empresa_id

  // ── Limpeza ──────────────────────────────────────────────

  const limparTudo = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    // Ordem respeita FK
    await supabase.from('sessoes_producao_locais').delete().eq('sessao_id', supabase.from('sessoes_producao').select('id').eq('empresa_id', eid) as never)
    await supabase.from('sessoes_producao_skus').delete().in('sessao_id',
      (await supabase.from('sessoes_producao').select('id').eq('empresa_id', eid)).data?.map(r => r.id) ?? [])
    await supabase.from('sessoes_producao').delete().eq('empresa_id', eid)
    await supabase.from('perdas_insumos').delete().eq('empresa_id', eid)
    await supabase.from('reembalagens').delete().eq('empresa_id', eid)
    await supabase.from('movimentacoes_itens').delete().in('movimentacao_id',
      (await supabase.from('movimentacoes').select('id').eq('empresa_id', eid)).data?.map(r => r.id) ?? [])
    await supabase.from('locais_estado_atual').delete().in('local_id',
      (await supabase.from('locais').select('id').eq('empresa_id', eid)).data?.map(r => r.id) ?? [])
    await supabase.from('lotes').delete().eq('empresa_id', eid)
    await supabase.from('movimentacoes').delete().eq('empresa_id', eid)
    return 'Tudo limpo.'
  })

  const limparLotes = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    await supabase.from('reembalagens').delete().eq('empresa_id', eid)
    await supabase.from('movimentacoes_itens').delete().in('movimentacao_id',
      (await supabase.from('movimentacoes').select('id').eq('empresa_id', eid)).data?.map(r => r.id) ?? [])
    await supabase.from('locais_estado_atual').delete().in('local_id',
      (await supabase.from('locais').select('id').eq('empresa_id', eid)).data?.map(r => r.id) ?? [])
    await supabase.from('lotes').delete().eq('empresa_id', eid)
    await supabase.from('movimentacoes').delete().eq('empresa_id', eid)
    return 'Lotes e estoque limpos.'
  })

  const limparEP = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    const { data: locais } = await supabase.from('locais').select('id').eq('empresa_id', eid)
    await supabase.from('locais_estado_atual').delete().in('local_id', locais?.map(r => r.id) ?? [])
    return 'Estado do EP zerado.'
  })

  const limparSessoes = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    const { data: sessoes } = await supabase.from('sessoes_producao').select('id').eq('empresa_id', eid)
    const ids = sessoes?.map(r => r.id) ?? []
    if (ids.length) {
      await supabase.from('sessoes_producao_locais').delete().in('sessao_id', ids)
      await supabase.from('sessoes_producao_skus').delete().in('sessao_id', ids)
    }
    await supabase.from('sessoes_producao').delete().eq('empresa_id', eid)
    return `${ids.length} sessão(ões) removida(s).`
  })

  const limparPerdas = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    const { data } = await supabase.from('perdas_insumos').delete().eq('empresa_id', eid).select('id')
    return `${data?.length ?? 0} perda(s) removida(s).`
  })

  // ── Estoque mínimo ───────────────────────────────────────

  const [minEC, setMinEC] = useState('5')
  const [minEP, setMinEP] = useState('2')

  const popularMinimo = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    const ec = parseFloat(minEC)
    const ep = parseFloat(minEP)
    if (isNaN(ec) || isNaN(ep)) throw new Error('Valores inválidos')
    const { data } = await supabase
      .from('insumos')
      .update({ estoque_minimo_ec: ec, estoque_minimo_ep: ep })
      .eq('empresa_id', eid)
      .eq('ativo', true)
      .select('id')
    return `${data?.length ?? 0} insumo(s) atualizados (EC ≥ ${ec}, EP ≥ ${ep}).`
  })

  const zerarMinimo = useAction(async () => {
    if (!eid) throw new Error('empresa_id ausente')
    await supabase.from('insumos').update({ estoque_minimo_ec: null, estoque_minimo_ep: null }).eq('empresa_id', eid)
    return 'Estoques mínimos zerados.'
  })

  // ── Seed lotes ────────────────────────────────────────────

  const [qtdSeed, setQtdSeed] = useState('10')
  const [etiquetasSeed, setEtiquetasSeed] = useState('1')

  /**
   * Deixa a fábrica pronta para testar: cria o estoque central e já despeja
   * nos recipientes.
   *
   * A quantidade de cada insumo sai da capacidade dos recipientes dele, não de
   * um número fixo — assim o açúcar ganha o que cabe nos potes de açúcar e a
   * essência ganha o que cabe nas garrafinhas.
   */
  /**
   * A Pós-produção só lista sessões FECHADAS. Sem nenhuma, a tela aparece
   * vazia e não dá para conferir. Fechar a sessão real só para olhar seria
   * caro: o fechamento dá baixa no consumo e não se desfaz.
   */
  const seedPosProducao = useAction(async () => {
    if (!eid || !profile) throw new Error('perfil ausente')
    const { data, error } = await supabase.rpc('dev_criar_sessao_pos_producao', {
      p_empresa_id: eid,
      p_responsavel_id: profile.id,
    })
    if (error) throw error
    const r = data as { ok: boolean; erro?: string; codigo?: string; fichas?: number; unidades_teoricas?: number }
    if (!r.ok) throw new Error(r.erro ?? 'não foi possível criar a sessão')
    return `${r.codigo} criada — ${r.fichas} ficha(s), ${r.unidades_teoricas} unidades teóricas.`
      + ' Abra Pós-produção para ver.'
  })

  const limparSessoesTeste = useAction(async () => {
    if (!eid) throw new Error('empresa ausente')
    const { data, error } = await supabase.rpc('dev_limpar_sessoes_teste', { p_empresa_id: eid })
    if (error) throw error
    const r = data as { sessoes_apagadas: number }
    return r.sessoes_apagadas === 0
      ? 'Não havia sessão de teste para apagar.'
      : `${r.sessoes_apagadas} sessão(ões) de teste apagada(s).`
  })

  const encherTudo = useAction(async () => {
    if (!eid || !profile) throw new Error('perfil ausente')
    const { data, error } = await supabase.rpc('dev_encher_tudo', {
      p_empresa_id: eid,
      p_responsavel_id: profile.id,
    })
    if (error) throw error
    const r = data as {
      estoque_central: { insumos: number; quantidade_total: number }
      recipientes: { recipientes_cheios: number; sem_lote: number }
    }
    return `${r.estoque_central.insumos} insumo(s) no estoque central `
      + `e ${r.recipientes.recipientes_cheios} recipiente(s) cheios`
      + (r.recipientes.sem_lote > 0 ? ` — ${r.recipientes.sem_lote} sem lote` : '')
  })

  /**
   * Enche os recipientes do EP até a capacidade.
   *
   * Testar produção exige recipiente cheio, e enchê-los pela tela de
   * transferência são dezenas de leituras de QR. Usa os lotes que já existem;
   * insumo sem lote é pulado e aparece na contagem, em vez de inventar estoque
   * — que é justamente o que mascararia o problema num teste.
   */
  const encherRecipientes = useAction(async () => {
    if (!eid) throw new Error('perfil ausente')
    const { data, error } = await supabase.rpc('dev_encher_recipientes', {
      p_empresa_id: eid,
    })
    if (error) throw error
    const r = data as { recipientes_cheios: number; sem_lote: number; quantidade_total: number }
    // Zero em tudo não é falha: é recipiente já cheio. Sem dizer isso, a
    // mensagem "0 recipientes" parece erro.
    if (r.quantidade_total === 0 && r.sem_lote === 0) {
      return 'Os recipientes já estavam cheios — nada a fazer.'
    }
    if (r.quantidade_total === 0 && r.sem_lote > 0) {
      return `Nada foi despejado: ${r.sem_lote} recipiente(s) sem lote no estoque central.`
        + ' Use "Encher tudo" para criar o estoque primeiro.'
    }
    return `${r.recipientes_cheios} recipiente(s) cheios com ${r.quantidade_total} no total`
      + (r.sem_lote > 0 ? ` — ${r.sem_lote} ficaram sem lote no estoque central` : '')
  })

  const criarLotesTeste = useAction(async () => {
    if (!eid || !profile) throw new Error('perfil ausente')
    const qtd = parseFloat(qtdSeed)
    const etq = parseInt(etiquetasSeed)
    if (isNaN(qtd) || isNaN(etq) || etq < 1) throw new Error('Valores inválidos')

    const { data: insumos } = await supabase
      .from('insumos')
      .select('id, unidade_medida')
      .eq('empresa_id', eid)
      .eq('ativo', true)

    if (!insumos?.length) throw new Error('Nenhum insumo ativo encontrado')

    const hoje = new Date().toISOString().split('T')[0]
    const validade = new Date(Date.now() + 365 * 86400_000).toISOString().split('T')[0]

    let criados = 0
    for (const ins of insumos) {
      const { data } = await supabase.rpc('registrar_entrada_lote', {
        p_empresa_id:          eid,
        p_insumo_id:           ins.id,
        p_fornecedor_id:       null,
        p_data_recebimento:    hoje,
        p_validade_original:   validade,
        p_quantidade_recebida: qtd,
        p_unidade:             ins.unidade_medida,
        p_num_etiquetas:       etq,
        p_responsavel_id:      profile.id,
      })
      if ((data as { ok: boolean })?.ok) criados++
    }
    return `${criados}/${insumos.length} lote(s) criados (${etq}x${qtd}).`
  })

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="p-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-amber-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </span>
          <h1 className="text-base font-bold text-amber-900">Ferramentas de Desenvolvimento</h1>
        </div>
        <p className="text-xs text-amber-700">Ações destrutivas para facilitar testes. Use apenas em ambiente de desenvolvimento.</p>
      </div>

      <div className="space-y-8">

        {/* ── Limpeza ── */}
        <Section title="Limpeza">
          <ActionCard
            label="Limpar tudo"
            description="Remove lotes, estoque, movimentações, reembalagens, sessões de produção e perdas."
            danger
            action={limparTudo}
          />
          <ActionCard
            label="Limpar lotes e estoque"
            description="Remove lotes, movimentações e estado do EP. Mantém sessões de produção e perdas."
            danger
            action={limparLotes}
          />
          <ActionCard
            label="Zerar apenas EP"
            description="Reseta locais_estado_atual. Lotes continuam no EC."
            danger
            action={limparEP}
          />
          <ActionCard
            label="Limpar sessões de produção"
            description="Remove todas as sessões e seus itens."
            danger
            action={limparSessoes}
          />
          <ActionCard
            label="Limpar perdas"
            description="Remove todos os registros de perda de insumos."
            danger
            action={limparPerdas}
          />
        </Section>

        {/* ── Estoque mínimo ── */}
        <Section title="Estoque Mínimo">
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Definir estoque mínimo de teste</p>
              <p className="text-xs text-gray-500 mt-0.5">Aplica os valores abaixo a todos os insumos ativos.</p>
            </div>
            <div className="flex gap-3">
              <label className="flex-1">
                <span className="block text-xs text-gray-500 mb-1">Mínimo EC</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={minEC}
                  onChange={e => { setMinEC(e.target.value); popularMinimo.reset() }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="flex-1">
                <span className="block text-xs text-gray-500 mb-1">Mínimo EP</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={minEP}
                  onChange={e => { setMinEP(e.target.value); popularMinimo.reset() }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </div>
            {popularMinimo.result && (
              <p className={`text-xs font-mono ${popularMinimo.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {popularMinimo.result}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              {popularMinimo.confirm && (
                <Button variant="ghost" size="sm" onClick={popularMinimo.reset}>Cancelar</Button>
              )}
              <Button
                variant={popularMinimo.confirm ? 'danger' : 'secondary'}
                size="sm"
                loading={popularMinimo.loading}
                onClick={popularMinimo.run}
              >
                {popularMinimo.confirm ? 'Confirmar?' : 'Aplicar a todos os insumos'}
              </Button>
            </div>
          </Card>

          <ActionCard
            label="Zerar estoque mínimo"
            description="Remove os valores de estoque_minimo_ec e estoque_minimo_ep de todos os insumos."
            action={zerarMinimo}
          />
        </Section>

        {/* ── Encher tudo ── */}
        <Section title="Preparar para testar">
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Encher estoque central e recipientes</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Cria um lote por insumo ativo, com quantidade proporcional à capacidade
                dos recipientes daquele insumo, e já despeja tudo neles. Um clique para
                deixar a fábrica pronta.
              </p>
            </div>
            {encherTudo.result && (
              <p className={`text-xs font-mono ${encherTudo.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {encherTudo.result}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              {encherTudo.confirm && (
                <Button variant="ghost" size="sm" onClick={encherTudo.reset}>Cancelar</Button>
              )}
              <Button
                variant={encherTudo.confirm ? 'danger' : 'primary'}
                size="sm"
                loading={encherTudo.loading}
                onClick={encherTudo.run}
              >
                {encherTudo.confirm ? 'Confirmar?' : 'Encher tudo'}
              </Button>
            </div>
          </Card>

          {/* ── Sessão fechada para ver a Pós-produção ── */}
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Criar sessão para a Pós-produção</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Cria uma sessão já fechada, com data de ontem e 4 formas de cada ficha,
                só para a tela de Pós-produção ter o que listar. Não dá baixa em estoque
                nem entra no relatório de perdas.
              </p>
            </div>
            {seedPosProducao.result && (
              <p className={`text-xs font-mono ${seedPosProducao.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {seedPosProducao.result}
              </p>
            )}
            {limparSessoesTeste.result && (
              <p className={`text-xs font-mono ${limparSessoesTeste.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {limparSessoesTeste.result}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                loading={limparSessoesTeste.loading}
                onClick={limparSessoesTeste.run}
              >
                {limparSessoesTeste.confirm ? 'Confirmar?' : 'Apagar as de teste'}
              </Button>
              <Button
                variant={seedPosProducao.confirm ? 'danger' : 'primary'}
                size="sm"
                loading={seedPosProducao.loading}
                onClick={seedPosProducao.run}
              >
                {seedPosProducao.confirm ? 'Confirmar?' : 'Criar sessão fechada'}
              </Button>
            </div>
          </Card>
        </Section>

        {/* ── Encher recipientes ── */}
        <Section title="Estoque Produtivo">
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Encher os recipientes</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Despeja os lotes do estoque central nos recipientes até a capacidade,
                do primeiro ao último. Crie os lotes de teste antes, senão não há
                o que despejar.
              </p>
            </div>
            {encherRecipientes.result && (
              <p className={`text-xs font-mono ${encherRecipientes.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {encherRecipientes.result}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              {encherRecipientes.confirm && (
                <Button variant="ghost" size="sm" onClick={encherRecipientes.reset}>Cancelar</Button>
              )}
              <Button
                variant={encherRecipientes.confirm ? 'danger' : 'primary'}
                size="sm"
                loading={encherRecipientes.loading}
                onClick={encherRecipientes.run}
              >
                {encherRecipientes.confirm ? 'Confirmar?' : 'Encher recipientes'}
              </Button>
            </div>
          </Card>
        </Section>

        {/* ── Seed lotes ── */}
        <Section title="Seed de Lotes">
          <Card className="p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Criar lotes de teste</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Cria 1 lote por insumo ativo via <code className="font-mono bg-gray-100 px-1 rounded">registrar_entrada_lote</code>.
                Validade: +1 ano a partir de hoje.
              </p>
            </div>
            <div className="flex gap-3">
              <label className="flex-1">
                <span className="block text-xs text-gray-500 mb-1">Quantidade por lote</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={qtdSeed}
                  onChange={e => { setQtdSeed(e.target.value); criarLotesTeste.reset() }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="flex-1">
                <span className="block text-xs text-gray-500 mb-1">Nº de sublotes</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={etiquetasSeed}
                  onChange={e => { setEtiquetasSeed(e.target.value); criarLotesTeste.reset() }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </div>
            {criarLotesTeste.result && (
              <p className={`text-xs font-mono ${criarLotesTeste.result.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
                {criarLotesTeste.result}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              {criarLotesTeste.confirm && (
                <Button variant="ghost" size="sm" onClick={criarLotesTeste.reset}>Cancelar</Button>
              )}
              <Button
                variant={criarLotesTeste.confirm ? 'danger' : 'primary'}
                size="sm"
                loading={criarLotesTeste.loading}
                onClick={criarLotesTeste.run}
              >
                {criarLotesTeste.confirm ? 'Confirmar?' : 'Criar lotes de teste'}
              </Button>
            </div>
          </Card>
        </Section>

      </div>
    </div>
  )
}

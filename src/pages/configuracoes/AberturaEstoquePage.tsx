import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { bancada, daBancada, emBancada, usaTara } from '../../lib/unidades'

/**
 * ABERTURA DE ESTOQUE — o primeiro dia de quem migra a operação para cá.
 *
 * Quem começa a usar o sistema já tem estoque: sacos na prateleira e baldes
 * cheios. Nada disso passou por um recebimento, e nada tem QR code ainda.
 * Fingir uma nota fiscal para cada item resolveria a tela e estragaria o
 * relatório — por isso o lote nasce marcado como saldo de abertura.
 *
 * A regra que orienta as duas etapas: **conta-se o que se enxerga.** O que
 * está no balde não entra na prateleira. A soma é problema do sistema, não de
 * quem está com a balança na mão.
 *
 * UNIDADES: a prateleira fala a unidade do cadastro (o saco diz "25 kg"); o
 * balde fala a da balança (o visor diz "4820 g"). A conversão acontece só na
 * fronteira do envio, como na Contagem.
 */

type Insumo = {
  id: string
  codigo: string
  nome: string
  unidade_medida: string
  tamanho_embalagem: number | null
}

type Recipiente = {
  id: string
  nome: string
  insumo_id: string
  capacidade_max: number | null
  peso_tara: number | null
}

type Marca = { id: string; nome: string }
type Fornecedor = { id: string; nome: string }

/**
 * Um conjunto de embalagens iguais na prateleira.
 *
 * Descreve o que se vê: tantos pacotes fechados de tanto cada, mais o que
 * sobrou no que já está aberto. Pedir "quantidade total" e "em quantas
 * embalagens" parecia mais simples e era uma armadilha — 98 kg em 10
 * embalagens viravam dez etiquetas de 9,8 kg, e nenhum fardo de verdade tem
 * 9,8 kg. Quem transferisse um fardo fechado erraria 200 g todas as vezes.
 */
type Linha = {
  key: string
  fornecedor_id: string
  marca_id: string
  validade: string
  sem_validade: boolean
  fechadas: string
  tamanho: string
  aberta: string
}

type Balde = {
  modo: 'vazio' | 'cheio' | 'peso'
  peso_bruto: string
  linha_key: string // de qual linha veio o conteúdo (só importa se houver mais de uma)
}

const novaLinha = (tamanhoPadrao?: number | null, validadePadrao?: string): Linha => ({
  key: Math.random().toString(36).slice(2),
  fornecedor_id: '',
  marca_id: '',
  validade: validadePadrao ?? '',
  sem_validade: false,
  fechadas: '',
  tamanho: tamanhoPadrao ? String(tamanhoPadrao) : '',
  aberta: '',
})

/** O que o insumo já tem de saldo registrado, para a abertura em duas idas. */
type SaldoAtual = { total: number; lotes: number; validade: string | null }

/**
 * O tipo físico do pote, deduzido do nome.
 *
 * Os nomes seguem "<tipo> <insumo> #<n>": "Pote G Açúcar #1", "Saco de Conf.
 * 750g Nutella #12". Tirando o nome do insumo e a numeração sobra o tipo — e
 * potes do mesmo tipo pesam o mesmo vazios, que é o que permite informar 11
 * taras em vez de 73.
 *
 * A comparação é pela PRIMEIRA palavra do insumo, não pelo nome inteiro: o
 * pote do "Açúcar Refinado" se chama só "Pote G Açúcar". Exigir o nome
 * completo faria esse caso cair fora do agrupamento sem ninguém notar.
 */
function tipoDoPote(nomePote: string, nomeInsumo: string): string {
  const primeira = (nomeInsumo ?? '').trim().split(/\s+/)[0]
  let t = nomePote
  if (primeira) {
    const i = t.indexOf(primeira)
    if (i > 0) t = t.slice(0, i)
  }
  return t.replace(/#\s*\d+\s*$/, '').replace(/\s+/g, ' ').trim() || nomePote
}

const num = (s: string) => parseFloat(s) || 0
const inteiro = (s: string) => parseInt(s) || 0

/** Quanto essa linha representa, na unidade do insumo. */
function totalLinha(l: Linha): number {
  return Number((inteiro(l.fechadas) * num(l.tamanho) + num(l.aberta)).toFixed(3))
}

/** Quantas etiquetas essa linha gera: uma por pacote fechado, mais a aberta. */
function etiquetasLinha(l: Linha): number {
  const fechadas = num(l.tamanho) > 0 ? inteiro(l.fechadas) : 0
  return fechadas + (num(l.aberta) > 0 ? 1 : 0)
}

export function AberturaEstoquePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [etapa, setEtapa] = useState<1 | 2 | 3>(1)
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')

  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [recipientes, setRecipientes] = useState<Recipiente[]>([])
  const [marcasPorInsumo, setMarcasPorInsumo] = useState<Record<string, Marca[]>>({})
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([])
  const [jaTemLotes, setJaTemLotes] = useState(false)
  const [saldoAtual, setSaldoAtual] = useState<Record<string, SaldoAtual>>({})

  // Insumos cujo tamanho de embalagem deve voltar para o cadastro, para os
  // próximos recebimentos já virem preenchidos. Marcado por padrão quando o
  // insumo ainda não tem tamanho — é informação que a pessoa está descobrindo
  // agora, com o pacote na mão, e seria perdida ao fim do assistente.
  const [guardarTamanho, setGuardarTamanho] = useState<Record<string, boolean>>({})

  const [linhas, setLinhas] = useState<Record<string, Linha[]>>({})
  const [baldes, setBaldes] = useState<Record<string, Balde>>({})

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase
        .from('insumos')
        .select('id, codigo, nome, unidade_medida, tamanho_embalagem')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true)
        .order('codigo'),
      supabase
        .from('locais')
        .select('id, nome, insumo_id, capacidade_max, peso_tara')
        .eq('empresa_id', profile.empresa_id)
        .eq('tipo', 'estoque_produtivo')
        .eq('ativo', true)
        .order('nome'),
      // Vem de insumos_marcas: é o vínculo "esta marca existe para este
      // insumo", independente de quem vende. O vínculo com fornecedor é outra
      // tabela e serve para o recebimento filtrar depois.
      supabase.from('insumos_marcas').select('insumo_id, marca:marcas(id, nome)'),
      // O que já existe de saldo. Serve a duas coisas: avisar quem volta para
      // uma segunda ida (o caso de quem cadastrou a prateleira num dia e os
      // baldes no outro) e herdar a validade do que já foi registrado.
      supabase
        .from('lotes')
        .select('insumo_id, quantidade_disponivel, validade_original')
        .eq('empresa_id', profile.empresa_id)
        .eq('status', 'ativo'),
      supabase
        .from('fornecedores')
        .select('id, nome')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true)
        .order('nome'),
    ]).then(([ins, loc, vinc, lot, forn]) => {
      const listaInsumos = (ins.data ?? []) as Insumo[]
      setInsumos(listaInsumos)
      setRecipientes((loc.data ?? []) as Recipiente[])
      setFornecedores((forn.data ?? []) as Fornecedor[])

      const lotesAtivos = (lot.data ?? []) as {
        insumo_id: string
        quantidade_disponivel: number
        validade_original: string | null
      }[]
      setJaTemLotes(lotesAtivos.length > 0)

      const saldos: Record<string, SaldoAtual> = {}
      for (const l of lotesAtivos) {
        const s = (saldos[l.insumo_id] ??= { total: 0, lotes: 0, validade: null })
        s.total += Number(l.quantidade_disponivel) || 0
        s.lotes += 1
        // A mais próxima: é a que descreve o que já está aberto e em uso.
        if (l.validade_original && (!s.validade || l.validade_original < s.validade)) {
          s.validade = l.validade_original
        }
      }
      setSaldoAtual(saldos)

      const porInsumo: Record<string, Marca[]> = {}
      for (const v of (vinc.data ?? []) as { insumo_id: string; marca: Marca | Marca[] | null }[]) {
        const m = Array.isArray(v.marca) ? v.marca[0] : v.marca
        if (!m) continue
        const atual = porInsumo[v.insumo_id] ?? []
        if (!atual.some(x => x.id === m.id)) porInsumo[v.insumo_id] = [...atual, m]
      }
      setMarcasPorInsumo(porInsumo)

      // Uma linha em branco por insumo, e todo balde começa vazio: o padrão é
      // "não tenho", para que o que for preenchido seja sempre uma afirmação.
      const iniciais: Record<string, Linha[]> = {}
      const guardar: Record<string, boolean> = {}
      for (const i of listaInsumos) {
        // Quem já registrou a prateleira e volta só para os baldes não deveria
        // ter de redigitar a validade: o que está no pote saiu daqueles mesmos
        // pacotes. Sem isso o lote do balde nasceria com validade de dez anos.
        iniciais[i.id] = [novaLinha(i.tamanho_embalagem, saldos[i.id]?.validade ?? undefined)]
        guardar[i.id] = i.tamanho_embalagem == null
      }
      setLinhas(iniciais)
      setGuardarTamanho(guardar)

      const b: Record<string, Balde> = {}
      for (const r of (loc.data ?? []) as Recipiente[]) {
        b[r.id] = { modo: 'vazio', peso_bruto: '', linha_key: '' }
      }
      setBaldes(b)
      setCarregando(false)
    })
  }, [profile])

  // ── Cadastros feitos sem sair da abertura ───────────────────
  //
  // Sair daqui para cadastrar uma marca significaria perder tudo que já foi
  // digitado — e no onboarding é justamente quando se descobre que falta
  // cadastro. Cada função grava no banco na hora e devolve o item para a tela.

  async function criarFornecedor(nome: string): Promise<Fornecedor | null> {
    if (!profile || !nome.trim()) return null
    const { data, error } = await supabase
      .from('fornecedores')
      .insert({ empresa_id: profile.empresa_id, nome: nome.trim() })
      .select('id, nome')
      .single()
    if (error) {
      setErro(`Não foi possível criar o fornecedor: ${error.message}`)
      return null
    }
    setFornecedores(prev => [...prev, data as Fornecedor].sort((a, b) => a.nome.localeCompare(b.nome)))
    return data as Fornecedor
  }

  /**
   * Cria a marca e a amarra ao insumo. Se houver fornecedor escolhido, amarra
   * também o trio (fornecedor, insumo, marca) — é esse vínculo que faz o
   * Recebimento oferecer a marca certa depois de escolher o fornecedor.
   */
  async function criarMarca(
    insumoId: string,
    nome: string,
    fornecedorId?: string,
  ): Promise<Marca | null> {
    if (!profile || !nome.trim()) return null

    // Marca repetida não é erro do usuário: a mesma marca serve a vários
    // insumos, e o banco tem UNIQUE(empresa, nome). Reaproveita a existente.
    const { data: existente } = await supabase
      .from('marcas')
      .select('id, nome')
      .eq('empresa_id', profile.empresa_id)
      .ilike('nome', nome.trim())
      .maybeSingle()

    let marca = existente as Marca | null
    if (!marca) {
      const { data, error } = await supabase
        .from('marcas')
        .insert({ empresa_id: profile.empresa_id, nome: nome.trim() })
        .select('id, nome')
        .single()
      if (error) {
        setErro(`Não foi possível criar a marca: ${error.message}`)
        return null
      }
      marca = data as Marca
    }

    await supabase
      .from('insumos_marcas')
      .upsert({ insumo_id: insumoId, marca_id: marca.id }, { onConflict: 'insumo_id,marca_id' })

    if (fornecedorId) {
      await supabase.from('fornecedores_insumos_marcas').upsert(
        { fornecedor_id: fornecedorId, insumo_id: insumoId, marca_id: marca.id },
        { onConflict: 'fornecedor_id,insumo_id,marca_id' },
      )
    }

    setMarcasPorInsumo(prev => {
      const atual = prev[insumoId] ?? []
      if (atual.some(m => m.id === marca!.id)) return prev
      return { ...prev, [insumoId]: [...atual, marca!] }
    })
    return marca
  }

  /** Liga uma marca que já existe ao fornecedor escolhido, sem duplicar nada. */
  async function vincularFornecedorMarca(insumoId: string, marcaId: string, fornecedorId: string) {
    if (!marcaId || !fornecedorId) return
    await supabase.from('fornecedores_insumos_marcas').upsert(
      { fornecedor_id: fornecedorId, insumo_id: insumoId, marca_id: marcaId },
      { onConflict: 'fornecedor_id,insumo_id,marca_id' },
    )
  }

  async function criarRecipiente(
    insumo: Insumo,
    dados: { nome: string; capacidade: string; tara: string },
  ): Promise<boolean> {
    if (!profile || !dados.nome.trim()) return false
    const qr = `QR-EP-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
    const { data, error } = await supabase
      .from('locais')
      .insert({
        empresa_id: profile.empresa_id,
        nome: dados.nome.trim(),
        tipo: 'estoque_produtivo',
        subtipo: 'balde',
        insumo_id: insumo.id,
        capacidade_max: dados.capacidade ? parseFloat(dados.capacidade) : null,
        unidade_capacidade: dados.capacidade ? insumo.unidade_medida : null,
        peso_tara: dados.tara ? parseFloat(dados.tara) : 0,
        qr_code_fixo: qr,
        ativo: true,
      })
      .select('id, nome, insumo_id, capacidade_max, peso_tara')
      .single()

    if (error) {
      setErro(`Não foi possível criar o recipiente: ${error.message}`)
      return false
    }
    const novo = data as Recipiente
    setRecipientes(prev => [...prev, novo].sort((a, b) => a.nome.localeCompare(b.nome)))
    setBaldes(prev => ({ ...prev, [novo.id]: { modo: 'vazio', peso_bruto: '', linha_key: '' } }))
    return true
  }

  /** Grava a tara em um pote só. */
  async function salvarTara(localId: string, tara: number) {
    await supabase.from('locais').update({ peso_tara: tara }).eq('id', localId)
    setRecipientes(prev => prev.map(r => (r.id === localId ? { ...r, peso_tara: tara } : r)))
  }

  /**
   * Grava a mesma tara em todos os potes de um tipo.
   *
   * Pesar 72 potes vazios um a um é o tipo de trabalho que faz a pessoa
   * desistir do inventário no meio. Pote do mesmo tipo pesa o mesmo.
   */
  async function salvarTaraDoTipo(tipo: string, tara: number) {
    const alvos = recipientes.filter(r => {
      const insumo = insumos.find(i => i.id === r.insumo_id)
      return tipoDoPote(r.nome, insumo?.nome ?? '') === tipo
    })
    if (alvos.length === 0) return

    const { error } = await supabase
      .from('locais')
      .update({ peso_tara: tara })
      .in('id', alvos.map(a => a.id))

    if (error) {
      setErro(`Não foi possível salvar a tara: ${error.message}`)
      return
    }
    const ids = new Set(alvos.map(a => a.id))
    setRecipientes(prev => prev.map(r => (ids.has(r.id) ? { ...r, peso_tara: tara } : r)))
  }

  /**
   * Apagar recipiente só é seguro enquanto ele está vazio — depois há histórico
   * de transferência e produção apontando para ele.
   */
  async function excluirRecipiente(rec: Recipiente): Promise<boolean> {
    const { count } = await supabase
      .from('locais_lotes')
      .select('id', { count: 'exact', head: true })
      .eq('local_id', rec.id)
      .gt('quantidade', 0)

    if ((count ?? 0) > 0) {
      setErro(`${rec.nome} tem conteúdo registrado e não pode ser excluído.`)
      return false
    }

    const { error } = await supabase.from('locais').delete().eq('id', rec.id)
    if (error) {
      setErro(`Não foi possível excluir: ${error.message}`)
      return false
    }
    setRecipientes(prev => prev.filter(r => r.id !== rec.id))
    setBaldes(prev => {
      const novo = { ...prev }
      delete novo[rec.id]
      return novo
    })
    return true
  }

  const recipientesPorInsumo = useMemo(() => {
    const m: Record<string, Recipiente[]> = {}
    for (const r of recipientes) (m[r.insumo_id] ??= []).push(r)
    return m
  }, [recipientes])

  function alterarLinha(insumoId: string, key: string, campo: keyof Linha, valor: string | boolean) {
    setLinhas(prev => ({
      ...prev,
      [insumoId]: (prev[insumoId] ?? []).map(l => (l.key === key ? { ...l, [campo]: valor } : l)),
    }))
  }

  function desdobrar(insumoId: string) {
    const tamanho = insumos.find(i => i.id === insumoId)?.tamanho_embalagem
    setLinhas(prev => ({ ...prev, [insumoId]: [...(prev[insumoId] ?? []), novaLinha(tamanho)] }))
  }

  function removerLinha(insumoId: string, key: string) {
    setLinhas(prev => ({ ...prev, [insumoId]: (prev[insumoId] ?? []).filter(l => l.key !== key) }))
    // Um balde não pode apontar para uma linha que deixou de existir.
    setBaldes(prev => {
      const novo = { ...prev }
      for (const id of Object.keys(novo)) {
        if (novo[id].linha_key === key) novo[id] = { ...novo[id], linha_key: '' }
      }
      return novo
    })
  }

  /** Quanto há no balde, na unidade do insumo. */
  function conteudoDoBalde(rec: Recipiente, insumo: Insumo): number {
    const b = baldes[rec.id]
    if (!b || b.modo === 'vazio') return 0
    if (b.modo === 'cheio') return rec.capacidade_max ?? 0
    const bruto = parseFloat(b.peso_bruto)
    if (isNaN(bruto)) return 0
    const tara = usaTara(insumo.unidade_medida) ? rec.peso_tara ?? 0 : 0
    return daBancada(Math.max(0, bruto - tara), bancada(insumo.unidade_medida).fator)
  }

  const resumo = useMemo(() => {
    let totalPrateleira = 0
    let totalBaldes = 0
    let insumosComSaldo = 0
    let etiquetas = 0
    let potesCheios = 0

    for (const insumo of insumos) {
      const ls = linhas[insumo.id] ?? []
      const naPrateleira = ls.reduce((s, l) => s + totalLinha(l), 0)
      const eti = ls.reduce((s, l) => s + etiquetasLinha(l), 0)
      const nosBaldes = (recipientesPorInsumo[insumo.id] ?? []).reduce(
        (s, r) => s + conteudoDoBalde(r, insumo),
        0,
      )
      const cheios = (recipientesPorInsumo[insumo.id] ?? []).filter(
        r => conteudoDoBalde(r, insumo) > 0,
      ).length

      totalPrateleira += naPrateleira
      totalBaldes += nosBaldes
      etiquetas += eti
      potesCheios += cheios
      if (naPrateleira > 0 || nosBaldes > 0) insumosComSaldo++
    }

    return { totalPrateleira, totalBaldes, insumosComSaldo, etiquetas, potesCheios }
  }, [insumos, linhas, baldes, recipientesPorInsumo])

  /** Erros que travam o envio, apontando o insumo pelo nome. */
  const problemas = useMemo(() => {
    const lista: string[] = []
    for (const insumo of insumos) {
      for (const l of linhas[insumo.id] ?? []) {
        // Pacote fechado sem tamanho não vira quantidade nenhuma — sem este
        // aviso o insumo entraria zerado e ninguém perceberia.
        if (inteiro(l.fechadas) > 0 && num(l.tamanho) <= 0) {
          lista.push(`${insumo.nome}: informe quanto vem em cada embalagem fechada.`)
        }
        if (totalLinha(l) <= 0) continue
        if (!l.validade && !l.sem_validade) {
          lista.push(`${insumo.nome}: informe a validade ou marque "não sei".`)
        }
      }
      for (const r of recipientesPorInsumo[insumo.id] ?? []) {
        // "Cheio" sem capacidade cadastrada não vira quantidade nenhuma. Sem
        // este aviso o pote entraria como vazio e ninguém perceberia.
        if (baldes[r.id]?.modo === 'cheio' && r.capacidade_max == null) {
          lista.push(`${r.nome}: marcado como cheio, mas não tem capacidade cadastrada.`)
        }
        const q = conteudoDoBalde(r, insumo)
        if (q <= 0) continue
        if (r.capacidade_max != null && q > r.capacidade_max) {
          lista.push(
            `${r.nome}: ${q} ${insumo.unidade_medida} passa da capacidade de ${r.capacidade_max}.`,
          )
        }
        const ls = (linhas[insumo.id] ?? []).filter(l => totalLinha(l) > 0)
        if (ls.length > 1 && !baldes[r.id]?.linha_key) {
          lista.push(`${r.nome}: escolha de qual embalagem veio o conteúdo.`)
        }
      }
    }
    return lista
  }, [insumos, linhas, baldes, recipientesPorInsumo])

  async function aplicar() {
    if (!profile) return
    setErro('')
    setSalvando(true)

    const itens: unknown[] = []

    for (const insumo of insumos) {
      const ls = linhas[insumo.id] ?? []
      const comSaldo = ls.filter(l => totalLinha(l) > 0)
      const recs = recipientesPorInsumo[insumo.id] ?? []

      // Cada balde entra na linha de onde veio. Com uma linha só (o caso
      // comum) não há escolha a fazer, e todos caem nela.
      const baldesDaLinha = (key: string) =>
        recs
          .filter(r => {
            if (conteudoDoBalde(r, insumo) <= 0) return false
            if (comSaldo.length <= 1) return true
            return baldes[r.id]?.linha_key === key
          })
          .map(r => ({ local_id: r.id, quantidade: conteudoDoBalde(r, insumo) }))

      if (comSaldo.length === 0) {
        // Balde cheio de insumo que não tem nada na prateleira: ainda é saldo.
        const soltos = recs
          .filter(r => conteudoDoBalde(r, insumo) > 0)
          .map(r => ({ local_id: r.id, quantidade: conteudoDoBalde(r, insumo) }))
        if (soltos.length > 0) {
          // Aproveita a validade e a marca que a pessoa digitou na etapa 1,
          // mesmo sem quantidade: ela olhou o rótulo, seria perder informação.
          const ref = ls[0]
          itens.push({
            insumo_id: insumo.id,
            marca_id: ref?.marca_id || null,
            validade: ref && !ref.sem_validade ? ref.validade || null : null,
            quantidade_prateleira: 0,
            embalagens: 1,
            baldes: soltos,
          })
        }
        continue
      }

      for (const l of comSaldo) {
        const comum = {
          insumo_id: insumo.id,
          marca_id: l.marca_id || null,
          fornecedor_id: l.fornecedor_id || null,
          validade: l.sem_validade ? null : l.validade || null,
        }
        // Os baldes entram uma vez só, no primeiro lote que essa linha gerar.
        let baldesPendentes = baldesDaLinha(l.key)

        const fechadas = inteiro(l.fechadas)
        const tamanho = num(l.tamanho)
        if (fechadas > 0 && tamanho > 0) {
          itens.push({
            ...comum,
            quantidade_prateleira: Number((fechadas * tamanho).toFixed(3)),
            embalagens: fechadas,
            baldes: baldesPendentes,
          })
          baldesPendentes = []
        }

        // A embalagem aberta vira lote próprio, com a quantidade que ela
        // realmente tem. É o que faz a etiqueta dizer 8 kg em vez de 9,8.
        const aberta = num(l.aberta)
        if (aberta > 0) {
          itens.push({
            ...comum,
            quantidade_prateleira: aberta,
            embalagens: 1,
            observacoes: 'Saldo de abertura — embalagem aberta',
            baldes: baldesPendentes,
          })
        }
      }
    }

    if (itens.length === 0) {
      setErro('Nada foi informado — preencha ao menos um insumo.')
      setSalvando(false)
      return
    }

    // O tamanho da embalagem volta para o cadastro do insumo antes de criar os
    // lotes: assim o próximo recebimento já vem preenchido, e a descoberta
    // feita aqui com o pacote na mão não se perde.
    const tamanhos = insumos
      .map(i => {
        const primeira = (linhas[i.id] ?? [])[0]
        const t = primeira ? num(primeira.tamanho) : 0
        return guardarTamanho[i.id] && t > 0 && t !== i.tamanho_embalagem
          ? { id: i.id, tamanho: t }
          : null
      })
      .filter(Boolean) as { id: string; tamanho: number }[]

    for (const t of tamanhos) {
      await supabase.from('insumos').update({ tamanho_embalagem: t.tamanho }).eq('id', t.id)
    }

    const { data, error } = await supabase.rpc('abrir_estoque_inicial', {
      p_empresa_id: profile.empresa_id,
      p_responsavel_id: profile.id,
      p_itens: itens,
    })

    const res = data as { ok: boolean; erro?: string; lotes?: unknown[] } | null

    if (error || !res?.ok) {
      setErro(error?.message ?? res?.erro ?? 'Não foi possível criar o estoque inicial.')
      setSalvando(false)
      return
    }

    // O ciclo só fecha com a etiqueta colada: é ela que dá QR ao que já existia.
    if (res.lotes && res.lotes.length > 0) {
      navigate('/recebimento/imprimir-lotes', { state: { lotes: res.lotes } })
    } else {
      navigate('/estoque/insumos')
    }
  }

  if (carregando) {
    return <div className="p-6 text-sm text-gray-500">Carregando…</div>
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-5">
        <button
          onClick={() => navigate('/configuracoes')}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Voltar
        </button>
        <h1 className="text-xl font-bold text-gray-900">Abertura de estoque</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          O que você já tem hoje, para o sistema começar sabendo do que existe.
        </p>
      </div>

      <Passos etapa={etapa} />

      {jaTemLotes && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <strong>Já existe estoque lançado.</strong> Cada insumo mostra abaixo o que já foi
          registrado — preencha só o que faltou. Se você veio agora apenas para os baldes,
          deixe a etapa 1 inteira em branco e vá direto para a etapa 2: a validade já vem
          herdada do que você lançou antes.
        </div>
      )}

      {etapa === 1 && (
        <EtapaPrateleira
          insumos={insumos}
          linhas={linhas}
          marcasPorInsumo={marcasPorInsumo}
          fornecedores={fornecedores}
          saldoAtual={saldoAtual}
          guardarTamanho={guardarTamanho}
          onGuardarTamanho={(id, v) => setGuardarTamanho(prev => ({ ...prev, [id]: v }))}
          onAlterar={alterarLinha}
          onDesdobrar={desdobrar}
          onRemover={removerLinha}
          onCriarMarca={criarMarca}
          onCriarFornecedor={criarFornecedor}
          onVincular={vincularFornecedorMarca}
        />
      )}

      {etapa === 2 && (
        <EtapaBaldes
          insumos={insumos}
          recipientesPorInsumo={recipientesPorInsumo}
          linhas={linhas}
          baldes={baldes}
          setBaldes={setBaldes}
          conteudoDoBalde={conteudoDoBalde}
          onCriarRecipiente={criarRecipiente}
          onExcluirRecipiente={excluirRecipiente}
          onSalvarTara={salvarTara}
          onSalvarTaraDoTipo={salvarTaraDoTipo}
        />
      )}

      {etapa === 3 && (
        <EtapaConferir resumo={resumo} problemas={problemas} insumos={insumos} />
      )}

      {erro && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {erro}
        </div>
      )}

      <div className="flex gap-3 mt-4 acoes-fixas">
        {etapa > 1 && (
          <Button variant="secondary" size="lg" onClick={() => setEtapa(e => (e - 1) as 1 | 2)}>
            Voltar
          </Button>
        )}
        {etapa < 3 ? (
          <Button size="lg" fullWidth onClick={() => setEtapa(e => (e + 1) as 2 | 3)}>
            Continuar
          </Button>
        ) : (
          <Button
            size="lg"
            fullWidth
            loading={salvando}
            disabled={problemas.length > 0}
            onClick={aplicar}
          >
            Criar estoque e imprimir etiquetas
          </Button>
        )}
      </div>
    </div>
  )
}

function Passos({ etapa }: { etapa: number }) {
  const nomes = ['Prateleira', 'Baldes', 'Conferir']
  return (
    <div className="flex items-center gap-2 mb-5">
      {nomes.map((n, i) => (
        <div key={n} className="flex items-center gap-2">
          <span
            className={[
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
              i + 1 === etapa
                ? 'bg-brand-600 text-white'
                : i + 1 < etapa
                  ? 'bg-brand-100 text-brand-700'
                  : 'bg-gray-100 text-gray-500',
            ].join(' ')}
          >
            {i + 1}. {n}
          </span>
          {i < nomes.length - 1 && <span className="text-gray-300">›</span>}
        </div>
      ))}
    </div>
  )
}

// ── Etapa 1 ───────────────────────────────────────────────────
function EtapaPrateleira({
  insumos,
  linhas,
  marcasPorInsumo,
  fornecedores,
  saldoAtual,
  guardarTamanho,
  onGuardarTamanho,
  onAlterar,
  onDesdobrar,
  onRemover,
  onCriarMarca,
  onCriarFornecedor,
  onVincular,
}: {
  insumos: Insumo[]
  linhas: Record<string, Linha[]>
  marcasPorInsumo: Record<string, Marca[]>
  fornecedores: Fornecedor[]
  saldoAtual: Record<string, SaldoAtual>
  guardarTamanho: Record<string, boolean>
  onGuardarTamanho: (insumoId: string, valor: boolean) => void
  onAlterar: (insumoId: string, key: string, campo: keyof Linha, valor: string | boolean) => void
  onDesdobrar: (insumoId: string) => void
  onRemover: (insumoId: string, key: string) => void
  onCriarMarca: (insumoId: string, nome: string, fornecedorId?: string) => Promise<Marca | null>
  onCriarFornecedor: (nome: string) => Promise<Fornecedor | null>
  onVincular: (insumoId: string, marcaId: string, fornecedorId: string) => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Quanto há <strong>fora dos baldes</strong> — na prateleira, na câmara, no chão.
        O que já está dentro dos potes fica para a próxima etapa. Deixe em branco o que não tiver.
      </p>

      {insumos.map(insumo => {
        const ls = linhas[insumo.id] ?? []
        const marcas = marcasPorInsumo[insumo.id] ?? []
        return (
          <Card key={insumo.id} className="p-4">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <div className="min-w-0">
                <p className="font-semibold text-gray-900 truncate">{insumo.nome}</p>
                <p className="text-xs text-gray-500">{insumo.codigo}</p>
              </div>
              <span className="text-xs font-medium text-gray-400 shrink-0">
                {insumo.unidade_medida}
              </span>
            </div>

            {/* Segunda ida: o que já foi registrado antes fica à vista, senão
                é fácil somar de novo o mesmo saco. */}
            {saldoAtual[insumo.id] && (
              <div className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                Já registrado: <strong className="text-gray-900">
                  {saldoAtual[insumo.id].total.toFixed(3)} {insumo.unidade_medida}
                </strong>{' '}
                em {saldoAtual[insumo.id].lotes} lote
                {saldoAtual[insumo.id].lotes === 1 ? '' : 's'}. Preencha abaixo só o que
                ainda <strong>não</strong> foi lançado.
              </div>
            )}

            <div className="space-y-3">
              {ls.map((l, idx) => (
                <div key={l.key} className={idx > 0 ? 'border-t border-gray-100 pt-3' : ''}>
                  {ls.length > 1 && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                        Embalagem {idx + 1}
                      </span>
                      <button
                        onClick={() => onRemover(insumo.id, l.key)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        remover
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Embalagens fechadas
                      </span>
                      <input
                        type="number"
                        inputMode="numeric"
                        step="1"
                        min="0"
                        value={l.fechadas}
                        onChange={e => onAlterar(insumo.id, l.key, 'fechadas', e.target.value)}
                        placeholder="0"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Cada uma tem ({insumo.unidade_medida})
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.001"
                        min="0"
                        value={l.tamanho}
                        onChange={e => onAlterar(insumo.id, l.key, 'tamanho', e.target.value)}
                        placeholder="0"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>
                  </div>

                  {/* Só na primeira linha: o tamanho é do insumo, não da linha. */}
                  {idx === 0 && num(l.tamanho) > 0 && num(l.tamanho) !== insumo.tamanho_embalagem && (
                    <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={guardarTamanho[insumo.id] ?? false}
                        onChange={e => onGuardarTamanho(insumo.id, e.target.checked)}
                        className="rounded border-gray-300"
                      />
                      Guardar no cadastro do insumo, para os próximos recebimentos
                    </label>
                  )}

                  <div className="mt-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Embalagem aberta — quanto sobrou ({insumo.unidade_medida})
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.001"
                        min="0"
                        value={l.aberta}
                        onChange={e => onAlterar(insumo.id, l.key, 'aberta', e.target.value)}
                        placeholder="deixe em branco se não houver"
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                      />
                    </label>
                  </div>

                  {/* A conta aparece pronta: é o que confere com a prateleira. */}
                  {totalLinha(l) > 0 && (
                    <p className="mt-2 text-sm text-gray-600">
                      Total:{' '}
                      <strong className="text-gray-900">
                        {totalLinha(l)} {insumo.unidade_medida}
                      </strong>{' '}
                      <span className="text-gray-400">
                        · {etiquetasLinha(l)} etiqueta{etiquetasLinha(l) === 1 ? '' : 's'}
                      </span>
                    </p>
                  )}

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Um <label> dentro de outro faz o clique no texto do
                        checkbox cair no campo de data. São dois campos. */}
                    <div className="flex flex-col gap-1">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Validade da embalagem
                        </span>
                        <input
                          type="date"
                          value={l.validade}
                          disabled={l.sem_validade}
                          onChange={e => onAlterar(insumo.id, l.key, 'validade', e.target.value)}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm disabled:bg-gray-50 disabled:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                        <input
                          type="checkbox"
                          checked={l.sem_validade}
                          onChange={e => onAlterar(insumo.id, l.key, 'sem_validade', e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Não sei a validade
                      </label>
                    </div>

                    <SeletorComNovo
                      rotulo="Fornecedor (opcional)"
                      vazio="Sem fornecedor"
                      opcoes={fornecedores}
                      valor={l.fornecedor_id}
                      onEscolher={id => {
                        onAlterar(insumo.id, l.key, 'fornecedor_id', id)
                        if (id && l.marca_id) onVincular(insumo.id, l.marca_id, id)
                      }}
                      onCriar={async nome => {
                        const f = await onCriarFornecedor(nome)
                        if (f) {
                          onAlterar(insumo.id, l.key, 'fornecedor_id', f.id)
                          if (l.marca_id) onVincular(insumo.id, l.marca_id, f.id)
                        }
                      }}
                      rotuloNovo="nome do fornecedor"
                      acaoNovo="cadastrar fornecedor"
                    />

                    <SeletorComNovo
                      rotulo="Marca (opcional)"
                      vazio="Sem marca"
                      opcoes={marcas}
                      valor={l.marca_id}
                      onEscolher={id => {
                        onAlterar(insumo.id, l.key, 'marca_id', id)
                        if (id && l.fornecedor_id) onVincular(insumo.id, id, l.fornecedor_id)
                      }}
                      onCriar={async nome => {
                        const m = await onCriarMarca(insumo.id, nome, l.fornecedor_id || undefined)
                        if (m) onAlterar(insumo.id, l.key, 'marca_id', m.id)
                      }}
                      rotuloNovo="nome da marca"
                      acaoNovo="cadastrar marca"
                    />
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => onDesdobrar(insumo.id)}
              className="mt-3 text-xs font-medium text-brand-700 hover:underline"
            >
              + Tenho mais de uma marca ou validade
            </button>
          </Card>
        )
      })}
    </div>
  )
}

/**
 * Um select que também cadastra.
 *
 * No onboarding é a regra, não a exceção: a pessoa descobre que falta a marca
 * exatamente na hora de escolhê-la. Mandá-la para outra tela custaria tudo que
 * ela já digitou aqui.
 */
function SeletorComNovo({
  rotulo,
  vazio,
  opcoes,
  valor,
  onEscolher,
  onCriar,
  rotuloNovo,
  acaoNovo,
}: {
  rotulo: string
  vazio: string
  opcoes: { id: string; nome: string }[]
  valor: string
  onEscolher: (id: string) => void
  onCriar: (nome: string) => Promise<void>
  rotuloNovo: string
  acaoNovo: string
}) {
  const [criando, setCriando] = useState(false)
  const [nome, setNome] = useState('')
  const [salvando, setSalvando] = useState(false)

  async function confirmar() {
    if (!nome.trim()) return
    setSalvando(true)
    await onCriar(nome)
    setSalvando(false)
    setNome('')
    setCriando(false)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{rotulo}</span>

      {criando ? (
        <div className="flex gap-2">
          <input
            autoFocus
            value={nome}
            onChange={e => setNome(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); confirmar() }
              if (e.key === 'Escape') { setCriando(false); setNome('') }
            }}
            placeholder={rotuloNovo}
            className="flex-1 min-w-0 rounded-lg border border-brand-400 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
          />
          <button
            type="button"
            onClick={confirmar}
            disabled={salvando || !nome.trim()}
            className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Salvar
          </button>
          <button
            type="button"
            onClick={() => { setCriando(false); setNome('') }}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          <select
            value={valor}
            onChange={e => onEscolher(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
          >
            <option value="">{vazio}</option>
            {opcoes.map(o => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCriando(true)}
            className="self-start text-xs font-medium text-brand-700 hover:underline"
          >
            + {acaoNovo}
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Tara de uma vez, por tipo de pote.
 *
 * Pote do mesmo tipo pesa o mesmo vazio. Sem isto são 73 pesagens de pote
 * vazio antes de começar o inventário de verdade — com isto, 11.
 *
 * Só aparecem tipos cujos insumos são medidos em peso: descontar gramas de um
 * volume em mL exigiria a densidade, e de "unidades" não faz sentido.
 */
function TarasPorTipo({
  insumos,
  recipientesPorInsumo,
  onSalvarTaraDoTipo,
}: {
  insumos: Insumo[]
  recipientesPorInsumo: Record<string, Recipiente[]>
  onSalvarTaraDoTipo: (tipo: string, tara: number) => Promise<void>
}) {
  const [aberto, setAberto] = useState(true)
  const [valores, setValores] = useState<Record<string, string>>({})
  const [salvando, setSalvando] = useState<string | null>(null)

  const tipos = useMemo(() => {
    const m: Record<string, { potes: Recipiente[]; usaTara: boolean }> = {}
    for (const insumo of insumos) {
      for (const rec of recipientesPorInsumo[insumo.id] ?? []) {
        const t = tipoDoPote(rec.nome, insumo.nome)
        const e = (m[t] ??= { potes: [], usaTara: false })
        e.potes.push(rec)
        if (usaTara(insumo.unidade_medida)) e.usaTara = true
      }
    }
    return Object.entries(m)
      .filter(([, v]) => v.usaTara)
      .sort((a, b) => b[1].potes.length - a[1].potes.length)
  }, [insumos, recipientesPorInsumo])

  if (tipos.length === 0) return null

  const faltando = tipos.filter(([, v]) => v.potes.some(p => !p.peso_tara)).length

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setAberto(a => !a)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span>
          <span className="font-semibold text-gray-900">Peso dos potes vazios (tara)</span>
          <span className="block text-xs text-gray-500 mt-0.5">
            {faltando > 0
              ? `${faltando} de ${tipos.length} tipos ainda sem peso`
              : 'todos os tipos já têm peso'}
          </span>
        </span>
        <span className="text-gray-400 text-sm shrink-0">{aberto ? '▾' : '▸'}</span>
      </button>

      {aberto && (
        <>
          <p className="text-xs text-gray-500 mt-3 mb-3">
            Pote do mesmo tipo pesa o mesmo. Informe uma vez por tipo e vale para todos —
            dá para corrigir um pote específico depois, na lista abaixo.
          </p>
          <div className="space-y-2">
            {tipos.map(([tipo, info]) => {
              const taras = [...new Set(info.potes.map(p => p.peso_tara ?? 0))]
              const atual = taras.length === 1 ? taras[0] : null
              return (
                <div key={tipo} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 text-sm text-gray-700">
                    <span className="block truncate">{tipo}</span>
                    <span className="text-xs text-gray-400">
                      {info.potes.length} pote{info.potes.length === 1 ? '' : 's'}
                      {atual != null && atual > 0 && ` · ${atual} g`}
                      {atual == null && ' · pesos diferentes'}
                    </span>
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={valores[tipo] ?? ''}
                    onChange={e => setValores(v => ({ ...v, [tipo]: e.target.value }))}
                    placeholder={atual ? String(atual) : 'g'}
                    className="w-24 shrink-0 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={!valores[tipo] || salvando === tipo}
                    onClick={async () => {
                      setSalvando(tipo)
                      await onSalvarTaraDoTipo(tipo, parseFloat(valores[tipo]))
                      setSalvando(null)
                    }}
                    className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Aplicar
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Card>
  )
}

// ── Etapa 2 ───────────────────────────────────────────────────
function EtapaBaldes({
  insumos,
  recipientesPorInsumo,
  linhas,
  baldes,
  setBaldes,
  conteudoDoBalde,
  onCriarRecipiente,
  onExcluirRecipiente,
  onSalvarTara,
  onSalvarTaraDoTipo,
}: {
  insumos: Insumo[]
  recipientesPorInsumo: Record<string, Recipiente[]>
  linhas: Record<string, Linha[]>
  baldes: Record<string, Balde>
  setBaldes: React.Dispatch<React.SetStateAction<Record<string, Balde>>>
  conteudoDoBalde: (rec: Recipiente, insumo: Insumo) => number
  onCriarRecipiente: (
    insumo: Insumo,
    dados: { nome: string; capacidade: string; tara: string },
  ) => Promise<boolean>
  onExcluirRecipiente: (rec: Recipiente) => Promise<boolean>
  onSalvarTara: (localId: string, tara: number) => Promise<void>
  onSalvarTaraDoTipo: (tipo: string, tara: number) => Promise<void>
}) {
  // Todos os insumos aparecem, mesmo sem recipiente: é aqui que se descobre
  // que falta cadastrar o pote, e daqui se cadastra.
  const comRecipientes = insumos

  function ajustar(id: string, patch: Partial<Balde>) {
    setBaldes(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  async function salvarTara(rec: Recipiente, valor: string) {
    const tara = parseFloat(valor)
    if (isNaN(tara) || tara < 0) return
    await onSalvarTara(rec.id, tara)
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Agora o que está <strong>dentro dos potes</strong>. Ponha na balança e digite o peso
        que aparece no visor — o sistema desconta a tara sozinho. O que estiver vazio, deixe
        como está.
      </p>

      <TarasPorTipo
        insumos={insumos}
        recipientesPorInsumo={recipientesPorInsumo}
        onSalvarTaraDoTipo={onSalvarTaraDoTipo}
      />

      {comRecipientes.map(insumo => {
        const b = bancada(insumo.unidade_medida)
        const temTara = usaTara(insumo.unidade_medida)
        const opcoes = (linhas[insumo.id] ?? []).filter(l => totalLinha(l) > 0)

        return (
          <Card key={insumo.id} className="p-4">
            <div className="flex items-baseline justify-between gap-2 mb-3">
              <p className="font-semibold text-gray-900 truncate">{insumo.nome}</p>
              <span className="text-xs font-medium text-gray-400 shrink-0">{insumo.codigo}</span>
            </div>

            <div className="space-y-3">
              {(recipientesPorInsumo[insumo.id] ?? []).map(rec => {
                const est = baldes[rec.id]
                const liquido = conteudoDoBalde(rec, insumo)
                const precisaTara = temTara && !rec.peso_tara && est?.modo === 'peso'

                return (
                  <div key={rec.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex items-baseline justify-between gap-2 mb-2">
                      <span className="text-sm font-medium text-gray-800 truncate">{rec.nome}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        {rec.capacidade_max != null && (
                          <span className="text-xs text-gray-400">
                            cabe {rec.capacidade_max} {insumo.unidade_medida}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onExcluirRecipiente(rec)}
                          title="Excluir recipiente"
                          className="text-xs text-red-600 hover:underline"
                        >
                          excluir
                        </button>
                      </span>
                    </div>

                    <div className="flex gap-2">
                      {(['vazio', 'cheio', 'peso'] as const).map(modo => (
                        <button
                          key={modo}
                          onClick={() => ajustar(rec.id, { modo })}
                          className={[
                            'flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                            est?.modo === modo
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-gray-300 text-gray-600 hover:bg-gray-50',
                          ].join(' ')}
                        >
                          {modo === 'vazio' ? 'Vazio' : modo === 'cheio' ? 'Cheio' : 'Pesar'}
                        </button>
                      ))}
                    </div>

                    {/* A tara fica sempre à mão, não só quando falta: é comum
                        descobrir que o valor do tipo não serve para um pote
                        específico bem na hora de pesá-lo. */}
                    {temTara && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-gray-500 shrink-0">Vazio pesa</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          defaultValue={rec.peso_tara ? String(rec.peso_tara) : ''}
                          key={`tara-${rec.id}-${rec.peso_tara ?? 0}`}
                          onBlur={e => salvarTara(rec, e.target.value)}
                          placeholder="—"
                          className={[
                            'w-24 rounded-lg border px-2 py-1.5 text-sm',
                            precisaTara ? 'border-amber-400 bg-amber-50' : 'border-gray-300 bg-white',
                          ].join(' ')}
                        />
                        <span className="text-xs text-gray-500">{b.rotulo}</span>
                        {precisaTara && (
                          <span className="text-xs text-amber-700">informe para poder pesar</span>
                        )}
                      </div>
                    )}

                    {est?.modo === 'peso' && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={est.peso_bruto}
                            onChange={e => ajustar(rec.id, { peso_bruto: e.target.value })}
                            placeholder={`Peso com o pote (${b.rotulo})`}
                            className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/10"
                          />
                          {liquido > 0 && (
                            <span className="text-sm font-semibold text-brand-700 whitespace-nowrap">
                              = {emBancada(liquido, b.fator)} {b.rotulo}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Só aparece quando há mesmo uma escolha a fazer. */}
                    {liquido > 0 && opcoes.length > 1 && (
                      <select
                        value={est?.linha_key ?? ''}
                        onChange={e => ajustar(rec.id, { linha_key: e.target.value })}
                        className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">De qual embalagem veio?</option>
                        {opcoes.map((l, i) => (
                          <option key={l.key} value={l.key}>
                            Embalagem {i + 1}
                            {l.validade ? ` — vence ${l.validade}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>

            <NovoRecipiente insumo={insumo} onCriar={onCriarRecipiente} />
          </Card>
        )
      })}
    </div>
  )
}

/** Cadastro de pote sem sair da contagem — o caso do insumo que ainda não tem. */
function NovoRecipiente({
  insumo,
  onCriar,
}: {
  insumo: Insumo
  onCriar: (
    insumo: Insumo,
    dados: { nome: string; capacidade: string; tara: string },
  ) => Promise<boolean>
}) {
  const [aberto, setAberto] = useState(false)
  const [nome, setNome] = useState('')
  const [capacidade, setCapacidade] = useState('')
  const [tara, setTara] = useState('')
  const [salvando, setSalvando] = useState(false)
  const b = bancada(insumo.unidade_medida)

  async function salvar() {
    if (!nome.trim()) return
    setSalvando(true)
    const ok = await onCriar(insumo, { nome, capacidade, tara })
    setSalvando(false)
    if (ok) {
      setNome(''); setCapacidade(''); setTara(''); setAberto(false)
    }
  }

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="mt-3 text-xs font-medium text-brand-700 hover:underline"
      >
        + cadastrar recipiente para {insumo.nome}
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/50 p-3 space-y-2">
      <input
        autoFocus
        value={nome}
        onChange={e => setNome(e.target.value)}
        placeholder="Nome do pote (ex: Pote G Açúcar #3)"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={capacidade}
          onChange={e => setCapacidade(e.target.value)}
          placeholder={`Limite (${insumo.unidade_medida})`}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"
        />
        <input
          type="number"
          inputMode="decimal"
          value={tara}
          onChange={e => setTara(e.target.value)}
          placeholder={`Peso vazio (${b.rotulo})`}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={salvar}
          disabled={salvando || !nome.trim()}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Salvar recipiente
        </button>
        <button
          type="button"
          onClick={() => setAberto(false)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600"
        >
          Cancelar
        </button>
      </div>
      <p className="text-xs text-gray-500">
        O QR do pote é gerado agora. Imprima a etiqueta depois em Recipientes.
      </p>
    </div>
  )
}

// ── Etapa 3 ───────────────────────────────────────────────────
function EtapaConferir({
  resumo,
  problemas,
  insumos,
}: {
  resumo: {
    totalPrateleira: number
    totalBaldes: number
    insumosComSaldo: number
    etiquetas: number
    potesCheios: number
  }
  problemas: string[]
  insumos: Insumo[]
}) {
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">O que vai ser criado</p>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Item rotulo="Insumos com saldo" valor={`${resumo.insumosComSaldo} de ${insumos.length}`} />
          <Item rotulo="Etiquetas a imprimir" valor={String(resumo.etiquetas)} />
          <Item rotulo="Potes com conteúdo" valor={String(resumo.potesCheios)} />
          <Item
            rotulo="Total lançado"
            valor={`${(resumo.totalPrateleira + resumo.totalBaldes).toFixed(3)}`}
          />
        </dl>
        <p className="text-xs text-gray-500 mt-3">
          Os lotes nascem marcados como <strong>saldo de abertura</strong>, não como compra —
          assim eles não entram nos relatórios de entrada nem atrapalham o primeiro
          fechamento de perdas.
        </p>
      </Card>

      {problemas.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800 mb-1.5">Falta resolver:</p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-red-700">
            {problemas.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Ao confirmar, o sistema abre a página de impressão com as etiquetas dos lotes da
          prateleira. Cole cada uma na embalagem correspondente — é o QR delas que fará a
          transferência e a produção funcionarem daqui pra frente.
        </div>
      )}
    </div>
  )
}

function Item({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{rotulo}</dt>
      <dd className="text-lg font-semibold text-gray-900">{valor}</dd>
    </div>
  )
}

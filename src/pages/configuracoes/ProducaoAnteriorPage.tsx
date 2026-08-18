import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'

/**
 * PRODUÇÃO ANTERIOR AO SISTEMA — o que a fábrica fez antes de existir MischaOS.
 *
 * Meses de produção que não têm insumo rastreado, balde pesado nem lote de
 * produto. Têm o número que interessa para comparar: quantas unidades de cada
 * produto saíram em cada dia.
 *
 * O que esta tela NÃO faz, de propósito: mexer em estoque, recipiente ou
 * validade. É registro histórico. A sessão nasce fechada, marcada como
 * importada, e fica fora da fila da pós-produção.
 *
 * DUAS ENTRADAS. A grade serve para lançar um punhado de dias com o teclado.
 * A colagem serve para quem já tem a lista pronta numa planilha ou num
 * caderno digitado — e é o caso comum, porque ninguém guarda meio ano de
 * produção na cabeça, guarda numa tabela.
 */

type Ficha = { id: string; codigo: string; nome: string }

type Linha = {
  key: string
  data: string       // YYYY-MM-DD
  fichaId: string
  unidades: string   // texto enquanto se digita
}

type Importada = {
  id: string
  codigo: string
  data_producao: string
  // O embed do PostgREST vem como lista mesmo quando a relação é para-um.
  skus: { quantidade_produzida: number | null; fichas_tecnicas: { nome: string }[] | null }[]
}

let seq = 0
const novaKey = () => `L${++seq}`

const linhaVazia = (data = ''): Linha => ({ key: novaKey(), data, fichaId: '', unidades: '' })

/** 2026-07-11 → 11/07/2026. Montado componente a componente: `new Date` de
 *  string YYYY-MM-DD é meia-noite UTC e no Brasil cai no dia anterior. */
function brDate(iso: string): string {
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

/**
 * Interpreta o que foi colado.
 *
 * Aceita `11/07/2026`, `11/07/26` e `2026-07-11`, separados por tabulação,
 * ponto-e-vírgula, vírgula ou dois espaços — que é o que sai de planilha, de
 * bloco de notas e de mensagem de WhatsApp. O produto casa por código
 * (`FT-001`), por nome inteiro ou por pedaço do nome, sem acento e sem ligar
 * para maiúscula: quem digitou "morena cacau" quer o Morena Cacau.
 *
 * A quantidade aceita `3.600` e `3600`. Ponto como separador de milhar é o
 * padrão brasileiro, e nenhuma produção sai em fração de unidade.
 */
function interpretar(texto: string, fichas: Ficha[]): { linhas: Linha[]; erros: string[] } {
  // `\p{Diacritic}` em vez da faixa literal de acentos combinantes: a faixa
  // é invisível no editor e qualquer ferramenta que normalize o arquivo a
  // apaga sem avisar.
  const limpo = (s: string) =>
    s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

  const linhas: Linha[] = []
  const erros: string[] = []

  texto.split(/\r?\n/).forEach((bruta, i) => {
    const linha = bruta.trim()
    if (!linha) return

    const partes = linha.split(/\t|;|,|\s{2,}/).map(p => p.trim()).filter(Boolean)

    // Sem separador claro, tenta o formato solto "11/07/2026 FT-001 3600".
    const campos = partes.length >= 3 ? partes : linha.split(/\s+/)
    if (campos.length < 3) {
      erros.push(`Linha ${i + 1}: esperava data, produto e quantidade.`)
      return
    }

    const dataBruta = campos[0]
    const qtdBruta = campos[campos.length - 1]
    const produtoBruto = campos.slice(1, -1).join(' ')

    let iso = ''
    const br = dataBruta.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
    const isoM = dataBruta.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (br) {
      const ano = br[3].length === 2 ? `20${br[3]}` : br[3]
      iso = `${ano}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`
    } else if (isoM) {
      iso = dataBruta
    } else {
      erros.push(`Linha ${i + 1}: "${dataBruta}" não parece uma data.`)
      return
    }

    const alvo = limpo(produtoBruto)
    const ficha =
      fichas.find(f => limpo(f.codigo) === alvo) ??
      fichas.find(f => limpo(f.nome) === alvo) ??
      fichas.find(f => limpo(f.nome).includes(alvo)) ??
      fichas.find(f => alvo.includes(limpo(f.nome)))

    if (!ficha) {
      erros.push(`Linha ${i + 1}: não achei o produto "${produtoBruto}".`)
      return
    }

    const qtd = parseInt(qtdBruta.replace(/\./g, '').replace(/\s/g, ''), 10)
    if (!Number.isFinite(qtd) || qtd <= 0) {
      erros.push(`Linha ${i + 1}: "${qtdBruta}" não é uma quantidade.`)
      return
    }

    linhas.push({ key: novaKey(), data: iso, fichaId: ficha.id, unidades: String(qtd) })
  })

  return { linhas, erros }
}

export function ProducaoAnteriorPage() {
  const { profile } = useAuth()

  const [fichas, setFichas] = useState<Ficha[]>([])
  const [linhas, setLinhas] = useState<Linha[]>([linhaVazia()])
  const [importadas, setImportadas] = useState<Importada[]>([])
  const [colagem, setColagem] = useState('')
  const [mostrarColagem, setMostrarColagem] = useState(false)
  const [errosColagem, setErrosColagem] = useState<string[]>([])
  const [erro, setErro] = useState('')
  const [ok, setOk] = useState('')
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    if (!profile?.empresa_id) return

    supabase
      .from('fichas_tecnicas')
      .select('id, codigo, nome')
      .eq('empresa_id', profile.empresa_id)
      .eq('ativo', true)
      .eq('tipo', 'produto')
      .order('codigo')
      .then(({ data }) => setFichas((data as Ficha[]) ?? []))

    carregarImportadas()
  }, [profile?.empresa_id])

  async function carregarImportadas() {
    if (!profile?.empresa_id) return
    const { data } = await supabase
      .from('sessoes_producao')
      .select('id, codigo, data_producao, skus:sessoes_producao_skus(quantidade_produzida, fichas_tecnicas(nome))')
      .eq('empresa_id', profile.empresa_id)
      .eq('importada', true)
      .order('data_producao', { ascending: false })
    setImportadas((data as Importada[]) ?? [])
  }

  const preenchidas = useMemo(
    () => linhas.filter(l => l.data && l.fichaId && parseInt(l.unidades, 10) > 0),
    [linhas],
  )

  const totalUnidades = preenchidas.reduce((a, l) => a + parseInt(l.unidades, 10), 0)
  const dias = new Set(preenchidas.map(l => l.data)).size

  /** Dias que já existem no banco. Conferir aqui evita mandar a importação
   *  inteira para o servidor só para ouvir "esse dia já tem produção". */
  const jaExistem = useMemo(() => {
    const existentes = new Set(importadas.map(s => s.data_producao))
    return new Set(preenchidas.filter(l => existentes.has(l.data)).map(l => l.data))
  }, [preenchidas, importadas])

  /** O mesmo produto duas vezes no mesmo dia viraria erro no servidor. */
  const repetidas = useMemo(() => {
    const contagem = new Map<string, number>()
    preenchidas.forEach(l => {
      const k = `${l.data}|${l.fichaId}`
      contagem.set(k, (contagem.get(k) ?? 0) + 1)
    })
    return new Set([...contagem.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  }, [preenchidas])

  function alterar(key: string, campo: keyof Linha, valor: string) {
    setLinhas(ls => ls.map(l => (l.key === key ? { ...l, [campo]: valor } : l)))
  }

  /** A linha nova herda a data da última: um dia costuma ter dois sabores, e
   *  redigitar a data a cada linha era o atrito da primeira versão. */
  function adicionar() {
    setLinhas(ls => [...ls, linhaVazia(ls[ls.length - 1]?.data ?? '')])
  }

  function remover(key: string) {
    setLinhas(ls => (ls.length === 1 ? [linhaVazia()] : ls.filter(l => l.key !== key)))
  }

  function aplicarColagem() {
    const { linhas: novas, erros } = interpretar(colagem, fichas)
    setErrosColagem(erros)
    if (novas.length === 0) return
    // Substitui as linhas em branco; soma às que já foram digitadas.
    setLinhas(ls => {
      const uteis = ls.filter(l => l.data || l.fichaId || l.unidades)
      return [...uteis, ...novas]
    })
    setColagem('')
    setMostrarColagem(false)
  }

  async function importar() {
    if (!profile?.empresa_id || !profile?.id) return
    setErro('')
    setOk('')
    setSalvando(true)

    const { data, error } = await supabase.rpc('importar_producao_historica', {
      p_empresa_id: profile.empresa_id,
      p_responsavel_id: profile.id,
      p_itens: preenchidas.map(l => ({
        data: l.data,
        ficha_id: l.fichaId,
        unidades: parseInt(l.unidades, 10),
      })),
    })

    const res = data as { ok: boolean; erro?: string; sessoes?: number; unidades?: number } | null

    if (error || !res?.ok) {
      setErro(error?.message ?? res?.erro ?? 'Não foi possível importar.')
      setSalvando(false)
      return
    }

    setOk(`${res.sessoes} ${res.sessoes === 1 ? 'dia lançado' : 'dias lançados'} — ${(res.unidades ?? 0).toLocaleString('pt-BR')} unidades.`)
    setLinhas([linhaVazia()])
    await carregarImportadas()
    setSalvando(false)
  }

  async function apagar(sessao: Importada) {
    if (!profile?.empresa_id) return
    if (!confirm(`Apagar a produção de ${brDate(sessao.data_producao)} (${sessao.codigo})?`)) return

    const { data, error } = await supabase.rpc('remover_producao_importada', {
      p_empresa_id: profile.empresa_id,
      p_sessao_id: sessao.id,
    })
    const res = data as { ok: boolean; erro?: string } | null
    if (error || !res?.ok) {
      setErro(error?.message ?? res?.erro ?? 'Não foi possível apagar.')
      return
    }
    await carregarImportadas()
  }

  const podeImportar =
    preenchidas.length > 0 && jaExistem.size === 0 && repetidas.size === 0 && !salvando

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <Link to="/configuracoes" className="text-sm text-brand-600 hover:underline">
          ← Configurações
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-unno-text mt-2">
          Produção anterior ao sistema
        </h1>
        <p className="text-sm text-gray-600 dark:text-unno-muted mt-1">
          O que a fábrica produziu antes de o MischaOS existir. Entra só como
          registro: não mexe no estoque, nos baldes nem na validade de nada.
        </p>
      </div>

      {fichas.length === 0 && (
        <Card className="p-4 border-amber-300 bg-amber-50 dark:bg-amber-500/10">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Nenhuma ficha técnica de produto cadastrada — é ela que diz quantas
            unidades saem por forma. Cadastre em Fichas Técnicas antes de importar.
          </p>
        </Card>
      )}

      <Card className="p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900 dark:text-unno-text">Dias produzidos</h2>
          <Button size="sm" variant="ghost" onClick={() => setMostrarColagem(v => !v)}>
            {mostrarColagem ? 'Fechar' : 'Colar lista'}
          </Button>
        </div>

        {mostrarColagem && (
          <div className="mb-5 p-3 rounded-lg bg-gray-50 dark:bg-white/[.03] space-y-2">
            <p className="text-xs text-gray-600 dark:text-unno-muted">
              Uma linha por produção: <strong>data, produto, unidades</strong>.
              O produto pode ser o código ou o nome. Exemplo:
            </p>
            <pre className="text-xs bg-white dark:bg-unno-bg p-2 rounded border border-gray-200 dark:border-white/[.08] overflow-x-auto">
{`11/07/2026; Brownie Tradicional; 3600
11/07/2026; Doce de Leite; 1800
14/07/2026; FT-001; 4200`}
            </pre>
            <textarea
              value={colagem}
              onChange={e => setColagem(e.target.value)}
              rows={6}
              className="w-full text-sm rounded-lg border border-gray-300 dark:border-white/[.08] dark:bg-unno-bg dark:text-unno-text p-2 font-mono"
              placeholder="Cole aqui"
            />
            {errosColagem.length > 0 && (
              <ul className="text-xs text-red-600 dark:text-unno-danger space-y-0.5">
                {errosColagem.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            <Button size="sm" onClick={aplicarColagem} disabled={!colagem.trim()}>
              Passar para a grade
            </Button>
          </div>
        )}

        <div className="space-y-2">
          {linhas.map(l => {
            const diaOcupado = l.data && jaExistem.has(l.data)
            const repetida = repetidas.has(`${l.data}|${l.fichaId}`)
            return (
              <div key={l.key}>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="date"
                    value={l.data}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={e => alterar(l.key, 'data', e.target.value)}
                    className="sm:w-40 rounded-lg border border-gray-300 dark:border-white/[.08] dark:bg-unno-bg dark:text-unno-text px-3 py-2 text-sm min-h-[44px]"
                  />
                  <select
                    value={l.fichaId}
                    onChange={e => alterar(l.key, 'fichaId', e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 dark:border-white/[.08] dark:bg-unno-bg dark:text-unno-text px-3 py-2 text-sm min-h-[44px]"
                  >
                    <option value="">Produto…</option>
                    {fichas.map(f => (
                      <option key={f.id} value={f.id}>{f.codigo} — {f.nome}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={l.unidades}
                    onChange={e => alterar(l.key, 'unidades', e.target.value)}
                    placeholder="unidades"
                    className="sm:w-32 rounded-lg border border-gray-300 dark:border-white/[.08] dark:bg-unno-bg dark:text-unno-text px-3 py-2 text-sm min-h-[44px]"
                  />
                  <button
                    onClick={() => remover(l.key)}
                    className="sm:w-11 min-h-[44px] rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm"
                    title="Remover linha"
                  >
                    ✕
                  </button>
                </div>
                {diaOcupado && (
                  <p className="text-xs text-red-600 dark:text-unno-danger mt-1">
                    {brDate(l.data)} já tem produção registrada. Apague a de baixo ou mude a data.
                  </p>
                )}
                {repetida && (
                  <p className="text-xs text-red-600 dark:text-unno-danger mt-1">
                    Este produto aparece duas vezes neste dia. Some as quantidades numa linha só.
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <Button size="sm" variant="ghost" onClick={adicionar} className="mt-3">
          + Adicionar dia
        </Button>
      </Card>

      {erro && (
        <Card className="p-4 border-red-300 bg-red-50 dark:bg-red-500/10">
          <p className="text-sm text-red-700 dark:text-unno-danger whitespace-pre-line">{erro}</p>
        </Card>
      )}

      {ok && (
        <Card className="p-4 border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10">
          <p className="text-sm text-emerald-700 dark:text-emerald-300">{ok}</p>
        </Card>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <p className="text-sm text-gray-600 dark:text-unno-muted">
          {preenchidas.length === 0
            ? 'Nenhuma linha preenchida ainda.'
            : `${dias} ${dias === 1 ? 'dia' : 'dias'} · ${totalUnidades.toLocaleString('pt-BR')} unidades`}
        </p>
        <Button size="lg" onClick={importar} disabled={!podeImportar} loading={salvando}>
          Importar produção
        </Button>
      </div>

      {importadas.length > 0 && (
        <Card className="p-4 sm:p-5">
          <h2 className="font-semibold text-gray-900 dark:text-unno-text mb-1">Já importado</h2>
          <p className="text-xs text-gray-500 dark:text-unno-muted mb-4">
            Só o que veio desta tela aparece aqui — produção de verdade não pode ser
            apagada por aqui.
          </p>
          <div className="divide-y divide-gray-100 dark:divide-white/[.06]">
            {importadas.map(s => (
              <div key={s.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
                    {brDate(s.data_producao)}
                    <span className="text-gray-400 font-normal ml-2">{s.codigo}</span>
                  </p>
                  <p className="text-xs text-gray-600 dark:text-unno-muted">
                    {s.skus.map((sk, i) => (
                      <span key={i}>
                        {i > 0 && ' · '}
                        {sk.fichas_tecnicas?.[0]?.nome ?? '?'}: {(sk.quantidade_produzida ?? 0).toLocaleString('pt-BR')}
                      </span>
                    ))}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => apagar(s)}>Apagar</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

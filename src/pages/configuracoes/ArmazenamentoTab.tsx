import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { ordemNatural } from '../../lib/utils'
import { combina } from '../../lib/busca'
import {
  FORMATOS_PORCAO, MODOS_EP, exigePorcao, modoEp,
  payloadArmazenamento, type ModoEp,
} from '../../lib/armazenamento'

/**
 * Armazenamento no EP de todos os insumos, numa tela só.
 *
 * A configuração já existia no cadastro de cada insumo, e para uma operação em
 * andamento isso basta — mexe-se num insumo de vez em quando. O problema é o
 * começo: um cliente novo chega com 40, 80 insumos e nenhum configurado, e a
 * primeira tarefa dele no módulo seria abrir e salvar oitenta modais.
 *
 * Aqui ele filtra, marca vários e aplica o mesmo modo de uma vez. O que muda
 * fica destacado até salvar, porque aplicar em bloco é fácil de fazer sem
 * querer — e o salvar é um só, no fim.
 */

type Linha = {
  id: string
  codigo: string
  nome: string
  unidade: string
  modo: ModoEp
  porcaoTamanho: string
  porcaoUnidade: string
  porcaoFormato: string
  /** Como veio do banco, para saber o que mudou. */
  original: string
  temCaixa: boolean
}

const UNIDADES = ['kg', 'g', 'L', 'ml', 'unid']

function assinatura(l: Linha): string {
  return [l.modo, l.porcaoTamanho, l.porcaoUnidade, l.porcaoFormato].join('|')
}

export function ArmazenamentoTab() {
  const { profile } = useAuth()
  const [linhas, setLinhas] = useState<Linha[]>([])
  const [marcados, setMarcados] = useState<Set<string>>(new Set())
  const [busca, setBusca] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const [ok, setOk] = useState('')

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase
        .from('insumos')
        .select('id, codigo, nome, unidade_medida')
        .eq('empresa_id', profile.empresa_id)
        .eq('ativo', true),
      supabase
        .from('insumos_armazenamento_config')
        .select('insumo_id, modo_ep, reembalagem_tamanho_porcao, reembalagem_unidade, reembalagem_formato'),
      // Quais insumos já têm a caixa onde as porções ficam.
      supabase
        .from('locais')
        .select('insumo_id')
        .eq('empresa_id', profile.empresa_id)
        .eq('subtipo', 'saco_confeitar')
        .eq('ativo', true),
    ]).then(([insRes, cfgRes, caixaRes]) => {
      const cfg = new Map(
        ((cfgRes.data ?? []) as {
          insumo_id: string; modo_ep: string
          reembalagem_tamanho_porcao: number | null
          reembalagem_unidade: string | null; reembalagem_formato: string | null
        }[]).map(c => [c.insumo_id, c]),
      )
      const comCaixa = new Set(((caixaRes.data ?? []) as { insumo_id: string | null }[])
        .map(c => c.insumo_id).filter(Boolean) as string[])

      const lista: Linha[] = ((insRes.data ?? []) as {
        id: string; codigo: string; nome: string; unidade_medida: string
      }[])
        .map(i => {
          const c = cfg.get(i.id)
          const linha: Linha = {
            id: i.id,
            codigo: i.codigo,
            nome: i.nome,
            unidade: i.unidade_medida,
            modo: modoEp(c?.modo_ep),
            porcaoTamanho: c?.reembalagem_tamanho_porcao?.toString() ?? '',
            porcaoUnidade: c?.reembalagem_unidade ?? 'g',
            porcaoFormato: c?.reembalagem_formato ?? 'saco_confeitar',
            original: '',
            temCaixa: comCaixa.has(i.id),
          }
          linha.original = assinatura(linha)
          return linha
        })
        .sort((a, b) => ordemNatural(a.codigo, b.codigo))

      setLinhas(lista)
      setCarregando(false)
    })
  }, [profile])

  const filtradas = linhas.filter(l => combina(busca, l.nome, l.codigo))

  const alteradas = linhas.filter(l => assinatura(l) !== l.original)
  const semPorcao = alteradas.filter(l => exigePorcao(l.modo) && !(parseFloat(l.porcaoTamanho) > 0))

  function mudar(id: string, campos: Partial<Linha>) {
    setOk('')
    setLinhas(prev => prev.map(l => (l.id === id ? { ...l, ...campos } : l)))
  }

  function alternar(id: string) {
    setMarcados(prev => {
      const p = new Set(prev)
      if (p.has(id)) p.delete(id)
      else p.add(id)
      return p
    })
  }

  /** Aplica o modo a todos os marcados de uma vez — o motivo desta tela. */
  function aplicarEmBloco(modo: ModoEp) {
    setOk('')
    setLinhas(prev => prev.map(l => (marcados.has(l.id) ? { ...l, modo } : l)))
  }

  async function salvar() {
    setErro('')
    if (semPorcao.length > 0) {
      setErro(
        'Falta o tamanho da porção em: '
        + semPorcao.map(l => l.codigo).join(', ')
        + '. Sem ele o sistema não sabe por quantos dividir o pacote.',
      )
      return
    }
    setSalvando(true)
    const { error } = await supabase
      .from('insumos_armazenamento_config')
      .upsert(
        alteradas.map(l => payloadArmazenamento(l.id, l.modo, {
          tamanho: l.porcaoTamanho, unidade: l.porcaoUnidade, formato: l.porcaoFormato,
        })),
        { onConflict: 'insumo_id' },
      )
    setSalvando(false)
    if (error) { setErro(error.message); return }

    setLinhas(prev => prev.map(l => ({ ...l, original: assinatura(l) })))
    setMarcados(new Set())
    setOk(`${alteradas.length} insumo${alteradas.length > 1 ? 's' : ''} salvo${alteradas.length > 1 ? 's' : ''}.`)
    setTimeout(() => setOk(''), 4000)
  }

  if (carregando) {
    return <Card className="p-5"><p className="text-sm text-gray-500">Carregando…</p></Card>
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Armazenamento no estoque produtivo</h2>
        <p className="text-sm text-gray-500">
          Como cada insumo fica na produção. É o que decide quantos bipes a
          transferência pede: um pote da cozinha precisa que o operador escaneie o
          destino; a embalagem do fornecedor, não.
        </p>
        <p className="text-sm text-gray-500 mt-2">
          Dá para configurar um por um no cadastro do insumo. Aqui é para fazer
          vários de uma vez — marque as linhas e aplique o mesmo modo.
        </p>
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Buscar insumo..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            className="flex-1 min-w-[12rem] rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            type="button"
            onClick={() => setMarcados(
              marcados.size === filtradas.length
                ? new Set()
                : new Set(filtradas.map(l => l.id)),
            )}
            className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-800 px-3 py-2"
          >
            {marcados.size === filtradas.length ? 'Desmarcar todos' : 'Marcar todos'}
            {busca && ' (do filtro)'}
          </button>
        </div>

        {marcados.size > 0 && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
            <p className="text-sm font-medium text-brand-900 mb-2">
              Aplicar a {marcados.size} insumo{marcados.size > 1 ? 's' : ''} marcado
              {marcados.size > 1 ? 's' : ''}:
            </p>
            <div className="flex flex-wrap gap-2">
              {MODOS_EP.map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => aplicarEmBloco(m.value)}
                  className="px-3 py-1.5 rounded-lg border border-brand-300 bg-white text-xs font-medium text-brand-700 hover:bg-brand-100"
                >
                  {m.titulo}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-[32rem] overflow-y-auto">
          {filtradas.map(l => {
            const mudou = assinatura(l) !== l.original
            return (
              <div key={l.id} className={`p-3 ${mudou ? 'bg-amber-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={marcados.has(l.id)}
                    onChange={() => alternar(l.id)}
                    className="rounded mt-1 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs text-gray-400 shrink-0">{l.codigo}</span>
                      <span className="text-sm font-medium text-gray-900 truncate">{l.nome}</span>
                      {mudou && (
                        <span className="text-[0.65rem] font-semibold uppercase text-amber-700 shrink-0">
                          alterado
                        </span>
                      )}
                    </div>

                    <select
                      value={l.modo}
                      onChange={e => mudar(l.id, { modo: e.target.value as ModoEp })}
                      className="mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:border-brand-500"
                    >
                      {MODOS_EP.map(m => (
                        <option key={m.value} value={m.value}>{m.titulo}</option>
                      ))}
                    </select>

                    {exigePorcao(l.modo) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="number" inputMode="decimal" step="0.001" min="0"
                          placeholder="porção"
                          value={l.porcaoTamanho}
                          onChange={e => mudar(l.id, { porcaoTamanho: e.target.value })}
                          className={`w-24 rounded-lg border px-2 py-1.5 text-sm text-right ${
                            parseFloat(l.porcaoTamanho) > 0 ? 'border-gray-300' : 'border-red-400'
                          }`}
                        />
                        <select
                          value={l.porcaoUnidade}
                          onChange={e => mudar(l.id, { porcaoUnidade: e.target.value })}
                          className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                        >
                          {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                        <select
                          value={l.porcaoFormato}
                          onChange={e => mudar(l.id, { porcaoFormato: e.target.value })}
                          className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm"
                        >
                          {FORMATOS_PORCAO.map(f => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </select>
                        {!l.temCaixa && (
                          <span className="text-xs text-amber-700">
                            falta a caixa — crie no cadastro deste insumo
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {filtradas.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-gray-500">Nenhum insumo encontrado.</p>
          )}
        </div>

        {erro && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{erro}</div>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={salvar} loading={salvando} disabled={alteradas.length === 0}>
            {alteradas.length > 0
              ? `Salvar ${alteradas.length} alteração${alteradas.length > 1 ? 'ões' : ''}`
              : 'Salvar'}
          </Button>
          {ok && <span className="text-sm text-emerald-600">{ok}</span>}
        </div>
      </Card>
    </div>
  )
}

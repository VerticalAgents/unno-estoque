import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ordemNatural } from '../../lib/utils'
import { Button } from '../../components/ui/Button'
import {
  EtiquetaRecipienteContent,
  SUBTIPO_LABELS,
  type RecipienteEtiqueta,
} from '../../components/etiqueta/EtiquetaRecipiente'
import {
  EtiquetaCanvas,
  EtiquetaFolhaImpressao,
  EtiquetaLinhaRolo,
  copiasDoSubtipo,
  emLinhas,
  etiquetaPrintStyles,
  useCopiasRecipiente,
  useEtiquetaConfig,
} from '../../lib/etiquetas'

/**
 * Impressão de etiquetas de recipiente em massa.
 *
 * Antes só dava para imprimir uma de cada vez, entrando no recipiente. Para
 * etiquetar o estoque inteiro isso são dezenas de idas e voltas — e o pior:
 * cada impressão é uma linha do rolo, então sobrava papel entre uma e outra
 * num rolo de várias colunas.
 *
 * A quantidade de cópias vem do TIPO (migration 072): balde sai duas vezes,
 * corpo e tampa; garrafa, uma. Quem imprime não precisa decidir isso etiqueta
 * por etiqueta.
 */

type Recipiente = RecipienteEtiqueta & { ativo: boolean }

/** Uma etiqueta a imprimir: o recipiente mais qual cópia dele é. */
type Etiqueta = { recipiente: Recipiente; copia: number }

export function ImpressaoRecipientesPage() {
  const { profile } = useAuth()
  const { config } = useEtiquetaConfig('recipiente')
  const { copias } = useCopiasRecipiente()

  const [recipientes, setRecipientes] = useState<Recipiente[]>([])
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set())
  const [busca, setBusca] = useState('')
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    if (!profile) return
    supabase
      .from('locais')
      .select('*, insumo:insumos(id, nome, codigo, unidade_medida)')
      .eq('empresa_id', profile.empresa_id)
      .eq('tipo', 'estoque_produtivo')
      .then(({ data }) => {
        // Ordem natural: "Pote G #10" depois de "#2", e não antes.
        const lista = ((data ?? []) as unknown as Recipiente[])
          .sort((a, b) => ordemNatural(a.nome, b.nome))
        setRecipientes(lista)
        // Começa com os ativos marcados: quem abre esta tela quer imprimir
        // tudo. Desmarcar o que não quer é menos trabalho que marcar 70.
        setSelecionados(new Set(lista.filter(r => r.ativo).map(r => r.id)))
        setCarregando(false)
      })
  }, [profile])

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase()
    if (!q) return recipientes
    return recipientes.filter(r =>
      r.nome.toLowerCase().includes(q)
      || (SUBTIPO_LABELS[r.subtipo ?? ''] ?? '').toLowerCase().includes(q)
      || (r.insumo?.nome ?? '').toLowerCase().includes(q),
    )
  }, [recipientes, busca])

  // A lista final já expandida em cópias — é o que vai para o papel.
  const etiquetas: Etiqueta[] = useMemo(() => {
    const saida: Etiqueta[] = []
    for (const r of recipientes) {
      if (!selecionados.has(r.id)) continue
      const n = copiasDoSubtipo(copias, r.subtipo)
      for (let i = 1; i <= n; i++) saida.push({ recipiente: r, copia: i })
    }
    return saida
  }, [recipientes, selecionados, copias])

  const linhas = emLinhas(etiquetas, config.colunas)

  function alternar(id: string) {
    setSelecionados(prev => {
      const proximo = new Set(prev)
      if (proximo.has(id)) proximo.delete(id)
      else proximo.add(id)
      return proximo
    })
  }

  function marcarTodos(marcar: boolean) {
    setSelecionados(prev => {
      const proximo = new Set(prev)
      for (const r of filtrados) {
        if (marcar) proximo.add(r.id)
        else proximo.delete(r.id)
      }
      return proximo
    })
  }

  if (carregando) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const marcadosNoFiltro = filtrados.filter(r => selecionados.has(r.id)).length

  return (
    <>
      <style>{etiquetaPrintStyles(config)}</style>

      <div className="etiqueta-screen-ui p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="mb-5">
          <Link to="/recipientes" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Recipientes
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Imprimir etiquetas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {etiquetas.length} etiqueta{etiquetas.length === 1 ? '' : 's'} de{' '}
            {selecionados.size} recipiente{selecionados.size === 1 ? '' : 's'}
            {' · '}{config.largura}×{config.altura}mm
            {config.colunas > 1 && ` · ${linhas.length} linha${linhas.length === 1 ? '' : 's'} do rolo`}
          </p>
        </div>

        {/* Quantas cópias cada tipo está levando — visível antes de imprimir,
            porque é o número que multiplica o rolo inteiro. */}
        <ResumoCopias etiquetas={etiquetas} />

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            type="text"
            placeholder="Buscar recipiente, tipo ou insumo..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            className="flex-1 min-w-[12rem] rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={() => marcarTodos(marcadosNoFiltro < filtrados.length)}
            className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-800 px-3 py-2"
          >
            {marcadosNoFiltro < filtrados.length ? 'Marcar todos' : 'Desmarcar todos'}
            {busca && ' (do filtro)'}
          </button>
        </div>

        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 mb-5 max-h-96 overflow-y-auto">
          {filtrados.map(r => {
            const n = copiasDoSubtipo(copias, r.subtipo)
            return (
              <label key={r.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selecionados.has(r.id)}
                  onChange={() => alternar(r.id)}
                  className="rounded shrink-0"
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-gray-900 truncate">{r.nome}</span>
                  <span className="block text-xs text-gray-500 truncate">
                    {SUBTIPO_LABELS[r.subtipo ?? ''] ?? r.subtipo ?? '—'}
                    {r.insumo?.nome ? ` · ${r.insumo.nome}` : ''}
                    {!r.ativo && ' · inativo'}
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
                  n > 1 ? 'bg-brand-50 text-brand-700' : 'text-gray-400'
                }`}>
                  {n}×
                </span>
              </label>
            )
          })}
          {filtrados.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-gray-500">
              Nenhum recipiente encontrado.
            </p>
          )}
        </div>

        {etiquetas.length > 0 && (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
              Como vai sair no papel
            </p>
            <div className="space-y-3 mb-5 overflow-x-auto">
              {linhas.map((linha, i) => (
                <div key={i} className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-3 inline-block">
                  <p className="text-xs font-medium text-gray-400 mb-2">
                    {config.colunas > 1
                      ? `Linha ${i + 1} de ${linhas.length}`
                      : `Etiqueta ${i + 1} de ${linhas.length}`}
                  </p>
                  <EtiquetaLinhaRolo config={config}>
                    {linha.map(e => (
                      <EtiquetaCanvas key={`${e.recipiente.id}-${e.copia}`} dims={config}>
                        <EtiquetaRecipienteContent recipiente={e.recipiente} dims={config} />
                      </EtiquetaCanvas>
                    ))}
                  </EtiquetaLinhaRolo>
                </div>
              ))}
            </div>

            {config.colunas > 1 && etiquetas.length % config.colunas !== 0 && (
              <p className="text-xs text-gray-500 mb-4 -mt-2">
                A última linha tem {config.colunas - (etiquetas.length % config.colunas)} etiqueta(s)
                em branco — o rolo avança a linha inteira mesmo assim.
              </p>
            )}
          </>
        )}

        <Button
          size="lg"
          fullWidth
          disabled={etiquetas.length === 0}
          onClick={() => window.print()}
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
            </svg>
          }
        >
          Imprimir {etiquetas.length} etiqueta{etiquetas.length === 1 ? '' : 's'}
        </Button>

        <p className="text-xs text-gray-400 text-center mt-3">
          Quantas cópias cada tipo leva se configura em{' '}
          <Link to="/configuracoes" className="text-brand-600 hover:underline">
            Configurações → Etiquetas
          </Link>.
        </p>
      </div>

      {/* Print target — uma página por linha do rolo */}
      <EtiquetaFolhaImpressao>
        {linhas.map((linha, i) => (
          <div key={i} className={i < linhas.length - 1 ? 'etiqueta-page-break' : ''}>
            <EtiquetaLinhaRolo config={config}>
              {linha.map(e => (
                <EtiquetaCanvas key={`${e.recipiente.id}-${e.copia}`} dims={config}>
                  <EtiquetaRecipienteContent recipiente={e.recipiente} dims={config} />
                </EtiquetaCanvas>
              ))}
            </EtiquetaLinhaRolo>
          </div>
        ))}
      </EtiquetaFolhaImpressao>
    </>
  )
}

/** Quantas etiquetas cada tipo está contribuindo para o total. */
function ResumoCopias({ etiquetas }: { etiquetas: Etiqueta[] }) {
  const porTipo = new Map<string, { recipientes: Set<string>; etiquetas: number }>()
  for (const e of etiquetas) {
    const chave = e.recipiente.subtipo ?? ''
    const atual = porTipo.get(chave) ?? { recipientes: new Set<string>(), etiquetas: 0 }
    atual.recipientes.add(e.recipiente.id)
    atual.etiquetas += 1
    porTipo.set(chave, atual)
  }
  if (porTipo.size === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {[...porTipo.entries()].map(([subtipo, dados]) => (
        <span key={subtipo} className="text-xs bg-gray-100 text-gray-600 rounded-full px-3 py-1">
          {SUBTIPO_LABELS[subtipo] ?? subtipo ?? '—'}: {dados.recipientes.size} ×{' '}
          {Math.round(dados.etiquetas / dados.recipientes.size)} = <strong>{dados.etiquetas}</strong>
        </span>
      ))}
    </div>
  )
}

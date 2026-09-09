import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { formatDate, ordemNatural } from '../../lib/utils'
import { codigoCurtoLote } from '../../lib/qr'

/**
 * Tudo que ainda não foi para a impressora, num lugar só.
 *
 * Antes, para saber o que faltava etiquetar era preciso abrir a lista de
 * recebimentos, procurar o aviso, e depois abrir a lista de recipientes e
 * procurar de novo — e o recipiente nem sabia responder a pergunta até a
 * migration 120. Etiqueta que não foi impressa é trabalho parado: sem o papel
 * colado, o lote e o pote existem no sistema e não existem na bancada.
 *
 * ── POR QUE SÃO DOIS BOTÕES, E NÃO UM ────────────────────────
 *
 * Não é escolha de desenho: são dois ROLOS diferentes na impressora. A
 * etiqueta de lote sai num rolo de 34x65mm com três colunas; a de recipiente,
 * num de 100x50mm com uma. Um botão só teria de mandar as duas no mesmo papel,
 * e metade sairia fora de posição. Trocar o rolo é trabalho manual de qualquer
 * jeito — o que a tela pode fazer é não deixar ninguém descobrir isso no meio
 * da impressão.
 */

type LotePendente = {
  id: string; codigo: string; created_at: string
  insumo: { nome: string } | null
}

type RecipientePendente = {
  id: string; nome: string; subtipo: string | null
}

export function EtiquetasPendentesPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const [lotes, setLotes] = useState<LotePendente[]>([])
  const [recipientes, setRecipientes] = useState<RecipientePendente[]>([])
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    if (!profile) return
    Promise.all([
      supabase
        .from('lotes')
        .select('id, codigo, created_at, insumo:insumos(nome)')
        .eq('empresa_id', profile.empresa_id)
        .eq('status', 'ativo')
        .eq('etiqueta_impressa', false),
      supabase
        .from('locais')
        .select('id, nome, subtipo')
        .eq('empresa_id', profile.empresa_id)
        .eq('tipo', 'estoque_produtivo')
        // A embalagem do fornecedor não tem etiqueta própria: ela usa a do
        // lote, colada desde o recebimento (migration 073).
        .eq('efemero', false)
        .eq('ativo', true)
        .eq('etiqueta_impressa', false),
    ]).then(([l, r]) => {
      setLotes(((l.data ?? []) as unknown as LotePendente[])
        .sort((a, b) => ordemNatural(a.codigo, b.codigo)))
      setRecipientes(((r.data ?? []) as unknown as RecipientePendente[])
        .sort((a, b) => ordemNatural(a.nome, b.nome)))
      setCarregando(false)
    })
  }, [profile])

  /** A tela de impressão de lotes recebe a lista pela navegação. */
  function imprimirLotes() {
    navigate('/recebimento/imprimir-lotes', {
      state: { lotes: lotes.map(l => ({ lote_id: l.id, codigo: l.codigo, qr_code: '', quantidade: 0 })) },
    })
  }

  function imprimirRecipientes() {
    navigate('/recipientes/etiquetas', {
      state: { recipienteIds: recipientes.map(r => r.id) },
    })
  }

  if (carregando) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  const nada = lotes.length === 0 && recipientes.length === 0

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-unno-text">
        Etiquetas a imprimir
      </h1>
      <p className="text-sm text-gray-500 dark:text-unno-muted mt-1 mb-5">
        O que ainda não foi para a impressora nenhuma vez. Enquanto a etiqueta
        não está colada, ninguém consegue bipar.
      </p>

      {nada ? (
        <Card className="p-6 text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-unno-text">
            Nada pendente.
          </p>
          <p className="text-xs text-gray-500 dark:text-unno-muted mt-1">
            Todo lote ativo e todo recipiente já foram impressos ao menos uma vez.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Grupo
            titulo="Lotes"
            vazio="Nenhum lote esperando etiqueta."
            quantidade={lotes.length}
            rolo="rolo de 34×65mm, três colunas"
            onImprimir={imprimirLotes}
          >
            {lotes.map(l => (
              <Linha
                key={l.id}
                titulo={l.insumo?.nome ?? '—'}
                detalhe={codigoCurtoLote(l.codigo)}
                extra={formatDate(l.created_at)}
              />
            ))}
          </Grupo>

          <Grupo
            titulo="Recipientes"
            vazio="Nenhum recipiente esperando etiqueta."
            quantidade={recipientes.length}
            rolo="rolo de 100×50mm, uma coluna"
            onImprimir={imprimirRecipientes}
          >
            {recipientes.map(r => (
              <Linha key={r.id} titulo={r.nome} detalhe={r.subtipo ?? ''} />
            ))}
          </Grupo>
        </div>
      )}

      <p className="text-xs text-gray-400 dark:text-unno-muted mt-5">
        A etiqueta é marcada como impressa no clique, não na saída do papel. Se
        a impressora falhar, dá para reimprimir a qualquer momento pela{' '}
        <Link to="/recipientes" className="underline">lista de recipientes</Link>{' '}
        ou pelo <Link to="/recebimento" className="underline">recebimento</Link>.
      </p>
    </div>
  )
}

// ── Peças ─────────────────────────────────────────────────────

function Grupo({ titulo, quantidade, rolo, vazio, onImprimir, children }: {
  titulo: string; quantidade: number; rolo: string; vazio: string
  onImprimir: () => void; children: React.ReactNode
}) {
  if (quantidade === 0) return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-gray-700 dark:text-unno-text">{titulo}</p>
      <p className="text-xs text-gray-400 dark:text-unno-muted mt-0.5">{vazio}</p>
    </Card>
  )

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-unno-text">
            {titulo} · {quantidade}
          </p>
          <p className="text-xs text-gray-500 dark:text-unno-muted mt-0.5">{rolo}</p>
        </div>
        <Button size="md" onClick={onImprimir}>
          Imprimir {quantidade === 1 ? 'a etiqueta' : `as ${quantidade}`}
        </Button>
      </div>

      <div className="mt-3 divide-y divide-gray-100 dark:divide-white/[.06]">
        {children}
      </div>
    </Card>
  )
}

function Linha({ titulo, detalhe, extra }: { titulo: string; detalhe: string; extra?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <p className="text-sm text-gray-900 dark:text-unno-text min-w-0">
        {titulo}{' '}
        {detalhe && <span className="font-mono text-xs text-gray-500">{detalhe}</span>}
      </p>
      {extra && <span className="text-xs text-gray-400 shrink-0">{extra}</span>}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { ordemNatural } from '../../lib/utils'

/**
 * A PORTA DE ENTRADA DA TRANSFERÊNCIA — o que você vai fazer agora?
 *
 * Antes a Transferência abria direto na lista de insumos que moram em balde, e
 * o resto da operação vivia atrás de um botão cinza no fim da rolagem, escrito
 * "Outro tipo de transferência" — que o dock do celular ainda cobria. Quem
 * procurava a glucose, o doce de leite ou o desmoldante simplesmente não os
 * encontrava, e nada na tela dizia que existia outro caminho.
 *
 * Levar embalagem original e porcionar não são "outro tipo" de nada: são
 * metade do que a fábrica faz. Agora as três aparecem lado a lado.
 *
 * NADA AQUI É LISTA ESCRITA NO CÓDIGO. Cada insumo já declara no cadastro como
 * ocupa o estoque produtivo (`modo_ep`), e é dele que sai tanto a divisão
 * quanto os nomes mostrados em cada cartão. Insumo novo aparece sozinho;
 * caminho sem nenhum insumo não aparece.
 */

type ModoEp = 'recipiente' | 'embalagem_fornecedor' | 'porcionado' | 'escolher'

type Caminho = {
  chave: string
  titulo: string
  descricao: string
  rota: string
  /** Modos que caem aqui. `escolher` faz as duas coisas e entra nas duas. */
  modos: ModoEp[]
  icone: JSX.Element
}

const CAMINHOS: Caminho[] = [
  {
    chave: 'recipiente',
    titulo: 'Reabastecer recipientes',
    descricao: 'Encher os baldes da cozinha e pesar. Você bipa as embalagens no fim.',
    rota: '/transferencia/baldes',
    modos: ['recipiente'],
    icone: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14l-1.2 11.1A2 2 0 0115.8 21H8.2a2 2 0 01-2-1.9L5 8zm2-3h10l.6 3H6.4L7 5z" />
      </svg>
    ),
  },
  {
    chave: 'embalagem',
    titulo: 'Levar embalagem original',
    descricao: 'O pacote do fornecedor vai inteiro para a produção e é usado de dentro dele.',
    rota: '/transferencia/scan',
    modos: ['embalagem_fornecedor', 'escolher'],
    icone: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 8l-9-5-9 5m18 0l-9 5m9-5v8l-9 5m0-8L3 8m9 5v8M3 8v8l9 5" />
      </svg>
    ),
  },
  {
    chave: 'porcionado',
    titulo: 'Porcionar',
    descricao: 'Esvaziar o pacote em porções — os sacos de confeitar e as caixas.',
    rota: '/transferencia/scan',
    modos: ['porcionado', 'escolher'],
    icone: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v4m0 0L9.5 9.5M12 7l2.5 2.5M6 21h12a1 1 0 001-1l-.8-8.2a1 1 0 00-1-.8H6.8a1 1 0 00-1 .8L5 20a1 1 0 001 1z" />
      </svg>
    ),
  },
]

type Insumo = { id: string; nome: string; modo: ModoEp }

export function EscolhaTransferenciaPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [insumos, setInsumos] = useState<Insumo[]>([])
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    if (!profile) return
    let vivo = true

    Promise.all([
      supabase.from('insumos').select('id, nome').eq('empresa_id', profile.empresa_id).eq('ativo', true),
      supabase.from('insumos_armazenamento_config').select('insumo_id, modo_ep'),
    ]).then(([ins, cfg]) => {
      if (!vivo) return

      // Sem linha de config o insumo é de recipiente — é o padrão que a tela de
      // baldes e a de leitura por QR já aplicam.
      const modos = new Map(
        ((cfg.data ?? []) as { insumo_id: string; modo_ep: ModoEp | null }[])
          .map(c => [c.insumo_id, c.modo_ep ?? 'recipiente']),
      )

      setInsumos(
        ((ins.data ?? []) as { id: string; nome: string }[])
          .map(i => ({ id: i.id, nome: i.nome, modo: modos.get(i.id) ?? 'recipiente' }))
          .sort((a, b) => ordemNatural(a.nome, b.nome)),
      )
      setCarregando(false)
    })

    return () => { vivo = false }
  }, [profile])

  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-foreground">Transferência</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          O que você vai fazer agora?
        </p>
      </div>

      {carregando ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {CAMINHOS.map(c => {
            const doCaminho = insumos.filter(i => c.modos.includes(i.modo))

            // Caminho sem insumo nenhum não vira cartão apagado: some. Quem não
            // porciona nada não precisa saber que dá para porcionar.
            if (doCaminho.length === 0) return null

            return (
              <Card key={c.chave} className="p-4" onClick={() => navigate(c.rota)}>
                <div className="flex items-start gap-3">
                  <span className="shrink-0 text-brand-600 dark:text-brand-400 mt-0.5">{c.icone}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="font-semibold text-foreground">{c.titulo}</p>
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {doCaminho.length} {doCaminho.length === 1 ? 'insumo' : 'insumos'}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">{c.descricao}</p>

                    {/* Os nomes, e não só a contagem: a pergunta que trouxe a
                        pessoa até aqui costuma ser "onde está a glucose?". */}
                    <p className="text-xs text-muted-foreground/70 mt-2 line-clamp-2">
                      {doCaminho.map(i => i.nome).join(' · ')}
                    </p>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

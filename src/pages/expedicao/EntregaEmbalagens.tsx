import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardBody, CardHeader } from '../../components/ui/Card'
import { Input } from '../../components/ui/Input'
import { useEmbalagens } from '../../lib/embalagens'
import { formatDateTime } from '../../lib/utils'

/**
 * Entrega pra Odara: quantos displays e caixas de embarque saíram.
 *
 * Até as etiquetas de expedição existirem no sistema (Parte 3), é aqui que o
 * display e a caixa descem do estoque — à mão, a cada entrega (Lucca,
 * 29/09/2026). O BOPP não entra: ele desce sozinho na pós-produção.
 * Migration 135b, `registrar_entrega_embalagens`.
 */

function hojeISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Item = { id: string; nome: string; saldo: number }
type Ultima = { codigo: string; data_hora: string; observacoes: string | null; total: number }

export function EntregaEmbalagens() {
  const { profile } = useAuth()
  const { regras } = useEmbalagens()
  const idsEntrega = useMemo(
    () => [...new Set(regras.filter(r => r.gatilho === 'entrega').map(r => r.insumo_id))],
    [regras],
  )

  const [itens, setItens] = useState<Item[]>([])
  const [qtd, setQtd] = useState<Record<string, string>>({})
  const [data, setData] = useState(hojeISO())
  const [ultimas, setUltimas] = useState<Ultima[]>([])
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null)

  const carregar = useCallback(async () => {
    if (!profile || idsEntrega.length === 0) return
    const [est, mov] = await Promise.all([
      supabase.from('v_estoque_consolidado')
        .select('insumo_id, insumo_nome, qtd_estoque_central')
        .eq('empresa_id', profile.empresa_id)
        .in('insumo_id', idsEntrega),
      supabase.from('movimentacoes')
        .select('codigo, data_hora, observacoes, itens:movimentacoes_itens(quantidade)')
        .eq('empresa_id', profile.empresa_id)
        .ilike('observacoes', 'Entrega Odara%')
        .order('data_hora', { ascending: false })
        .limit(3),
    ])
    const lista = ((est.data ?? []) as { insumo_id: string; insumo_nome: string; qtd_estoque_central: number }[])
      .map(e => ({ id: e.insumo_id, nome: e.insumo_nome, saldo: Number(e.qtd_estoque_central ?? 0) }))
    // Displays primeiro, a caixa por último — a ordem em que se conta a carga.
    lista.sort((a, b) => Number(a.nome.startsWith('Caixa')) - Number(b.nome.startsWith('Caixa'))
      || a.nome.localeCompare(b.nome, 'pt-BR'))
    setItens(lista)
    setUltimas(((mov.data ?? []) as unknown as { codigo: string; data_hora: string; observacoes: string | null; itens: { quantidade: number }[] }[])
      .map(m => ({ ...m, total: m.itens.reduce((s, i) => s + Number(i.quantidade), 0) })))
  }, [profile, idsEntrega])

  useEffect(() => { carregar() }, [carregar])

  if (idsEntrega.length === 0) return null

  const pedidos = itens
    .map(i => ({ insumo_id: i.id, quantidade: parseInt(qtd[i.id] ?? '', 10) || 0 }))
    .filter(p => p.quantidade > 0)

  async function registrar() {
    if (!profile || pedidos.length === 0) return
    setSalvando(true)
    setMsg(null)
    const { data: r, error } = await supabase.rpc('registrar_entrega_embalagens', {
      p_empresa_id: profile.empresa_id,
      p_responsavel_id: profile.id,
      p_data: data,
      p_itens: pedidos,
    })
    setSalvando(false)
    const resp = r as { ok: boolean; erro?: string; movimentacao?: string } | null
    if (error || !resp?.ok) {
      setMsg({ ok: false, texto: error?.message ?? resp?.erro ?? 'Não foi possível registrar.' })
      return
    }
    setMsg({ ok: true, texto: `Entrega registrada (${resp.movimentacao}).` })
    setQtd({})
    carregar()
  }

  return (
    <Card className="mb-6">
      <CardHeader
        title="Entrega pra Odara: embalagens"
        subtitle="Quantos displays e caixas de embarque saíram nesta entrega. O BOPP desce sozinho na pós-produção."
      />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {itens.map(i => (
            <Input
              key={i.id}
              label={i.nome.replace(' Odara', '')}
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              placeholder="0"
              value={qtd[i.id] ?? ''}
              onChange={e => setQtd(q => ({ ...q, [i.id]: e.target.value }))}
              hint={`No estoque: ${i.saldo.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Input label="Data da entrega" type="date" value={data} onChange={e => setData(e.target.value)} />
          </div>
          <Button onClick={registrar} loading={salvando} disabled={pedidos.length === 0}>
            Registrar entrega
          </Button>
        </div>

        {msg && (
          <p className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {msg.texto}
          </p>
        )}

        {ultimas.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p className="font-semibold uppercase tracking-wide">Últimas entregas</p>
            {ultimas.map(u => (
              <p key={u.codigo} className="tabular-nums">
                {formatDateTime(u.data_hora)} · {u.total.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} unidades · {u.codigo}
              </p>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

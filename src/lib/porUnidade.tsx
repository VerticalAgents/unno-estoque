import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { formatQty } from './utils'
import type { UnidadeMedida } from '../types/database.types'

/**
 * Insumo contado em garrafas ou pacotes (modo 'unidade', migration 126).
 *
 * O óleo e o ovo em pó continuam guardados em kg no banco — é o que a ficha
 * técnica consome. Mas ninguém na fábrica pensa em "31,59 kg de óleo": pensa
 * em 39 garrafas (Lucca, 28/09/2026). A tela mostra a unidade e deixa o kg
 * ao lado, pequeno.
 */
export type ConfigUnidade = { peso: number; tipo: string }

export function usePorUnidade(): Record<string, ConfigUnidade> {
  const [mapa, setMapa] = useState<Record<string, ConfigUnidade>>({})
  useEffect(() => {
    let vivo = true
    Promise.all([
      supabase.from('insumos_armazenamento_config').select('insumo_id').eq('modo_ep', 'unidade'),
      supabase.from('insumos_embalagem_config')
        .select('insumo_id, subunidade_tipo, subunidade_peso')
        .eq('tem_subunidades', true),
    ]).then(([modos, emb]) => {
      if (!vivo) return
      const ids = new Set(((modos.data ?? []) as { insumo_id: string }[]).map(m => m.insumo_id))
      setMapa(Object.fromEntries(
        ((emb.data ?? []) as { insumo_id: string; subunidade_tipo: string | null; subunidade_peso: number | null }[])
          .filter(e => ids.has(e.insumo_id) && Number(e.subunidade_peso) > 0)
          .map(e => [e.insumo_id, { peso: Number(e.subunidade_peso), tipo: e.subunidade_tipo ?? 'unidade' }]),
      ))
    })
    return () => { vivo = false }
  }, [])
  return mapa
}

/**
 * "39 garrafas · 31,59 kg". Só as inteiras contam — é a mesma regra do
 * reabastecimento, onde a aberta não entra.
 */
export function QtdPorUnidade({ valor, unidade, config }: {
  valor: number
  unidade: UnidadeMedida
  config: ConfigUnidade | undefined
}) {
  if (!config) return <>{formatQty(valor, unidade)}</>
  const n = Math.floor(Number(valor) / config.peso + 0.0001)
  return (
    <>
      {n} {n === 1 ? config.tipo : `${config.tipo}s`}
      <span className="text-xs font-normal text-muted-foreground/70"> · {formatQty(valor, unidade)}</span>
    </>
  )
}

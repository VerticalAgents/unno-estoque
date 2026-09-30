import { useEffect, useState } from 'react'
import { supabase } from './supabase'

/**
 * As embalagens da Odara — displays, caixa de embarque e BOPP (migration 135b).
 *
 * São insumos comuns, mas ficam fora das fichas técnicas: quanto cada brownie
 * gasta mora em `embalagem_consumo`. O BOPP desce sozinho na pós-produção; o
 * display e a caixa, à mão, na entrega (Expedição).
 */

/** Embalagem não vence. O lote exige data, e esta é a que vai por baixo. */
export const SEM_VALIDADE = '2099-12-31'

export interface RegraEmbalagem {
  insumo_id: string
  ficha_id: string
  qtd_por_brownie: number
  gatilho: 'pos_producao' | 'entrega'
}

let cache: Promise<RegraEmbalagem[]> | null = null

function carregar(): Promise<RegraEmbalagem[]> {
  if (!cache) {
    cache = Promise.resolve(
      supabase
        .from('embalagem_consumo')
        .select('insumo_id, ficha_id, qtd_por_brownie, gatilho'),
    ).then(({ data, error }) => {
      if (error) { cache = null; return [] }
      return ((data ?? []) as Record<string, unknown>[]).map(r => ({
        insumo_id: String(r.insumo_id),
        ficha_id: String(r.ficha_id),
        qtd_por_brownie: Number(r.qtd_por_brownie),
        gatilho: r.gatilho as RegraEmbalagem['gatilho'],
      }))
    })
  }
  return cache
}

/** As regras de consumo e o conjunto de insumos que são embalagem. */
export function useEmbalagens() {
  const [regras, setRegras] = useState<RegraEmbalagem[]>([])
  useEffect(() => {
    let vivo = true
    carregar().then(r => { if (vivo) setRegras(r) })
    return () => { vivo = false }
  }, [])
  return { regras, ids: new Set(regras.map(r => r.insumo_id)) }
}

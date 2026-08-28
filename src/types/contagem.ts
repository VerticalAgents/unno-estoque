import type { Insumo } from './database.types'

export type ContagemTipo = 'ec' | 'ep'
export type ContagemStatus = 'em_andamento' | 'finalizada' | 'aplicada' | 'cancelada'
export type StatusFisico = 'cheio' | 'vazio' | 'usado'

export interface Contagem {
  id: string
  empresa_id: string
  tipo: ContagemTipo
  status: ContagemStatus
  iniciada_por: string
  observacao?: string
  created_at: string
  finalizada_at?: string
  aplicada_at?: string
  // joined
  usuario?: { nome: string }
}

export interface ContagemInsumo {
  id: string
  contagem_id: string
  insumo_id: string
  qtd_teorica: number
  qtd_fisica?: number
  status: 'pendente' | 'em_contagem' | 'finalizado'
  created_at: string
  // joined
  insumo?: Insumo
}

export interface ContagemEcLote {
  id: string
  contagem_insumo_id: string
  lote_id: string
  lote_codigo: string
  qtd_lote: number
  encontrado: boolean
  /**
   * Quanto a pessoa contou neste lote (migration 115).
   *
   * `null` = não declarou número, e o saldo do sistema fica como está — é o
   * que uma bipada sozinha significa. Zero é afirmação: a embalagem está
   * vazia, e o lote esgota.
   */
  qtd_contada: number | null
  created_at: string
}

export interface ContagemEpLocal {
  id: string
  contagem_insumo_id: string
  local_id: string
  local_nome: string
  status_fisico?: StatusFisico
  peso_bruto?: number
  peso_tara: number
  qtd_liquida?: number
  qtd_estado_atual: number
  escaneado: boolean
  created_at: string
}

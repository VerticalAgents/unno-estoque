// ============================================================
// Unno — Database TypeScript Types
// Gerado manualmente a partir do schema PostgreSQL
// ============================================================

export type PapelUsuario = 'admin' | 'gestao' | 'producao' | 'compras'
export type SexoEnum = 'M' | 'F' | 'Outro'
export type TipoEmbalagemFornecedor = 'fardo' | 'caixa' | 'saca' | 'balde' | 'garrafa' | 'lata' | 'display' | 'saco' | 'unidade'
export type TipoArmazenamentoEP = 'balde' | 'garrafa_fornecedor' | 'balde_fornecedor' | 'caixa_plastica' | 'saco_confeitar' | 'lata' | 'unidade'
export type UnidadeMedida = 'kg' | 'g' | 'L' | 'ml' | 'unid'
export type StatusLote = 'ativo' | 'esgotado' | 'descartado' | 'vencido'
export type StatusLoteUnidade = 'no_estoque_central' | 'no_estoque_produtivo' | 'parcialmente_transferida' | 'esgotada' | 'descartada'
export type TipoMovimentacao = 'entrada' | 'transferencia' | 'reembalagem' | 'consumo_producao' | 'perda_insumo' | 'ajuste_inventario'
export type TipoLocal = 'estoque_central' | 'estoque_produtivo'
export type SubtipoLocal = 'prateleira' | 'balde' | 'balde_fornecedor' | 'caixa_plastica' | 'garrafa' | 'garrafa_fornecedor' | 'saco_confeitar' | 'lata'
export type StatusSessao = 'planejada' | 'aberta' | 'fechada' | 'cancelada'
export type MotivoPerdaEnum = 'vencimento' | 'embalagem_danificada' | 'contaminacao' | 'queda_acidente' | 'qualidade_reprovada' | 'outro'

export interface Empresa {
  id: string
  nome: string
  cnpj?: string
  email?: string
  telefone?: string
  endereco?: string
  cidade?: string
  estado?: string
  cep?: string
  logo_url?: string
  ativa: boolean
  created_at: string
  updated_at: string
}

export interface Usuario {
  id: string
  empresa_id: string
  nome: string
  email: string
  sexo?: SexoEnum
  cpf?: string
  celular?: string
  papel: PapelUsuario
  ativo: boolean
  ultimo_acesso?: string
  created_at: string
  updated_at: string
}

export interface CategoriaInsumo {
  id: string
  empresa_id: string
  nome: string
  cor_hex?: string
  descricao?: string
  created_at: string
}

export interface Marca {
  id: string
  empresa_id: string
  nome: string
  created_at: string
}

export interface InsumoMarca {
  id: string
  insumo_id: string
  marca_id: string
  marca?: Marca
}

export interface FornecedorInsumoMarca {
  id: string
  fornecedor_id: string
  insumo_id: string
  marca_id: string
  marca?: Marca
  insumo?: Insumo
}

export interface Fornecedor {
  id: string
  empresa_id: string
  nome: string
  marca?: string
  cnpj?: string
  contato?: string
  telefone?: string
  email?: string
  cidade?: string
  observacoes?: string
  ativo: boolean
  created_at: string
  updated_at: string
}

export interface Insumo {
  id: string
  empresa_id: string
  codigo: string
  nome: string
  categoria_id?: string
  unidade_medida: UnidadeMedida
  shelf_life_dias_pos_abertura?: number
  estoque_minimo?: number
  tamanho_embalagem?: number
  estoque_minimo_ec?: number
  estoque_maximo_ec?: number
  estoque_minimo_ep?: number
  estoque_maximo_ep?: number
  recipiente_subtipo?: string
  recipiente_capacidade_max?: number
  recipiente_unidade_cap?: string
  ativo: boolean
  observacoes?: string
  created_at: string
  updated_at: string
  // joined
  categoria?: CategoriaInsumo
  embalagem_config?: InsumoEmbalagemConfig
  armazenamento_config?: InsumoArmazenamentoConfig
  nutrientes?: InsumoNutrientes
}

export interface InsumoNutrientes {
  id: string
  insumo_id: string
  energia_kcal: number
  carboidratos: number
  acucares_totais: number
  acucares_adicionados: number
  proteinas: number
  gorduras_totais: number
  gorduras_saturadas: number
  gorduras_trans: number
  fibras: number
  sodio_mg: number
}

export interface InsumoEmbalagemConfig {
  id: string
  insumo_id: string
  tipo_embalagem: TipoEmbalagemFornecedor
  quantidade_total: number
  unidade_total: UnidadeMedida
  tem_subunidades: boolean
  subunidade_tipo?: string
  subunidade_quantidade?: number
  subunidade_peso?: number
  subunidade_unidade?: UnidadeMedida
  observacoes?: string
  created_at: string
  updated_at: string
}

export interface InsumoArmazenamentoConfig {
  id: string
  insumo_id: string
  tipo_armazenamento: TipoArmazenamentoEP
  passa_reembalagem: boolean
  reembalagem_formato?: string
  reembalagem_tamanho_porcao?: number
  reembalagem_unidade?: UnidadeMedida
  destino_multiplo: boolean
  destino_multiplo_descricao?: string
  observacoes?: string
  created_at: string
  updated_at: string
}

export interface Local {
  id: string
  empresa_id: string
  nome: string
  tipo: TipoLocal
  subtipo?: SubtipoLocal
  insumo_id?: string
  marca_id?: string
  capacidade_max?: number
  unidade_capacidade?: UnidadeMedida
  qr_code_fixo?: string
  peso_tara?: number
  ativo: boolean
  observacoes?: string
  created_at: string
  updated_at: string
  // joined
  insumo?: Insumo
  marca?: Marca
  estado_atual?: LocalEstadoAtual
}

export interface LocalEstadoAtual {
  id: string
  local_id: string
  lote_id?: string
  lote_unidade_id?: string
  quantidade: number
  unidade?: UnidadeMedida
  atualizado_em: string
  atualizado_por?: string
  // joined
  lote?: Lote
}

export interface Lote {
  id: string
  empresa_id: string
  codigo: string
  insumo_id: string
  fornecedor_id?: string
  data_recebimento: string
  data_fabricacao?: string
  validade_original: string
  validade_pos_abertura: string
  quantidade_recebida: number
  unidade: UnidadeMedida
  quantidade_disponivel: number
  status: StatusLote
  recebido_por: string
  qr_code?: string
  etiqueta_impressa: boolean
  numero_nf?: string
  lote_grupo_id?: string
  marca_id?: string
  observacoes?: string
  created_at: string
  updated_at: string
  // joined
  insumo?: Insumo
  fornecedor?: Fornecedor
  marca?: Marca
}

export interface LoteUnidade {
  id: string
  lote_id: string
  codigo: string
  tipo_unidade: string
  peso_volume?: number
  unidade?: UnidadeMedida
  status: StatusLoteUnidade
  local_atual_id?: string
  qr_code?: string
  created_at: string
  updated_at: string
}

export interface Movimentacao {
  id: string
  empresa_id: string
  codigo: string
  tipo: TipoMovimentacao
  data_hora: string
  responsavel_id: string
  sessao_producao_id?: string
  observacoes?: string
  created_at: string
}

export interface MovimentacaoItem {
  id: string
  movimentacao_id: string
  lote_id: string
  lote_unidade_id?: string
  local_origem_id?: string
  local_destino_id?: string
  quantidade: number
  unidade: UnidadeMedida
  observacoes?: string
}

export type TipoFicha = 'produto' | 'insumo'

export interface FichaTecnica {
  id: string
  empresa_id: string
  codigo: string
  nome: string
  descricao?: string
  versao_atual: number
  tipo: TipoFicha
  insumo_resultado_id?: string
  ativo: boolean
  created_at: string
  updated_at: string
  // joined
  insumo_resultado?: Insumo
}

export interface FichaTecnicaVersao {
  id: string
  ficha_id: string
  versao: number
  criado_por: string
  notas_alteracao: string
  ativa: boolean
  rendimento_fornada?: number
  peso_medio_g?: number
  created_at: string
}

export interface FichaTecnicaItem {
  id: string
  versao_id: string
  insumo_id: string
  quantidade: number
  unidade: UnidadeMedida
  observacoes?: string
  // joined
  insumo?: Insumo
}

export interface SessaoProducao {
  id: string
  empresa_id: string
  codigo: string
  data_producao: string
  status: StatusSessao
  aberta_por: string
  fechada_por?: string
  data_abertura?: string
  data_fechamento?: string
  observacoes_abertura?: string
  observacoes_fechamento?: string
  fator_perda_insumos?: number
  fator_perda_produto?: number
  created_at: string
  updated_at: string
  // joined
  skus?: SessaoProducaoSku[]
  locais?: SessaoProducaoLocal[]
}

export interface SessaoProducaoSku {
  id: string
  sessao_id: string
  ficha_tecnica_id: string
  ficha_versao_id: string
  quantidade_planejada: number
  quantidade_produzida?: number
  quantidade_perdida?: number
  multiplicador?: number
  quantidade_descartada_gramatura?: number
  peso_descartado_gramatura_g?: number
  // joined
  ficha_tecnica?: FichaTecnica
  ficha_versao?: FichaTecnicaVersao
}

export interface SessaoProducaoLocal {
  id: string
  sessao_id: string
  local_id: string
  insumo_id: string
  lote_id: string
  quantidade_inicial: number
  quantidade_final?: number
  consumo_real?: number
  consumo_teorico?: number
  desvio?: number
  // joined
  local?: Local
  insumo?: Insumo
  lote?: Lote
}

export interface Reembalagem {
  id: string
  empresa_id: string
  codigo: string
  lote_id: string
  insumo_id: string
  data_hora: string
  responsavel_id: string
  quantidade_utilizada: number
  unidade_utilizada: UnidadeMedida
  tipo_resultado: string
  tamanho_porcao: number
  unidade_porcao: UnidadeMedida
  quantidade_unidades_geradas: number
  peso_total_gerado: number
  sobra: number
  local_destino_id?: string
  observacoes?: string
  created_at: string
}

export interface PerdaInsumo {
  id: string
  empresa_id: string
  codigo: string
  data: string
  lote_id: string
  lote_unidade_id?: string
  insumo_id: string
  local_id?: string
  quantidade: number
  unidade: UnidadeMedida
  motivo: MotivoPerdaEnum
  descricao?: string
  responsavel_id: string
  created_at: string
}

// ── Produto acabado ─────────────────────────────────────────

export type StatusLoteProduto = 'ativo' | 'esgotado' | 'vencido' | 'descartado'
export type StatusExpedicao = 'preparando' | 'expedida' | 'cancelada'

export interface Produto {
  id: string
  empresa_id: string
  ficha_tecnica_id?: string
  codigo: string
  nome: string
  descricao?: string
  peso_unitario_g?: number
  validade_dias?: number
  ativo: boolean
  created_at: string
  updated_at: string
  // joined
  ficha_tecnica?: FichaTecnica
  embalagens?: ProdutoEmbalagem[]
}

export interface ProdutoEmbalagem {
  id: string
  produto_id: string
  nivel: number
  nome: string
  quantidade: number
  peso_embalagem_g?: number
  created_at: string
}

export interface LoteProduto {
  id: string
  empresa_id: string
  codigo: string
  produto_id: string
  sessao_id: string
  data_producao: string
  validade: string
  quantidade_produzida: number
  quantidade_disponivel: number
  status: StatusLoteProduto
  qr_code?: string
  created_at: string
  updated_at: string
  // joined
  produto?: Produto
  sessao?: SessaoProducao
}

export interface Expedicao {
  id: string
  empresa_id: string
  codigo: string
  data_expedicao: string
  responsavel_id: string
  destinatario?: string
  observacoes?: string
  status: StatusExpedicao
  created_at: string
  updated_at: string
  // joined
  itens?: ExpedicaoItem[]
  responsavel?: Usuario
}

export interface ExpedicaoItem {
  id: string
  expedicao_id: string
  lote_produto_id: string
  produto_id: string
  quantidade: number
  created_at: string
  // joined
  lote_produto?: LoteProduto
  produto?: Produto
}

// ── View types ───────────────────────────────────────────────

export interface EstoqueConsolidado {
  empresa_id: string
  insumo_id: string
  insumo_codigo: string
  insumo_nome: string
  unidade_medida: UnidadeMedida
  estoque_minimo?: number
  qtd_estoque_central: number
  qtd_estoque_produtivo: number
  qtd_total: number
  alerta_reposicao: boolean
  // joined in app
  categoria?: CategoriaInsumo
}

export interface LoteVencendo {
  empresa_id: string
  lote_id: string
  lote_codigo: string
  insumo_nome: string
  validade_pos_abertura: string
  dias_para_vencer: number
  quantidade_disponivel: number
  unidade: UnidadeMedida
  status: StatusLote
}

// ── RPC return types ─────────────────────────────────────────

export interface RpcResult {
  ok: boolean
  erro?: string
}

export interface RpcTransferenciaResult extends RpcResult {
  movimentacao_id?: string
  codigo?: string
}

export interface RpcEntradaLoteResult extends RpcResult {
  lote_id?: string
  lote_codigo?: string
  qr_code?: string
  validade_pos_abertura?: string
}

export interface RpcReembalagemResult extends RpcResult {
  reembalagem_id?: string
  codigo?: string
  unidades_geradas?: number
  sobra_g?: number
  qr_codes?: Array<{
    id: string
    codigo: string
    qr_code: string
    peso_g: number
  }>
}

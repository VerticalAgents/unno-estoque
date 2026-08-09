import { supabase } from './supabase'
import type { Fornecedor, Marca } from '../types/database.types'

/**
 * Cadastros que cabem no meio de outro fluxo.
 *
 * A regra que vale para tudo aqui: o cadastro é SÓ UM NOME. Fornecedor e marca
 * entram; insumo, produto, ficha e recipiente não, porque envolvem decisões
 * (unidade, embalagem, modo de armazenamento, etiqueta impressa) que ninguém
 * toma com a mercadoria esperando na porta. Para esses, o certo é avisar e
 * apontar o caminho — não embutir meio formulário.
 *
 * Este arquivo existe porque a Abertura de estoque e o Recebimento já faziam
 * isso cada um do seu jeito, e as duas cópias já tinham divergido: uma achava
 * "Nestlé" escrito como "nestlé", a outra criava uma marca nova. Mesma
 * armadilha dos modos de armazenamento — duas telas perguntando a mesma coisa
 * viram duas regras diferentes.
 */

export type ResultadoCadastro<T> = { dado?: T; erro?: string }

export async function criarFornecedor(
  empresaId: string,
  nome: string,
): Promise<ResultadoCadastro<Fornecedor>> {
  const limpo = nome.trim()
  if (!limpo) return { erro: 'Escreva o nome do fornecedor.' }

  // Nome repetido não é erro do usuário — é o mesmo fornecedor.
  const { data: existente } = await supabase
    .from('fornecedores')
    .select('*')
    .eq('empresa_id', empresaId)
    .ilike('nome', limpo)
    .maybeSingle()
  if (existente) return { dado: existente as Fornecedor }

  const { data, error } = await supabase
    .from('fornecedores')
    .insert({ empresa_id: empresaId, nome: limpo, ativo: true })
    .select('*')
    .single()

  if (error) return { erro: `Não foi possível criar o fornecedor: ${error.message}` }
  return { dado: data as Fornecedor }
}

/**
 * Cria a marca e amarra onde ela precisa aparecer depois.
 *
 * Sem os vínculos a marca vira fantasma: fica gravada no lote e some das telas
 * de cadastro. São dois:
 *   - `insumos_marcas` faz a marca aparecer na tela do insumo
 *   - `fornecedores_insumos_marcas` faz o Recebimento oferecê-la assim que o
 *     fornecedor for escolhido
 */
export async function criarMarca(
  empresaId: string,
  insumoId: string,
  nome: string,
  fornecedorId?: string,
): Promise<ResultadoCadastro<Marca>> {
  const limpo = nome.trim()
  if (!limpo) return { erro: 'Escreva o nome da marca.' }

  // A mesma marca serve a vários insumos, e o banco tem UNIQUE(empresa, nome):
  // reaproveita em vez de falhar. `ilike` porque diferença de maiúscula não
  // faz uma marca ser outra.
  const { data: existente } = await supabase
    .from('marcas')
    .select('*')
    .eq('empresa_id', empresaId)
    .ilike('nome', limpo)
    .maybeSingle()

  let marca = existente as Marca | null
  if (!marca) {
    const { data, error } = await supabase
      .from('marcas')
      .insert({ empresa_id: empresaId, nome: limpo })
      .select('*')
      .single()
    if (error) return { erro: `Não foi possível criar a marca: ${error.message}` }
    marca = data as Marca
  }

  await supabase.from('insumos_marcas').upsert(
    { insumo_id: insumoId, marca_id: marca.id },
    { onConflict: 'insumo_id,marca_id', ignoreDuplicates: true },
  )

  if (fornecedorId) {
    await vincularFornecedorMarca(insumoId, marca.id, fornecedorId)
  }

  return { dado: marca }
}

/** Liga uma marca que já existe ao fornecedor escolhido, sem duplicar nada. */
export async function vincularFornecedorMarca(
  insumoId: string,
  marcaId: string,
  fornecedorId: string,
): Promise<void> {
  if (!marcaId || !fornecedorId) return
  await supabase.from('fornecedores_insumos_marcas').upsert(
    { fornecedor_id: fornecedorId, insumo_id: insumoId, marca_id: marcaId },
    { onConflict: 'fornecedor_id,insumo_id,marca_id', ignoreDuplicates: true },
  )
}

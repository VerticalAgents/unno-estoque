/**
 * Como cada insumo ocupa o estoque produtivo (migration 073).
 *
 * Ficava dentro da tela de insumos. Saiu para cá quando a edição em massa
 * apareceu: duas telas perguntando a mesma coisa com textos diferentes seria o
 * começo de duas regras diferentes.
 */

export type ModoEp = 'recipiente' | 'embalagem_fornecedor' | 'porcionado' | 'escolher'

export const MODOS_EP: {
  value: ModoEp
  titulo: string
  /** Nome curto, para caber em coluna de tabela e em selo. */
  curto: string
  ajuda: string
  cor: string
}[] = [
  {
    value: 'recipiente',
    titulo: 'Vai para um pote da cozinha',
    curto: 'Pote',
    ajuda: 'O caso comum. Na transferência o operador bipa o lote e depois o pote de destino.',
    cor: 'bg-gray-100 text-gray-600',
  },
  {
    value: 'embalagem_fornecedor',
    titulo: 'Fica na embalagem do fornecedor',
    curto: 'Embalagem',
    ajuda: 'O balde ou garrafa do fornecedor é o próprio ponto de consumo. Um bipe só, '
         + 'com a etiqueta que já vem colada — e ele some da lista quando esvazia.',
    cor: 'bg-blue-50 text-blue-700',
  },
  {
    value: 'porcionado',
    titulo: 'É porcionado em sacos',
    curto: 'Porcionado',
    ajuda: 'O pacote é esvaziado em porções que ficam numa caixa. O operador bipa o lote, '
         + 'bipa a caixa e informa quantos sacos encheu.',
    cor: 'bg-purple-50 text-purple-700',
  },
  {
    value: 'escolher',
    titulo: 'Depende do pacote',
    curto: 'Os dois',
    ajuda: 'Faz as duas coisas, e quem transfere decide a cada pacote: usar direto ou porcionar.',
    cor: 'bg-amber-50 text-amber-700',
  },
]

export const FORMATOS_PORCAO = [
  { value: 'saco_confeitar', label: 'Saco de confeitar' },
  { value: 'porcionamento', label: 'Porção avulsa' },
]

/** Modos em que o insumo é porcionado, e a porção passa a ser obrigatória. */
export function exigePorcao(modo: ModoEp): boolean {
  return modo === 'porcionado' || modo === 'escolher'
}

export function modoEp(valor?: string | null): ModoEp {
  return MODOS_EP.some(m => m.value === valor) ? (valor as ModoEp) : 'recipiente'
}

/**
 * A linha de `insumos_armazenamento_config` para gravar.
 *
 * Os booleanos antigos continuam sendo escritos, derivados do modo: o CHECK
 * `chk_reembalagem` do banco exige que quem porciona tenha formato, porção e
 * unidade — que é o mesmo invariante que estas telas precisam manter.
 */
export function payloadArmazenamento(
  insumoId: string,
  modo: ModoEp,
  porcao: { tamanho: string; unidade: string; formato: string },
): Record<string, unknown> {
  const porciona = exigePorcao(modo)
  return {
    insumo_id: insumoId,
    modo_ep: modo,
    passa_reembalagem: porciona,
    destino_multiplo: modo === 'escolher',
    reembalagem_formato: porciona ? porcao.formato : null,
    reembalagem_tamanho_porcao: porciona ? parseFloat(porcao.tamanho) : null,
    reembalagem_unidade: porciona ? porcao.unidade : null,
  }
}

/** Selo curto do modo, para ver a configuração sem abrir cada insumo. */
export function SeloModoEp({ modo }: { modo: ModoEp }) {
  const m = MODOS_EP.find(x => x.value === modo) ?? MODOS_EP[0]
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${m.cor}`}>
      {m.curto}
    </span>
  )
}

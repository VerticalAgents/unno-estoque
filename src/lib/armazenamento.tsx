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
    titulo: 'É transferido para um recipiente de armazenamento',
    curto: 'Recipiente',
    ajuda: 'O caso comum. Na transferência o operador bipa o lote e depois o recipiente de destino.',
    cor: 'bg-gray-100 text-gray-600',
  },
  {
    value: 'embalagem_fornecedor',
    titulo: 'É utilizado na produção direto da embalagem original do fornecedor',
    curto: 'Embalagem',
    ajuda: 'A embalagem que veio do fornecedor é o próprio ponto de consumo. Um bipe só, '
         + 'com a etiqueta que já vem colada — e ela some da lista quando esvazia.',
    cor: 'bg-blue-50 text-blue-700',
  },
  {
    value: 'porcionado',
    titulo: 'É porcionado em embalagens descartáveis',
    curto: 'Porcionado',
    ajuda: 'O lote é esvaziado em porções que ficam guardadas numa caixa. O operador bipa o '
         + 'lote, bipa a caixa e informa quantas porções fez. Que embalagem é essa se '
         + 'escolhe no campo Formato.',
    cor: 'bg-purple-50 text-purple-700',
  },
  {
    value: 'escolher',
    titulo: 'Depende do lote',
    curto: 'Depende',
    ajuda: 'Faz as duas coisas, e quem transfere decide a cada lote: usar direto ou porcionar.',
    cor: 'bg-amber-50 text-amber-700',
  },
]

/**
 * Como chamar a porção na tela.
 *
 * "Saco de confeitar" é um caso particular — o desta padaria. O conceito é
 * embalagem descartável, e cada cliente usa a sua. O nome sai do formato
 * configurado, então quem escolheu saco lê "sacos" e quem escolheu porção
 * avulsa lê "porções", sem que o sistema precise generalizar a ponto de ficar
 * vago para os dois.
 */
/**
 * Como se chama a embalagem em que o insumo chega, para a frase da tela.
 *
 * "Pacote" era a palavra usada em tudo, e estava errada na maioria: doce de
 * leite e xarope vêm em BALDE, baunilha em GARRAFA, desmoldante em LATA. Quem
 * lê a tela procura a palavra que usa na bancada.
 *
 * O padrão é "embalagem" e não "pacote": genérico e nunca errado, para o tipo
 * que ainda não foi mapeado aqui.
 */
export function nomeDaEmbalagem(tipo?: string | null, plural = false): string {
  const nomes: Record<string, [string, string]> = {
    balde:              ['balde', 'baldes'],
    balde_fornecedor:   ['balde', 'baldes'],
    garrafa_fornecedor: ['garrafa', 'garrafas'],
    caixa_plastica:     ['caixa', 'caixas'],
    saco_confeitar:     ['saco', 'sacos'],
    lata:               ['lata', 'latas'],
  }
  const par = nomes[tipo ?? ''] ?? ['embalagem', 'embalagens']
  return plural ? par[1] : par[0]
}

export function nomeDaPorcao(formato?: string | null, plural = false): string {
  if (formato === 'saco_confeitar') return plural ? 'sacos' : 'saco'
  return plural ? 'porções' : 'porção'
}

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

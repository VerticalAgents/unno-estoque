import { Input } from '../../components/ui/Input'

/**
 * "Quanto disto vem do saco de confeitar?"
 *
 * Aparece só para insumo que passa por reembalagem. Existe porque um insumo
 * pode entrar na MESMA receita por dois caminhos: no brownie de doce de leite,
 * 200 g por forma saem de um saco de confeitar para o topping e o resto vai do
 * balde direto para a massa.
 *
 * Sem este número, o planejador soma os dois caminhos e trata a receita inteira
 * como se passasse pelo recipiente: para 44 formas pedia 7 baldes onde bastava
 * 1, e avisava que faltava recipiente para uma produção que sempre coube.
 *
 * O campo mora na LINHA DA FICHA e não no insumo, porque é a receita que
 * decide: o mesmo doce de leite, no brownie tradicional, vai inteiro para a
 * massa e não passa por saco nenhum.
 */

export type ConfigPorcao = {
  passa_reembalagem?: boolean | null
  reembalagem_tamanho_porcao?: number | null
  reembalagem_unidade?: string | null
}

/** O insumo é porcionável? Só aí a pergunta faz sentido. */
export function temPorcionamento(cfg?: ConfigPorcao | null): boolean {
  return !!cfg?.passa_reembalagem && !!cfg?.reembalagem_tamanho_porcao
}

/**
 * A porção na unidade da LINHA da ficha.
 *
 * O cadastro guarda a porção em gramas ou mililitros — é assim que se fala de
 * um saquinho. A linha costuma estar em kg. Comparar sem converter faria "200"
 * parecer maior que "0,7589".
 */
export function porcaoNaUnidade(cfg: ConfigPorcao, unidadeDaLinha: string): number {
  const bruto = Number(cfg.reembalagem_tamanho_porcao ?? 0)
  const de = (cfg.reembalagem_unidade ?? 'g').toLowerCase()
  const para = (unidadeDaLinha ?? 'kg').toLowerCase()
  if (de === para) return bruto
  if ((de === 'g' && para === 'kg') || (de === 'ml' && para === 'l')) return bruto / 1000
  if ((de === 'kg' && para === 'g') || (de === 'l' && para === 'ml')) return bruto * 1000
  return bruto
}

interface Props {
  cfg: ConfigPorcao
  /** Quantidade total da linha, para calcular o resto e avisar de exagero. */
  quantidade: string
  unidade: string
  valor: string
  onChange: (v: string) => void
}

export function CampoPorcionado({ cfg, quantidade, unidade, valor, onChange }: Props) {
  const porcao = porcaoNaUnidade(cfg, unidade)
  const total = parseFloat(quantidade.replace(',', '.')) || 0
  const parte = parseFloat(valor.replace(',', '.')) || 0

  const sacos = porcao > 0 ? parte / porcao : 0
  const resto = Math.max(total - parte, 0)
  const passou = parte > total && total > 0

  return (
    <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3
                    dark:border-brand-500/25 dark:bg-brand-500/[.07]">
      <Input
        label="Quanto vem porcionado"
        type="number"
        inputMode="decimal"
        step="0.001"
        min="0"
        value={valor}
        onChange={e => onChange(e.target.value)}
        placeholder="deixe vazio se vier tudo do pote"
        hint={`Em ${unidade}, por forma. O resto vem do pote, como sempre.`}
      />

      {passou ? (
        <p className="text-xs text-red-600 dark:text-unno-danger mt-2">
          Não pode passar do total da linha ({total} {unidade}).
        </p>
      ) : parte > 0 ? (
        <p className="text-xs text-gray-600 dark:text-unno-muted mt-2">
          <strong>{sacos % 1 === 0 ? sacos : sacos.toFixed(2)}</strong>{' '}
          {sacos === 1 ? 'porção' : 'porções'} de {cfg.reembalagem_tamanho_porcao}
          {cfg.reembalagem_unidade ?? 'g'} por forma
          {resto > 0 && <> · o resto, {Number(resto.toFixed(3))} {unidade}, sai do pote</>}
        </p>
      ) : (
        <p className="text-xs text-gray-500 dark:text-unno-muted mt-2">
          Este insumo pode ser porcionado. Preencha só se parte dele entrar pela
          embalagem menor — senão a receita inteira sai do pote.
        </p>
      )}
    </div>
  )
}

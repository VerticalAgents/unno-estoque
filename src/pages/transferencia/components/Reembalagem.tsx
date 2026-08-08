import { useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../contexts/AuthContext'
import type { Lote, Local } from '../../../types/database.types'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { ConfirmModal } from '../../../components/ui/ConfirmModal'
import { calcSacos, formatDate, formatQty } from '../../../lib/utils'

/**
 * Porcionar um pacote em sacos, e depositar na caixa.
 *
 * Antes havia TRÊS componentes, um por insumo — Nutella, Doce de Leite e
 * Stikadinho —, cada um com a porção escrita no código (625g, 600g) e escolhido
 * por um `if` no código do insumo. Cadastrar o quarto insumo porcionado exigia
 * escrever um quarto componente e mais um `if`; e as porções chumbadas já
 * estavam ambas erradas quando o usuário conferiu (migration 074).
 *
 * Agora a porção vem do cadastro e este componente serve a qualquer insumo.
 * Dois formatos:
 *   - `saco_confeitar`: N porções de X g vão para a caixa
 *   - `porcionamento`:  o pacote inteiro é aberto e vai para o recipiente
 *     (o display de Stikadinho, que é cortado antes de ir ao balde)
 */

export type ConfigReembalagem = {
  reembalagem_formato?: string | null
  reembalagem_tamanho_porcao?: number | null
}

interface Props {
  lote: Lote & { insumo: { nome: string; codigo: string } }
  local: Local
  config: ConfigReembalagem
  onSuccess: () => void
  onCancel: () => void
}

/** O lote é medido em kg/L e a porção em g/ml — a conta é feita em g/ml. */
function emGramas(quantidade: number, unidade: string): number {
  return unidade === 'kg' || unidade === 'L' ? quantidade * 1000 : quantidade
}

export function Reembalagem({ lote, local, config, onSuccess, onCancel }: Props) {
  const { profile } = useAuth()

  const porcao = Number(config.reembalagem_tamanho_porcao ?? 0)
  const emPorcoes = (config.reembalagem_formato ?? '') === 'saco_confeitar' && porcao > 0
  const totalG = emGramas(lote.quantidade_disponivel, lote.unidade)

  // Quantos sacos cabem no pacote — o palpite que o operador ajusta se raspou
  // menos. `calcSacos` recebe o total em kg e a porção em g.
  const { qtd: sugestao } = emPorcoes
    ? calcSacos(totalG / 1000, porcao)
    : { qtd: 1 }

  const [qtdPorcoes, setQtdPorcoes] = useState(Math.max(sugestao, 1))
  // O pacote raspado: o que não virou porção saiu do estoque do mesmo jeito.
  const [esvaziouPacote, setEsvaziouPacote] = useState(true)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const sobra = Math.max(totalG - qtdPorcoes * porcao, 0)
  const consumido = emPorcoes
    ? (esvaziouPacote ? totalG : qtdPorcoes * porcao)
    : totalG
  const excedeu = emPorcoes && qtdPorcoes * porcao > totalG + 0.0001

  async function handleConfirmar() {
    if (!profile || excedeu) return
    setLoading(true)
    setError('')

    const { data, error: err } = await supabase.rpc('realizar_reembalagem', {
      p_lote_id:          lote.id,
      p_tipo_resultado:   emPorcoes ? 'saco_confeitar' : 'porcionamento',
      p_tamanho_porcao:   emPorcoes ? porcao : null,
      p_qtd_unidades:     emPorcoes ? qtdPorcoes : 1,
      p_quantidade_total: consumido,
      p_responsavel_id:   profile.id,
      p_empresa_id:       profile.empresa_id,
      p_local_destino_id: local.id,
    })

    setLoading(false)
    if (err || !(data as { ok: boolean })?.ok) {
      setError((data as { erro?: string })?.erro ?? err?.message ?? 'Erro na reembalagem.')
      setShowConfirm(false)
      return
    }
    onSuccess()
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          {emPorcoes ? 'Porcionar em sacos' : 'Abrir o pacote'}
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          {lote.insumo.nome}
          {emPorcoes && ` · sacos de ${porcao} g`}
        </p>

        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 mb-4">
          <p><strong>Pacote:</strong> {lote.codigo} · {formatQty(lote.quantidade_disponivel, lote.unidade)}</p>
          <p><strong>Validade:</strong> {formatDate(lote.validade_pos_abertura)}</p>
          <p><strong>Destino:</strong> {local.nome}</p>
        </div>

        {emPorcoes ? (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700">
                Quantos sacos você encheu?
              </label>
              <div className="flex items-center gap-3 mt-1">
                <button
                  type="button"
                  onClick={() => setQtdPorcoes(Math.max(1, qtdPorcoes - 1))}
                  className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-lg font-bold hover:bg-gray-50"
                >−</button>
                <span className="text-2xl font-bold w-12 text-center">{qtdPorcoes}</span>
                <button
                  type="button"
                  onClick={() => setQtdPorcoes(qtdPorcoes + 1)}
                  className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-lg font-bold hover:bg-gray-50"
                >+</button>
              </div>
            </div>

            <div className={`p-3 rounded-lg border text-sm ${
              excedeu
                ? 'bg-red-50 border-red-200 text-red-800'
                : sobra > 0
                  ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}>
              <p><strong>Nos sacos:</strong> {(qtdPorcoes * porcao).toFixed(0)} g</p>
              {excedeu
                ? <p>Isso passa do que há no pacote ({totalG.toFixed(0)} g).</p>
                : <p><strong>Sobra no pacote:</strong> {sobra.toFixed(0)} g</p>}
            </div>

            {sobra > 0 && !excedeu && (
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={esvaziouPacote}
                  onChange={e => setEsvaziouPacote(e.target.checked)}
                  className="rounded mt-0.5"
                />
                <span>
                  Raspei o pacote — os {sobra.toFixed(0)} g que sobraram foram junto.
                  <span className="block text-xs text-gray-500">
                    Desmarque se o resto continua no pacote, no estoque central.
                  </span>
                </span>
              </label>
            )}
          </div>
        ) : (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
            O pacote inteiro vai para o recipiente. Abra e prepare tudo antes de confirmar.
          </div>
        )}
      </Card>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <Button variant="danger" size="xl" fullWidth disabled={excedeu} onClick={() => setShowConfirm(true)}>
        CONFIRMAR
      </Button>
      <Button variant="ghost" size="lg" fullWidth onClick={onCancel}>← Cancelar</Button>

      <ConfirmModal
        open={showConfirm}
        title={emPorcoes ? 'Confirmar porcionamento?' : 'Confirmar abertura do pacote?'}
        variant="danger"
        confirmLabel="CONFIRMAR"
        loading={loading}
        summary={
          <div className="space-y-1">
            {emPorcoes ? (
              <>
                <p>{lote.codigo} → <strong>{qtdPorcoes} saco(s) × {porcao} g</strong></p>
                {sobra > 0 && (
                  <p>
                    Sobra de {sobra.toFixed(0)} g{' '}
                    {esvaziouPacote ? '→ saiu junto com o pacote' : '→ continua no estoque central'}
                  </p>
                )}
              </>
            ) : (
              <p>{lote.codigo} inteiro → <strong>{local.nome}</strong></p>
            )}
          </div>
        }
        onConfirm={handleConfirmar}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}

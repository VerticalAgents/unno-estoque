import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'

/**
 * Por que uma unidade foi descartada na pós-produção.
 *
 * Desativar em vez de apagar: um motivo já usado num registro antigo não pode
 * sumir do histórico, senão a contagem dos meses passados perde o sentido.
 */
export function MotivosDescarteTab() {
  const { profile } = useAuth()
  const [motivos, setMotivos] = useState<
    { id: string; codigo: string; nome: string; ordem: number; ativo: boolean }[]
  >([])
  const [novo, setNovo] = useState('')
  const [erro, setErro] = useState('')

  const carregar = useCallback(() => {
    if (!profile) return
    supabase.from('motivos_descarte')
      .select('id, codigo, nome, ordem, ativo')
      .eq('empresa_id', profile.empresa_id)
      .order('ordem')
      .then(({ data }) => setMotivos((data ?? []) as typeof motivos))
  }, [profile])

  useEffect(() => { carregar() }, [carregar])

  /** "Corte torto" vira `corte_torto` — sem acento, sem espaço. */
  function paraCodigo(texto: string) {
    return texto.trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  }

  async function adicionar() {
    if (!profile || novo.trim().length < 3) return
    const { error } = await supabase.from('motivos_descarte').insert({
      empresa_id: profile.empresa_id,
      codigo: paraCodigo(novo),
      nome: novo.trim(),
      ordem: (motivos[motivos.length - 1]?.ordem ?? 0) + 1,
    })
    if (error) { setErro(error.message); return }
    setNovo('')
    setErro('')
    carregar()
  }

  async function alternar(id: string, ativo: boolean) {
    await supabase.from('motivos_descarte').update({ ativo: !ativo }).eq('id', id)
    carregar()
  }

  async function renomear(id: string, nome: string) {
    if (nome.trim().length < 3) return
    await supabase.from('motivos_descarte').update({ nome: nome.trim() }).eq('id', id)
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-900">Motivos de descarte</h2>
      <p className="text-sm text-gray-500 mt-0.5 mb-4">
        Usados na pós-produção, ao abrir as formas e embalar.
      </p>

      <div className="space-y-2">
        {motivos.map(m => (
          <div key={m.id} className="flex items-center gap-2">
            <input
              defaultValue={m.nome}
              onBlur={e => renomear(m.id, e.target.value)}
              className={[
                'flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm',
                'focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10',
                m.ativo ? 'bg-white' : 'bg-gray-50 text-gray-400 line-through',
              ].join(' ')}
            />
            <Button size="sm" variant="ghost" onClick={() => alternar(m.id, m.ativo)}>
              {m.ativo ? 'Desativar' : 'Reativar'}
            </Button>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-4 pt-4 border-t border-gray-100">
        <input
          value={novo}
          onChange={e => setNovo(e.target.value)}
          placeholder="Novo motivo"
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm
                     focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
        />
        <Button size="sm" variant="secondary" disabled={novo.trim().length < 3} onClick={adicionar}>
          Adicionar
        </Button>
      </div>

      {erro && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {erro}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-500">
        Motivo desativado some do formulário de registro, mas continua nos
        registros antigos — o histórico não muda.
      </p>
    </Card>
  )
}

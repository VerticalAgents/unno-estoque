import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import {
  ETIQUETA_CONFIG_PADRAO,
  ETIQUETA_MAX_COLUNAS,
  ETIQUETA_MAX_ESPACO_MM,
  ETIQUETA_MAX_MM,
  ETIQUETA_MIN_MM,
  ETIQUETA_PRESETS,
  LAYOUT_BASE,
  colunasEtiqueta,
  configDaLinha,
  dimsLinha,
  escalaEtiqueta,
  layoutDaEtiqueta,
  saneiaConfig,
  sobraEtiqueta,
  type EtiquetaConfig,
  type EtiquetaTipo,
} from '../../lib/etiquetas'

/**
 * Tamanho do papel e formato do rolo, por tipo de etiqueta.
 *
 * Duas perguntas, nesta ordem: qual o tamanho de UMA etiqueta, e como elas
 * vêm dispostas no rolo. A segunda existe porque rolo térmico costuma ter 2
 * ou 3 colunas lado a lado — e nesse caso a impressora avança a linha
 * inteira, então é a linha que precisa virar a "página".
 *
 * Guardado em `configuracoes_sistema` (migrations 063 e 064).
 */

type Campos = Record<keyof EtiquetaConfig, string>

const TIPOS: {
  tipo: EtiquetaTipo
  titulo: string
  descricao: string
  onde: string
}[] = [
  {
    tipo: 'lote',
    titulo: 'Etiqueta de lote e sublote',
    descricao:
      'A que vai colada na embalagem do insumo quando a mercadoria chega, com validade, QR Code e dados da empresa.',
    onde: 'Recebimento → Imprimir etiqueta',
  },
  {
    tipo: 'recipiente',
    titulo: 'Etiqueta de recipiente',
    descricao:
      'A que identifica balde, caixa, garrafa e prateleira, com o QR Code fixo que é escaneado na produção.',
    onde: 'Recipientes → Etiqueta',
  },
]

function paraCampos(config: EtiquetaConfig): Campos {
  return {
    largura: String(config.largura),
    altura: String(config.altura),
    colunas: String(config.colunas),
    espaco: String(config.espaco),
    margem: String(config.margem),
  }
}

function num(v: string): number {
  return parseFloat(v.replace(',', '.'))
}

const LIMITES: Record<keyof EtiquetaConfig, { min: number; max: number }> = {
  largura: { min: ETIQUETA_MIN_MM, max: ETIQUETA_MAX_MM },
  altura: { min: ETIQUETA_MIN_MM, max: ETIQUETA_MAX_MM },
  colunas: { min: 1, max: ETIQUETA_MAX_COLUNAS },
  espaco: { min: 0, max: ETIQUETA_MAX_ESPACO_MM },
  margem: { min: 0, max: ETIQUETA_MAX_ESPACO_MM },
}

function invalido(campo: keyof EtiquetaConfig, valor: string): boolean {
  const n = num(valor)
  const { min, max } = LIMITES[campo]
  return !Number.isFinite(n) || n < min || n > max
}

export function EtiquetasTab() {
  const { profile } = useAuth()
  const [valores, setValores] = useState<Record<EtiquetaTipo, Campos>>({
    lote: paraCampos(ETIQUETA_CONFIG_PADRAO),
    recipiente: paraCampos(ETIQUETA_CONFIG_PADRAO),
  })
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [ok, setOk] = useState(false)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile) return
    const cols = [
      ...Object.values(colunasEtiqueta('lote')),
      ...Object.values(colunasEtiqueta('recipiente')),
    ]
    supabase
      .from('configuracoes_sistema')
      .select(cols.join(', '))
      .eq('empresa_id', profile.empresa_id)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as Record<string, unknown> | null
        setValores({
          lote: paraCampos(configDaLinha('lote', row)),
          recipiente: paraCampos(configDaLinha('recipiente', row)),
        })
        setCarregando(false)
      })
  }, [profile])

  const temInvalido = TIPOS.some(t =>
    (Object.keys(LIMITES) as (keyof EtiquetaConfig)[]).some(c => invalido(c, valores[t.tipo][c])),
  )

  function setCampo(tipo: EtiquetaTipo, campo: keyof EtiquetaConfig, valor: string) {
    setOk(false)
    setValores(v => ({ ...v, [tipo]: { ...v[tipo], [campo]: valor } }))
  }

  function aplicarPreset(tipo: EtiquetaTipo, largura: number, altura: number) {
    setOk(false)
    setValores(v => ({
      ...v,
      [tipo]: { ...v[tipo], largura: String(largura), altura: String(altura) },
    }))
  }

  async function salvar() {
    if (!profile) return
    setErro('')

    if (temInvalido) {
      setErro('Confira os campos em vermelho: há medida fora do que a impressora aceita.')
      return
    }

    setSalvando(true)
    const payload: Record<string, unknown> = { empresa_id: profile.empresa_id }
    for (const t of TIPOS) {
      const cols = colunasEtiqueta(t.tipo)
      for (const campo of Object.keys(LIMITES) as (keyof EtiquetaConfig)[]) {
        payload[cols[campo]] = num(valores[t.tipo][campo])
      }
    }

    const { error } = await supabase
      .from('configuracoes_sistema')
      .upsert(payload, { onConflict: 'empresa_id' })

    setSalvando(false)
    if (error) { setErro(error.message); return }
    setOk(true)
    setTimeout(() => setOk(false), 3000)
  }

  if (carregando) {
    return (
      <Card className="p-5">
        <p className="text-sm text-gray-500 dark:text-unno-muted">Carregando…</p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900 dark:text-unno-text mb-1">
          Tamanho das etiquetas
        </h2>
        <p className="text-sm text-gray-500 dark:text-unno-muted">
          Meça uma etiqueta do rolo e informe aqui. O sistema desenha a etiqueta
          já no formato certo — deitada ou em pé, conforme a medida — e ajusta
          tudo para caber, sem cortar nada e sem deformar.
        </p>
        <p className="text-sm text-gray-500 dark:text-unno-muted mt-2">
          Se o rolo tem mais de uma etiqueta lado a lado, informe também quantas
          colunas: a impressora avança a linha inteira de uma vez, e o sistema
          precisa saber disso para não sair torto da segunda linha em diante.
        </p>
      </Card>

      {TIPOS.map(t => {
        const campos = valores[t.tipo]
        const config = saneiaConfig({
          largura: num(campos.largura),
          altura: num(campos.altura),
          colunas: num(campos.colunas),
          espaco: num(campos.espaco),
          margem: num(campos.margem),
        })
        const linha = dimsLinha(config)
        const layout = layoutDaEtiqueta(config)

        return (
          <Card key={t.tipo} className="p-5">
            <h3 className="text-base font-semibold text-gray-900 dark:text-unno-text">{t.titulo}</h3>
            <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">{t.descricao}</p>
            <p className="text-xs text-gray-400 dark:text-unno-dim mt-1">Onde aparece: {t.onde}</p>

            {/* Tamanho de uma etiqueta */}
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-unno-dim mt-5 mb-2">
              Tamanho de uma etiqueta
            </p>
            <div className="flex flex-wrap items-start gap-6">
              <div className="flex items-end gap-3">
                <MedidaInput
                  label="Largura (mm)"
                  valor={campos.largura}
                  erro={invalido('largura', campos.largura)}
                  min={ETIQUETA_MIN_MM} max={ETIQUETA_MAX_MM} step="0.5"
                  onChange={v => setCampo(t.tipo, 'largura', v)}
                />
                <span className="pb-2 text-gray-400">×</span>
                <MedidaInput
                  label="Altura (mm)"
                  valor={campos.altura}
                  erro={invalido('altura', campos.altura)}
                  min={ETIQUETA_MIN_MM} max={ETIQUETA_MAX_MM} step="0.5"
                  onChange={v => setCampo(t.tipo, 'altura', v)}
                />
              </div>
              <PreviewLinha config={config} />
            </div>

            <div className="mt-4">
              <p className="text-xs text-gray-500 dark:text-unno-muted mb-2">Tamanhos comuns:</p>
              <div className="flex flex-wrap gap-2">
                {ETIQUETA_PRESETS.map(p => {
                  const ativo = num(campos.largura) === p.largura && num(campos.altura) === p.altura
                  return (
                    <button
                      key={`${p.largura}x${p.altura}`}
                      type="button"
                      onClick={() => aplicarPreset(t.tipo, p.largura, p.altura)}
                      className={[
                        'px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                        ativo
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-800',
                      ].join(' ')}
                    >
                      {p.largura}×{p.altura}mm
                      <span className="text-gray-400 ml-1.5">{p.nome}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Como vêm no rolo */}
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-unno-dim mt-6 mb-2">
              Como vêm no rolo
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <MedidaInput
                label="Colunas"
                valor={campos.colunas}
                erro={invalido('colunas', campos.colunas)}
                min={1} max={ETIQUETA_MAX_COLUNAS} step="1"
                onChange={v => setCampo(t.tipo, 'colunas', v)}
              />
              <MedidaInput
                label="Vão entre elas (mm)"
                valor={campos.espaco}
                erro={invalido('espaco', campos.espaco)}
                min={0} max={ETIQUETA_MAX_ESPACO_MM} step="0.5"
                largo
                onChange={v => setCampo(t.tipo, 'espaco', v)}
              />
              <MedidaInput
                label="Borda de cada lado (mm)"
                valor={campos.margem}
                erro={invalido('margem', campos.margem)}
                min={0} max={ETIQUETA_MAX_ESPACO_MM} step="0.5"
                largo
                onChange={v => setCampo(t.tipo, 'margem', v)}
              />
            </div>

            <div className="mt-3 rounded-lg bg-gray-50 dark:bg-white/[.04] px-3 py-2.5 text-xs text-gray-600 dark:text-unno-muted">
              <p>
                Largura total do rolo:{' '}
                <strong className="text-gray-900 dark:text-unno-text">
                  {arredonda(linha.largura)}mm
                </strong>{' '}
                <span className="text-gray-400">
                  ({config.colunas} × {arredonda(config.largura)}
                  {config.colunas > 1 && ` + ${config.colunas - 1} × ${arredonda(config.espaco)}`}
                  {config.margem > 0 && ` + 2 × ${arredonda(config.margem)}`})
                </span>
              </p>
              <p className="mt-1">
                Compare com o rolo na mão. Se não bater, o alinhamento sai errado —
                ajuste o vão ou a borda até a conta fechar.
              </p>
              <p className="mt-1">
                Desenho usado: <strong>{layout === 'retrato' ? 'em pé' : 'deitado'}</strong>
                {' · '}
                {descreveSobra(config)}
              </p>
            </div>
          </Card>
        )
      })}

      <Card className="p-5">
        {erro && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {erro}
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button onClick={salvar} loading={salvando} disabled={temInvalido}>
            Salvar
          </Button>
          {ok && <span className="text-sm text-emerald-600">Salvo. Já vale na próxima impressão.</span>}
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-unno-muted">
          Na janela de impressão, deixe a escala em 100% e não marque "ajustar à
          página" — senão o navegador redimensiona por cima do ajuste do sistema.
          Faça um teste em uma folha comum antes de gastar rolo.
        </p>
      </Card>
    </div>
  )
}

function arredonda(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function descreveSobra(config: EtiquetaConfig): string {
  const pct = Math.round(sobraEtiqueta(config) * 100)
  if (pct <= 1) return 'a etiqueta ocupa o papel inteiro'
  return `cerca de ${pct}% do papel fica em branco nas bordas`
}

function MedidaInput({ label, valor, erro, min, max, step, largo, onChange }: {
  label: string
  valor: string
  erro: boolean
  min: number
  max: number
  step: string
  largo?: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className={largo ? 'w-40' : 'w-28'}>
      <label className="text-xs text-gray-500 dark:text-unno-muted">{label}</label>
      <input
        type="number" min={min} max={max} step={step} inputMode="decimal"
        value={valor}
        onChange={e => onChange(e.target.value)}
        className={[
          'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-right',
          'focus:outline-none focus:ring-[3px] focus:ring-brand-500/10',
          erro ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-brand-500',
        ].join(' ')}
      />
    </div>
  )
}

/**
 * Miniatura de uma LINHA do rolo: cada retângulo branco é uma etiqueta, o
 * azul dentro dele é a área que o conteúdo ocupa depois do ajuste, e as
 * faixas cinza nas pontas são as bordas do rolo.
 */
function PreviewLinha({ config }: { config: EtiquetaConfig }) {
  const linha = dimsLinha(config)
  const LARGURA_MAX = 150 // px
  const ALTURA_MAX = 110 // px
  const px = Math.min(LARGURA_MAX / linha.largura, ALTURA_MAX / linha.altura)

  const base = LAYOUT_BASE[layoutDaEtiqueta(config)]
  const escala = escalaEtiqueta(config)
  const conteudo = {
    largura: base.largura * escala * px,
    altura: base.altura * escala * px,
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex items-center bg-gray-100 dark:bg-white/[.06] rounded-sm shrink-0"
        style={{
          width: `${linha.largura * px}px`,
          height: `${linha.altura * px}px`,
          padding: `0 ${config.margem * px}px`,
          gap: `${config.espaco * px}px`,
        }}
      >
        {Array.from({ length: config.colunas }, (_, i) => (
          <div
            key={i}
            className="relative border border-gray-400 bg-white shrink-0"
            style={{ width: `${config.largura * px}px`, height: `${config.altura * px}px` }}
          >
            <div
              className="absolute bg-brand-500/25 border border-brand-500/60"
              style={{
                width: `${conteudo.largura}px`,
                height: `${conteudo.altura}px`,
                left: `${(config.largura * px - conteudo.largura) / 2}px`,
                top: `${(config.altura * px - conteudo.altura) / 2}px`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="text-xs text-gray-500 dark:text-unno-muted leading-relaxed">
        <p className="font-medium text-gray-700 dark:text-unno-text">
          {arredonda(config.largura)}×{arredonda(config.altura)}mm
        </p>
        <p>
          {config.colunas === 1
            ? 'Uma etiqueta por linha.'
            : `${config.colunas} por linha do rolo.`}
        </p>
      </div>
    </div>
  )
}

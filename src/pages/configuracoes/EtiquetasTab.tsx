import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { Card } from '../../components/ui/Card'
import { SUBTIPO_LABELS } from '../../components/etiqueta/EtiquetaRecipiente'
import { Button } from '../../components/ui/Button'
import {
  ETIQUETA_CONFIG_PADRAO,
  ETIQUETA_MAX_COLUNAS,
  ETIQUETA_MAX_DESLOCAR_MM,
  ETIQUETA_MAX_ESPACO_MM,
  ETIQUETA_MAX_MM,
  ETIQUETA_MIN_MM,
  ETIQUETA_PRESETS,
  COLUNA_COPIAS_RECIPIENTE,
  COPIAS_MAX,
  COPIAS_MIN,
  baseDoLayout,
  colunasEtiqueta,
  copiasDoSubtipo,
  saneiaCopias,
  type CopiasPorSubtipo,
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
  /** Nome curto, para caber em listas e no passo a passo da impressora. */
  curto: string
  descricao: string
  onde: string
}[] = [
  {
    tipo: 'lote',
    titulo: 'Etiqueta de lote e sublote',
    curto: 'Lote e sublote',
    descricao:
      'A que vai colada na embalagem do insumo quando a mercadoria chega, com validade, QR Code e dados da empresa.',
    onde: 'Recebimento → Imprimir etiqueta',
  },
  {
    tipo: 'recipiente',
    titulo: 'Etiqueta de recipiente',
    curto: 'Recipiente',
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
    espacoLinha: String(config.espacoLinha),
    deslocarX: String(config.deslocarX),
    deslocarY: String(config.deslocarY),
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
  espacoLinha: { min: 0, max: ETIQUETA_MAX_ESPACO_MM },
  deslocarX: { min: -ETIQUETA_MAX_DESLOCAR_MM, max: ETIQUETA_MAX_DESLOCAR_MM },
  deslocarY: { min: -ETIQUETA_MAX_DESLOCAR_MM, max: ETIQUETA_MAX_DESLOCAR_MM },
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
  const [copias, setCopias] = useState<CopiasPorSubtipo>({})
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [ok, setOk] = useState(false)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!profile) return
    const cols = [
      ...Object.values(colunasEtiqueta('lote')),
      ...Object.values(colunasEtiqueta('recipiente')),
      COLUNA_COPIAS_RECIPIENTE,
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
        setCopias(saneiaCopias(row?.[COLUNA_COPIAS_RECIPIENTE]))
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
    const payload: Record<string, unknown> = {
      empresa_id: profile.empresa_id,
      [COLUNA_COPIAS_RECIPIENTE]: copias,
    }
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
          espacoLinha: num(campos.espacoLinha),
          deslocarX: num(campos.deslocarX),
          deslocarY: num(campos.deslocarY),
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
              <MedidaInput
                label="Vão entre linhas (mm)"
                valor={campos.espacoLinha}
                erro={invalido('espacoLinha', campos.espacoLinha)}
                min={0} max={ETIQUETA_MAX_ESPACO_MM} step="0.5"
                largo
                onChange={v => setCampo(t.tipo, 'espacoLinha', v)}
              />
            </div>

            {/* Ajuste fino */}
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-unno-dim mt-6 mb-2">
              Ajuste fino da posição
            </p>
            <p className="text-xs text-gray-500 dark:text-unno-muted mb-2">
              Se a impressão sair certa de tamanho mas deslocada, empurre por aqui.
              Positivo move para a direita / para baixo; negativo, para a esquerda /
              para cima. Mexa de 1 em 1mm e imprima uma etiqueta para conferir.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <MedidaInput
                label="Deslocar → (mm)"
                valor={campos.deslocarX}
                erro={invalido('deslocarX', campos.deslocarX)}
                min={-ETIQUETA_MAX_DESLOCAR_MM} max={ETIQUETA_MAX_DESLOCAR_MM} step="0.5"
                onChange={v => setCampo(t.tipo, 'deslocarX', v)}
              />
              <MedidaInput
                label="Deslocar ↓ (mm)"
                valor={campos.deslocarY}
                erro={invalido('deslocarY', campos.deslocarY)}
                min={-ETIQUETA_MAX_DESLOCAR_MM} max={ETIQUETA_MAX_DESLOCAR_MM} step="0.5"
                onChange={v => setCampo(t.tipo, 'deslocarY', v)}
              />
            </div>

            <div className="mt-3 rounded-lg bg-gray-50 dark:bg-white/[.04] px-3 py-2.5 text-xs text-gray-600 dark:text-unno-muted">
              <p>
                Página enviada à impressora:{' '}
                <strong className="text-gray-900 dark:text-unno-text">
                  {arredonda(linha.largura)} × {arredonda(linha.altura)}mm
                </strong>{' '}
                <span className="text-gray-400">
                  ({config.colunas} × {arredonda(config.largura)}
                  {config.colunas > 1 && ` + ${config.colunas - 1} × ${arredonda(config.espaco)}`}
                  {config.margem > 0 && ` + 2 × ${arredonda(config.margem)}`})
                </span>
              </p>
              <p className="mt-1">
                É esse tamanho que precisa estar configurado também no driver da
                impressora — que costuma pedir em centímetros:{' '}
                <strong className="text-gray-900 dark:text-unno-text">
                  Width {emCm(linha.largura)} / Height {emCm(linha.altura)}
                </strong>
                . Se não bater, o navegador encolhe a impressão para caber e tudo
                sai menor e fora de lugar.
              </p>
              <p className="mt-1">
                Desenho usado: <strong>{layout === 'retrato' ? 'em pé' : 'deitado'}</strong>
                {' · '}
                {descreveSobra(config)}
              </p>
            </div>

            {t.tipo === 'recipiente' && (
              <CopiasPorTipo copias={copias} onChange={c => { setOk(false); setCopias(c) }} />
            )}
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

      <Ajuda valores={valores} />
    </div>
  )
}

/**
 * O passo a passo da impressora.
 *
 * Fica aqui, e não numa conversa ou num documento à parte, porque é onde a
 * dúvida aparece — e porque os números que o driver pede são calculados a
 * partir da configuração de cima, em vez de escritos à mão e envelhecerem.
 */
function Ajuda({ valores }: { valores: Record<EtiquetaTipo, Campos> }) {
  const linhas = TIPOS.map(t => {
    const config = saneiaConfig({
      largura: num(valores[t.tipo].largura),
      altura: num(valores[t.tipo].altura),
      colunas: num(valores[t.tipo].colunas),
      espaco: num(valores[t.tipo].espaco),
      margem: num(valores[t.tipo].margem),
      espacoLinha: num(valores[t.tipo].espacoLinha),
    })
    return { tipo: t, pagina: dimsLinha(config) }
  })

  return (
    <Card className="p-5">
      <details className="group">
        <summary className="flex cursor-pointer items-center justify-between gap-3 list-none">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-unno-text">
              Como configurar a impressora
            </h2>
            <p className="text-sm text-gray-500 dark:text-unno-muted mt-0.5">
              Passo a passo do Windows, e o que muda ao trocar de rolo
            </p>
          </div>
          <svg
            className="w-5 h-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </summary>

        <div className="mt-4 space-y-5 text-sm text-gray-600 dark:text-unno-muted">
          <p>
            O tamanho do papel precisa estar dito em dois lugares: aqui em cima e
            no driver da impressora, no Windows. Se os dois não baterem, o
            navegador encolhe a impressão para caber no que o driver diz — e sai
            tudo menor e fora de lugar.
          </p>

          <Passos titulo="1. Abrir as preferências da impressora">
            <li>Tecla <Tecla>Windows</Tecla>, digite <Tecla>Painel de Controle</Tecla> e tecle Enter</li>
            <li>Em "Exibir por", no canto superior direito, escolha <strong>Ícones grandes</strong></li>
            <li>Clique em <strong>Dispositivos e Impressoras</strong></li>
            <li>Botão direito na etiquetadora → <strong>Preferências de impressão</strong></li>
          </Passos>

          <Passos titulo="2. Tamanho do papel (aba Options)">
            <li>Em "Paper Format", escolha <strong>cm</strong></li>
            <li>
              Em "Size", coloque a medida do formato que você vai imprimir:
              <ul className="mt-1 ml-4 space-y-0.5">
                {linhas.map(l => (
                  <li key={l.tipo.tipo}>
                    <span className="text-gray-500 dark:text-unno-dim">{l.tipo.curto}: </span>
                    <strong className="text-gray-900 dark:text-unno-text">
                      Width {emCm(l.pagina.largura)} / Height {emCm(l.pagina.altura)}
                    </strong>
                  </li>
                ))}
              </ul>
            </li>
            <li>Ajuste "Speed" e "Darkness" ao seu gosto (mais escuro = mais nítido, mais devagar)</li>
          </Passos>

          <Passos titulo="3. Sensor do rolo (aba Advanced Setup)">
            <li>"Media type": <strong>Label with gaps</strong>, para rolo picotado</li>
            <li>"Gap/Mark Height": o vão entre uma linha de etiquetas e a de baixo, em cm</li>
            <li>Deixe <strong>"Top of form backup" marcado</strong> — é ele que devolve a etiqueta à posição certa</li>
            <li>Se o alinhamento vertical começar a fugir, clique em <strong>Calibrate</strong></li>
          </Passos>

          <Passos titulo="4. Na hora de imprimir">
            <li>Em "Destino", escolha a etiquetadora</li>
            <li>Abra "Mais definições": <strong>Escala 100</strong> (nunca "ajustar à página")</li>
            <li><strong>Margens: Nenhuma</strong></li>
            <li>Marque <strong>Gráficos de plano de fundo</strong>, senão a tarja preta da validade sai vazia</li>
          </Passos>

          <div className="rounded-lg bg-amber-50 dark:bg-unno-amber/10 border border-amber-200 dark:border-unno-amber/30 px-3 py-2.5">
            <p className="font-medium text-amber-900 dark:text-unno-amber">Ao trocar de rolo</p>
            <p className="mt-1 text-amber-900/80 dark:text-unno-muted">
              O MischaOS guarda um formato para cada tipo de etiqueta e escolhe
              sozinho — você não mexe em nada aqui. Mas <strong>o driver do Windows
              tem um tamanho de papel só para a impressora inteira</strong>. Então,
              toda vez que trocar o rolo, refaça os passos 2 e 3 com a medida do
              formato novo. Vale conferir também o "Gap/Mark Height", que muda de
              um rolo para outro.
            </p>
          </div>

          <div className="rounded-lg bg-gray-50 dark:bg-white/[.04] px-3 py-2.5">
            <p className="font-medium text-gray-800 dark:text-unno-text">Se sair torto</p>
            <p className="mt-1">
              Primeiro confira o <strong>tamanho</strong>: se a impressão saiu menor
              que a etiqueta, é o driver que não bate — nenhum ajuste de posição
              resolve isso. Só depois que o tamanho estiver certo use o
              <strong> Ajuste fino</strong> aqui de cima, de meio em meio milímetro,
              imprimindo uma etiqueta a cada mudança.
            </p>
          </div>
        </div>
      </details>
    </Card>
  )
}

function Passos({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-medium text-gray-800 dark:text-unno-text mb-1.5">{titulo}</p>
      <ol className="list-decimal ml-5 space-y-1">{children}</ol>
    </div>
  )
}

function Tecla({ children }: { children: ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-white/[.12] bg-gray-50 dark:bg-white/[.06] text-xs font-mono">
      {children}
    </kbd>
  )
}

/** O driver pede em centímetros; a configuração é em milímetros. */
function emCm(mm: number): string {
  return (Math.round(mm) / 10).toFixed(2).replace('.', ',')
}

function arredonda(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function descreveSobra(config: EtiquetaConfig): string {
  const pct = Math.round(sobraEtiqueta(config) * 100)
  if (pct <= 1) return 'a etiqueta ocupa o papel inteiro'
  return `cerca de ${pct}% do papel fica em branco nas bordas`
}

/**
 * Quantas etiquetas cada tipo de recipiente leva na impressão em massa.
 *
 * O balde precisa de duas — uma no corpo e uma na tampa, senão não dá para
 * saber qual tampa é de qual balde depois que empilham. A garrafa precisa de
 * uma. Fica por TIPO e não por recipiente para que cadastrar o próximo balde
 * não dependa de alguém lembrar disso.
 */
function CopiasPorTipo({ copias, onChange }: {
  copias: CopiasPorSubtipo
  onChange: (c: CopiasPorSubtipo) => void
}) {
  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-unno-dim mt-6 mb-2">
        Etiquetas por tipo de recipiente
      </p>
      <p className="text-xs text-gray-500 dark:text-unno-muted mb-3">
        Quantas cópias sair de cada recipiente na impressão em massa
        (Recipientes → Imprimir etiquetas). Balde costuma precisar de duas —
        corpo e tampa — para dar match depois.
      </p>
      <div className="flex flex-wrap gap-3">
        {Object.entries(SUBTIPO_LABELS).map(([valor, rotulo]) => (
          <div key={valor} className="w-40">
            <label className="text-xs text-gray-500 dark:text-unno-muted">{rotulo}</label>
            <input
              type="number" min={COPIAS_MIN} max={COPIAS_MAX} step="1" inputMode="numeric"
              value={copiasDoSubtipo(copias, valor)}
              onChange={e => {
                const n = Math.round(Number(e.target.value))
                if (!Number.isFinite(n)) return
                const limitado = Math.min(COPIAS_MAX, Math.max(COPIAS_MIN, n))
                onChange({ ...copias, [valor]: limitado })
              }}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-right
                         focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10"
            />
          </div>
        ))}
      </div>
    </>
  )
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

  const base = baseDoLayout(config)
  const escala = escalaEtiqueta(config)
  const conteudo = {
    largura: base.largura * escala * px,
    altura: base.altura * escala * px,
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex items-start bg-gray-100 dark:bg-white/[.06] rounded-sm shrink-0 overflow-hidden"
        style={{
          width: `${linha.largura * px}px`,
          height: `${linha.altura * px}px`,
          padding: `0 ${config.margem * px}px`,
          gap: `${config.espaco * px}px`,
          // Reproduz o ajuste fino, para dar para ver o empurrão antes de imprimir.
          transform: `translate(${config.deslocarX * px}px, ${config.deslocarY * px}px)`,
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

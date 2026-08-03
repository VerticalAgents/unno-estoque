import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { Button } from '../ui/Button'

/**
 * O leitor de QR das telas de operação.
 *
 * Ele abre em TELA CHEIA. A versão anterior lia numa caixinha de 250x250
 * dentro de um cartão de no máximo 384px, num aparelho que tem a tela toda
 * disponível — mirar era difícil e a etiqueta precisava chegar perto.
 *
 * Duas coisas que faltavam e travavam o trabalho:
 *
 *   LANTERNA. Prateleira no fundo, câmara fria, pote na sombra do corpo de
 *   quem escaneia. Sem luz não lê, e não havia como acender.
 *
 *   DIGITAR À MÃO. Etiqueta rasgada, suja de gordura ou amassada acontece.
 *   Sem essa saída o trabalho simplesmente parava.
 *
 * A interface (`onScan`, `onError`, `label`) é a mesma de antes, para as
 * telas que já usam o leitor não precisarem mudar.
 */

interface QRScannerProps {
  onScan: (value: string) => void
  onError?: (error: string) => void
  label?: string
}

/** `torch` é extensão de fabricante: não está na tipagem padrão do navegador. */
type ComLanterna = MediaTrackCapabilities & { torch?: boolean }

export function QRScanner({ onScan, onError, label = 'Aponte a câmera para o QR Code' }: QRScannerProps) {
  const containerId = useRef(`qr-reader-${Math.random().toString(36).slice(2)}`)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [lendo, setLendo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [lido, setLido] = useState<string | null>(null)
  const [temLanterna, setTemLanterna] = useState(false)
  const [lanternaAcesa, setLanternaAcesa] = useState(false)
  const [digitando, setDigitando] = useState(false)
  const [codigoManual, setCodigoManual] = useState('')

  async function pararLeitura() {
    const s = scannerRef.current
    scannerRef.current = null
    setLendo(false)
    setTemLanterna(false)
    setLanternaAcesa(false)
    if (!s) return
    try {
      await s.stop()
      s.clear()
    } catch {
      // parar um leitor que já morreu não é problema de ninguém
    }
  }

  // A câmera precisa ser desligada ao sair da tela, senão a luzinha do
  // aparelho fica acesa e a bateria vai junto.
  useEffect(() => {
    return () => { void pararLeitura() }
  }, [])

  function aceitar(valor: string) {
    setLido(valor)
    void pararLeitura()
    // Confirmação no tato: numa cozinha barulhenta ninguém ouve o bipe.
    navigator.vibrate?.(60)
    onScan(valor)
  }

  async function iniciarLeitura() {
    setErro(null)
    setLendo(true)

    // O container do vídeo só existe depois que o React desenha a camada.
    await new Promise(r => setTimeout(r, 0))

    try {
      const scanner = new Html5Qrcode(containerId.current)
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Alvo proporcional à tela, em vez dos 250px fixos de antes.
          qrbox: (larguraVista, alturaVista) => {
            const lado = Math.floor(Math.min(larguraVista, alturaVista) * 0.72)
            return { width: lado, height: lado }
          },
        },
        texto => aceitar(texto),
        () => { /* quadro sem QR não é erro */ },
      )

      // Só dá para perguntar da lanterna com a câmera já rodando.
      try {
        const capacidades = scanner.getRunningTrackCapabilities() as ComLanterna
        setTemLanterna(Boolean(capacidades?.torch))
      } catch {
        setTemLanterna(false)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro ao acessar câmera'
      setErro(msg)
      setLendo(false)
      onError?.(msg)
    }
  }

  async function alternarLanterna() {
    const s = scannerRef.current
    if (!s) return
    const alvo = !lanternaAcesa
    try {
      await s.applyVideoConstraints({
        advanced: [{ torch: alvo }],
      } as unknown as MediaTrackConstraints)
      setLanternaAcesa(alvo)
    } catch {
      setTemLanterna(false)
    }
  }

  function confirmarManual() {
    const v = codigoManual.trim()
    if (!v) return
    setDigitando(false)
    setCodigoManual('')
    aceitar(v)
  }

  // ── Lido ────────────────────────────────────────────────────

  if (lido) {
    return (
      <div className="w-full p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-center">
        <svg className="w-8 h-8 text-emerald-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm font-medium text-emerald-800">Lido com sucesso</p>
        <p className="text-xs font-mono text-emerald-600 mt-1 break-all">{lido}</p>
        <button
          onClick={() => { setLido(null); void iniciarLeitura() }}
          className="mt-3 text-xs text-emerald-700 underline"
        >
          Escanear outro
        </button>
      </div>
    )
  }

  // ── Digitando à mão ─────────────────────────────────────────

  if (digitando) {
    return (
      <div className="w-full p-4 bg-gray-50 dark:bg-white/[.04] border border-gray-200 dark:border-white/[.08] rounded-xl">
        <p className="text-sm font-medium text-gray-900 dark:text-unno-text">Digitar o código</p>
        <p className="text-xs text-gray-500 dark:text-unno-muted mt-0.5 mb-3">
          É o código impresso na etiqueta, embaixo ou ao lado do QR.
        </p>
        <input
          autoFocus
          value={codigoManual}
          onChange={e => setCodigoManual(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirmarManual() }}
          placeholder="INS001-0001"
          className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base font-mono
                     focus:outline-none focus:border-brand-500 focus:ring-[3px] focus:ring-brand-500/10
                     dark:border-white/[.08] dark:bg-unno-raised dark:text-unno-text"
        />
        <div className="flex gap-2 mt-3">
          <Button variant="ghost" size="md" onClick={() => setDigitando(false)}>Voltar</Button>
          <Button size="md" fullWidth onClick={confirmarManual} disabled={!codigoManual.trim()}>
            Confirmar
          </Button>
        </div>
      </div>
    )
  }

  // ── Lendo: camada em tela cheia ─────────────────────────────

  if (lendo) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div id={containerId.current} className="flex-1 min-h-0 [&_video]:h-full [&_video]:object-cover" />

        <div className="absolute top-0 inset-x-0 p-4 flex items-start justify-between gap-3
                        bg-gradient-to-b from-black/70 to-transparent">
          <p className="text-sm text-white/90 pt-2">{label}</p>
          <button
            onClick={() => void pararLeitura()}
            aria-label="Fechar"
            className="p-2 rounded-full bg-black/40 text-white"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="absolute bottom-0 inset-x-0 p-4 folga-segura-baixo
                        bg-gradient-to-t from-black/70 to-transparent
                        flex items-center justify-center gap-3">
          {temLanterna && (
            <button
              onClick={() => void alternarLanterna()}
              className={[
                'flex items-center gap-2 px-4 py-3 rounded-full text-xs font-semibold uppercase tracking-wide',
                lanternaAcesa ? 'bg-white text-gray-900' : 'bg-white/15 text-white',
              ].join(' ')}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
              </svg>
              {lanternaAcesa ? 'Apagar' : 'Lanterna'}
            </button>
          )}
          <button
            onClick={() => { void pararLeitura(); setDigitando(true) }}
            className="px-4 py-3 rounded-full bg-white/15 text-white text-xs font-semibold uppercase tracking-wide"
          >
            Digitar código
          </button>
        </div>
      </div>
    )
  }

  // ── Parado ──────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <p className="text-sm text-gray-600 dark:text-unno-muted text-center">{label}</p>

      {erro && (
        <div className="w-full p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {erro.includes('NotAllowedError') || erro.includes('Permission denied')
            ? 'Permissão de câmera negada. Libere o acesso à câmera nas configurações do navegador.'
            : erro}
        </div>
      )}

      <Button onClick={() => void iniciarLeitura()} size="lg" fullWidth>
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        Escanear
      </Button>

      <button
        onClick={() => setDigitando(true)}
        className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-unno-muted underline"
      >
        Digitar código à mão
      </button>
    </div>
  )
}

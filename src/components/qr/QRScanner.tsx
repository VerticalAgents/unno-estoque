import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { Button } from '../ui/Button'

interface QRScannerProps {
  onScan: (value: string) => void
  onError?: (error: string) => void
  label?: string
}

export function QRScanner({ onScan, onError, label = 'Aponte a câmera para o QR Code' }: QRScannerProps) {
  const containerId = useRef(`qr-reader-${Math.random().toString(36).slice(2)}`)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState<string | null>(null)

  async function startScanner() {
    setError(null)
    try {
      const scanner = new Html5Qrcode(containerId.current)
      scannerRef.current = scanner

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          setScanned(decodedText)
          stopScanner()
          onScan(decodedText)
        },
        () => { /* ignore scanning errors */ }
      )
      setStarted(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao acessar câmera'
      setError(msg)
      onError?.(msg)
    }
  }

  async function stopScanner() {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop()
        scannerRef.current.clear()
      } catch {
        // ignore cleanup errors
      }
      scannerRef.current = null
      setStarted(false)
    }
  }

  useEffect(() => {
    return () => {
      stopScanner()
    }
  }, [])

  function handleRescan() {
    setScanned(null)
    startScanner()
  }

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <p className="text-sm text-gray-600 text-center">{label}</p>

      {scanned ? (
        <div className="w-full max-w-sm p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-center">
          <svg className="w-8 h-8 text-emerald-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm font-medium text-emerald-800">Lido com sucesso</p>
          <p className="text-xs font-mono text-emerald-600 mt-1 break-all">{scanned}</p>
          <button
            onClick={handleRescan}
            className="mt-3 text-xs text-emerald-700 underline"
          >
            Escanear outro
          </button>
        </div>
      ) : (
        <>
          <div
            id={containerId.current}
            className="w-full max-w-sm rounded-xl overflow-hidden bg-black min-h-[280px]"
          />

          {error && (
            <div className="w-full max-w-sm p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error === 'NotAllowedError: Permission denied'
                ? 'Permissão de câmera negada. Permite o acesso à câmera nas configurações do navegador.'
                : error}
            </div>
          )}

          {!started && !error && (
            <Button onClick={startScanner} size="lg" fullWidth className="max-w-sm">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Ativar câmera
            </Button>
          )}

          {started && (
            <Button variant="secondary" onClick={stopScanner} size="md">
              Cancelar
            </Button>
          )}
        </>
      )}
    </div>
  )
}

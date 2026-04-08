import { QRCodeSVG } from 'qrcode.react'

interface QRCodeDisplayProps {
  value: string
  size?: number
  label?: string
  showValue?: boolean
}

export function QRCodeDisplay({ value, size = 160, label, showValue = true }: QRCodeDisplayProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      {label && <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>}
      <div className="p-3 bg-white border border-gray-200 rounded-xl inline-block">
        <QRCodeSVG
          value={value}
          size={size}
          level="M"
          includeMargin={false}
        />
      </div>
      {showValue && (
        <p className="text-xs font-mono text-gray-600 select-all">{value}</p>
      )}
    </div>
  )
}

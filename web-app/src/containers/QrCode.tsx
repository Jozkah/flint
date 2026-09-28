import { useMemo } from 'react'
import { create } from 'qrcode'

/**
 * A QR code drawn as one SVG path from the encoder's module matrix, so no
 * markup string is injected into the page. Dark modules on a white card in
 * both themes: phone cameras read dark-on-light best.
 */
export function QrCode({
  value,
  size = 192,
  label,
}: {
  value: string
  size?: number
  label: string
}) {
  const { d, n } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: 'M' })
    const count = qr.modules.size
    let path = ''
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.modules.get(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`
      }
    }
    // Four modules of quiet zone on each side, as the spec asks.
    return { d: path, n: count + 8 }
  }, [value])

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="remote-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <path d={d} fill="#000" />
    </svg>
  )
}

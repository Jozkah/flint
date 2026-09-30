import type { CSSProperties } from 'react'
import manifest from '../generated/shots.json'
import { asset } from '../lib/site'

type Entry = { width: number; height: number; widths: number[] }
const M = manifest as Record<string, Entry>

/** Logical app pixels: the screenshots are 3200x2000 captures of a 1600x1000 window. */
export const LOGICAL_W = 1600
export type Region = { x: number; y: number; w: number; h: number }

const set = (id: string, fmt: 'avif' | 'webp') => M[id].widths.map((w) => `${asset(`shots/${id}-${w}.${fmt}`)} ${w}w`).join(', ')
export const shotUrl = (id: string, w: number, fmt: 'avif' | 'webp' = 'webp') => asset(`shots/${id}-${w}.${fmt}`)
export const shotSizes = (id: string) => M[id]

type Props = {
  id: string
  alt: string
  /** Crop to a region of the real screenshot (no pixels are altered, only framed). */
  region?: Region
  /** Approximate displayed width of the visible area: [desktop px, mobile vw]. */
  sizes?: [number, number]
  eager?: boolean
  className?: string
  style?: CSSProperties
}

export function Shot({ id, alt, region, sizes = [1100, 92], eager, className = '', style }: Props) {
  const e = M[id]
  if (!e) throw new Error(`Unknown screenshot: ${id}`)
  const scale = region ? LOGICAL_W / region.w : 1
  const sizesAttr = `(min-width: 960px) ${Math.round(sizes[0] * scale)}px, ${Math.round(sizes[1] * scale)}vw`
  const fallback = e.widths.includes(1920) ? 1920 : e.widths[e.widths.length - 1]
  const img = (
    <picture>
      <source type="image/avif" srcSet={set(id, 'avif')} sizes={sizesAttr} />
      <source type="image/webp" srcSet={set(id, 'webp')} sizes={sizesAttr} />
      <img
        src={shotUrl(id, fallback)}
        width={e.width}
        height={e.height}
        alt={region ? '' : alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding={eager ? 'sync' : 'async'}
        {...(eager ? { fetchPriority: 'high' as const } : {})}
        style={
          region
            ? {
                width: `${scale * 100}%`,
                left: `${(-region.x / region.w) * 100}%`,
                top: `${(-region.y / region.h) * 100}%`,
              }
            : undefined
        }
      />
    </picture>
  )
  if (!region) return <div className={`shot ${className}`} style={style}>{img}</div>
  return (
    <div
      className={`shot cam ${className}`}
      role="img"
      aria-label={alt}
      style={{ aspectRatio: `${region.w} / ${region.h}`, ...style }}
    >
      {img}
    </div>
  )
}

export function Frame({ children, className = '', flat }: { children: React.ReactNode; className?: string; flat?: boolean }) {
  return <div className={`frame spot ${flat ? 'flat' : ''} ${className}`}>{children}</div>
}

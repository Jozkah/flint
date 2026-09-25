import { cn } from '@/lib/utils'
import type { BrandLogo } from '@/lib/brandLogos'

/**
 * A provider or model mark in a card-coloured rounded tile (the design's
 * `.pav`). Without a logo the tile shows the name's first letter, so a
 * custom provider still gets a recognisable avatar.
 */
export function BrandMark({
  logo,
  name,
  size = 30,
  className,
  tone = 'card',
}: {
  logo?: BrandLogo
  name: string
  /** Tile edge in px; the mark fills about 62% of it. */
  size?: number
  className?: string
  /** `bare` drops the tile for inline use next to text. */
  tone?: 'card' | 'bare'
}) {
  return (
    <span
      data-slot="brand-mark"
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'inline-grid shrink-0 place-items-center overflow-hidden',
        tone === 'card' &&
          'rounded-[min(12px,28%)] bg-card shadow-[inset_0_0_0_0.8px_var(--border)]',
        className
      )}
    >
      {logo ? (
        <img
          src={logo.src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className={cn(
            'size-[62%] object-contain',
            logo.mono && 'dark:invert'
          )}
        />
      ) : (
        <span
          className="font-semibold text-secondary-foreground uppercase"
          style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}
        >
          {name.trim().charAt(0) || '?'}
        </span>
      )}
    </span>
  )
}

import { modelLogo } from '@/lib/brandLogos'
import { cn } from '@/lib/utils'

/** Tile colours for models with no brand mark, one per name. */
const TONES = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#db2777', '#4b5563']

const toneOf = (name: string) => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return TONES[Math.abs(h) % TONES.length]
}

/** "Jan Nano 4B" -> "JN"; "jan-nano-4b" -> "JN". */
const initials = (name: string) => {
  const words = name
    .replace(/\.(gguf|bin)$/i, '')
    .split(/[\s_\-/.:]+/)
    .filter((w) => /^[a-z]/i.test(w))
  const letters = (words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')
  return letters.toUpperCase()
}

/**
 * A model's mark in a small round tile (the design's `.mav`): the model
 * family's logo, else the serving provider's, else the name's initials on a
 * colour of their own.
 */
export function ModelAvatar({
  modelId,
  name,
  provider,
  size = 18,
  className,
}: {
  modelId: string
  /** Shown name, for the initials when there is no logo. */
  name?: string
  provider?: string
  size?: number
  className?: string
}) {
  const logo = modelLogo(modelId, provider)
  return (
    <span
      aria-hidden
      data-slot="model-avatar"
      style={{
        width: size,
        height: size,
        background: logo ? undefined : toneOf(name ?? modelId),
      }}
      className={cn(
        'inline-grid shrink-0 place-items-center overflow-hidden rounded-full',
        logo && 'bg-card shadow-[inset_0_0_0_0.8px_var(--border)]',
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
          className={cn('size-[64%] object-contain', logo.mono && 'dark:invert')}
        />
      ) : (
        <span
          className="leading-none font-semibold text-white"
          style={{ fontSize: Math.max(7, Math.round(size * 0.42)) }}
        >
          {initials(name ?? modelId)}
        </span>
      )}
    </span>
  )
}

import type { RoomModelRef } from '@/lib/rooms/types'
import { cn } from '@/lib/utils'
import { modelLogo as brandModelLogo, providerLogo, type BrandLogo } from '@/lib/brandLogos'

/**
 * The model's mark: its family first, so a Claude model served through
 * OpenRouter still shows the Claude mark rather than the router's; else the
 * provider's logo, then the participant's initial.
 */
function modelLogo(model: RoomModelRef | null | undefined): BrandLogo | undefined {
  if (!model) return undefined
  return brandModelLogo(model.id, model.provider) ?? providerLogo(model.provider)
}

/**
 * A participant's round avatar: the model's logo on a card disc, or the
 * participant's initial on their own colour when no logo is known. Always
 * decorative; the name beside it carries the meaning.
 */
export function RoomAvatar({
  model,
  name,
  color,
  size = 20,
  className,
}: {
  model?: RoomModelRef | null
  name: string
  color?: string
  size?: number
  className?: string
}) {
  const logo = modelLogo(model)
  return (
    <span
      aria-hidden
      data-slot="room-avatar"
      style={{ width: size, height: size, backgroundColor: logo ? undefined : color }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        logo
          ? 'bg-card shadow-[inset_0_0_0_0.8px_var(--border)]'
          : 'font-semibold text-white',
        !logo && !color && 'bg-muted-foreground',
        className
      )}
    >
      {logo ? (
        // A background, not an <img>: the avatar is decoration, and message
        // bodies are checked to never contain live images from model output.
        <span
          className={cn('size-[64%] bg-contain bg-center bg-no-repeat', logo.mono && 'dark:invert')}
          style={{ backgroundImage: `url("${logo.src}")` }}
        />
      ) : (
        <span style={{ fontSize: Math.max(8, Math.round(size * 0.42)) }} className="leading-none">
          {name.trim().charAt(0).toUpperCase() || '?'}
        </span>
      )}
    </span>
  )
}

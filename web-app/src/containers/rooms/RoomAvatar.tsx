import type { RoomModelRef } from '@/lib/rooms/types'
import { cn, getProviderLogo } from '@/lib/utils'

/**
 * Model families recognised from the model id, so a Claude model served through
 * OpenRouter still shows the Claude mark rather than the router's. Only logos
 * the app already bundles are used; anything else falls back to the provider's
 * logo, then to the participant's initial.
 */
const FAMILY_LOGOS: Array<[RegExp, string]> = [
  [/claude|anthropic/i, 'anthropic'],
  [/(^|[/:-])(gpt|o\d|chatgpt|openai)/i, 'openai'],
  [/gemini|gemma/i, 'gemini'],
  [/mistral|mixtral|codestral|magistral|devstral/i, 'mistral'],
  [/grok|xai/i, 'xai'],
  [/command-|cohere/i, 'cohere'],
  [/minimax/i, 'minimax'],
  [/nemotron|nvidia/i, 'nvidia'],
]

function modelLogo(model: RoomModelRef | null | undefined): string | undefined {
  if (!model) return undefined
  for (const [pattern, provider] of FAMILY_LOGOS) {
    if (pattern.test(model.id)) return getProviderLogo(provider)
  }
  return getProviderLogo(model.provider)
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
          className="size-[64%] bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${logo}")` }}
        />
      ) : (
        <span style={{ fontSize: Math.max(8, Math.round(size * 0.42)) }} className="leading-none">
          {name.trim().charAt(0).toUpperCase() || '?'}
        </span>
      )}
    </span>
  )
}

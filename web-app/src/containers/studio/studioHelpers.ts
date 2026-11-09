import { useMemo } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { cloudTargets, customCloudTargets, type CloudTarget } from '@/lib/studio/cloud'
import { IMAGE_SIZES, VIDEO_SIZES, customSize } from '@/lib/studio/helpers'
import { type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { CUSTOM, Form, T } from '@/containers/studio/studioTypes'
import { ageParts, formatDuration as formatTime, type AgeUnit } from '@/lib/time'

/** `3s`, `1m 20s`: how long a generation took. */
export function formatDuration(t: T, ms: number): string {
  return formatTime(ms, { style: 'words', t, largest: 'minute' })
}

/** What a running job is doing, in words. */
export function phaseText(t: T, phase: string): string {
  const known = ['queued', 'encoding', 'sampling', 'decoding', 'saving']
  return t(known.includes(phase) ? `studio:phase.${phase}` : 'studio:phase.working')
}

/** The hosted image models that can be used now: the providers with an API key set, and picture models on the user's own servers. */
export function useCloudTargets(kind: StudioKind): CloudTarget[] {
  const providers = useModelProvider((s) => s.providers)
  return useMemo(() => {
    if (kind !== 'image') return []
    const configured = new Set(
      providers
        .filter((p) => p.active && providerHasRemoteApiKeys(p))
        .map((p) => p.provider)
    )
    return [...cloudTargets(configured), ...customCloudTargets(providers)]
  }, [providers, kind])
}

/** The smallest and largest side a custom size may have: the hosted provider's, or the local model's. */
export function sideLimits(model: StudioModel, hosted?: CloudTarget): { min: number; max: number } {
  return hosted ? { min: 16, max: hosted.provider.limits.maxEdge } : { min: model.min_side, max: model.max_side }
}

/** The size the form asks for: a standard shape, or the two boxes snapped into range. */
export function chosenSize(
  kind: StudioKind,
  model: StudioModel,
  form: Form,
  hosted?: CloudTarget
): { width: number; height: number } {
  if (form.sizeIndex === CUSTOM) {
    return customSize(form.customWidth, form.customHeight, sideLimits(model, hosted), 1024)
  }
  const sizes = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  return sizes[Math.min(Math.max(form.sizeIndex, 0), sizes.length - 1)]
}

export const rise = (index: number) => ({
  animationDelay: `${40 + Math.min(index, 10) * 35}ms`,
})

/** "A few seconds" under 20 s, then at least a minute, each unit rounded from the last. */
const STUDIO_AGE_UNITS: readonly AgeUnit[] = [
  { unit: 'second', seconds: 1, until: 20 },
  { unit: 'minute', seconds: 60 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'day', seconds: 86_400 },
]

export function timeAgo(ms: number, t: T, language: string): string {
  const { value, unit } = ageParts(ms, {
    units: STUDIO_AGE_UNITS,
    cascade: true,
    pastOnly: true,
    minValue: 1,
  })
  if (unit === 'second') return t('studio:time.fewSeconds')
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(value, unit)
}

/** A flat gradient stand-in for a model preview: the colour comes from its id, so it stays the same. */
export function modelTint(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return `linear-gradient(135deg, hsl(${h} 55% 38%), hsl(${(h + 60) % 360} 60% 24%))`
}

/**
 * The shapes in the order the design lays them out, four to a row with Custom
 * last. Pairs keep the real index, so remixing a shape that is not shown
 * (21:9, reached through Custom) still works.
 */
export function shapeOrder<T extends { short: string }>(
  sizes: readonly T[],
  kind: StudioKind
): Array<[T, number]> {
  const all = sizes.map((s, i) => [s, i] as [T, number])
  if (kind !== 'image') return all
  const order = ['1:1', '4:3', '3:4', '16:9', '3:2', '2:3', '9:16']
  return order.flatMap((short) => all.filter(([s]) => s.short === short))
}

/** Blue marks what is chosen, as in the design. */
export const ON =
  'border-blue-500/70 bg-blue-500/10 text-foreground shadow-[0_0_0_1px_rgb(59_130_246/0.3)]'

export const OFF =
  'border-border bg-card text-muted-foreground hover:border-border-strong hover:bg-accent hover:text-foreground'

export const ACTIVITY_TONE = { done: 'ok', failed: 'err', stopped: 'neutral' } as const

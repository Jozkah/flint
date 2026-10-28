import { useMemo } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { cloudTargets, customCloudTargets, type CloudTarget } from '@/lib/studio/cloud'
import { IMAGE_SIZES, VIDEO_SIZES, customSize } from '@/lib/studio/helpers'
import { type StudioKind, type StudioModel } from '@/lib/studio/studio'
import { CUSTOM, Form, T } from '@/containers/studio/studioTypes'

/** `3 s`, `1 min 20 s`: how long a generation took. */
export function formatDuration(t: T, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('studio:duration.s', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0
    ? t('studio:duration.min', { count: minutes })
    : t('studio:duration.minS', { minutes, seconds: rest })
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

export function timeAgo(ms: number, t: T, language: string): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 20) return t('studio:time.fewSeconds')
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (s < 90) return rtf.format(-1, 'minute')
  const m = Math.round(s / 60)
  if (m < 60) return rtf.format(-m, 'minute')
  const h = Math.round(m / 60)
  if (h < 24) return rtf.format(-h, 'hour')
  return rtf.format(-Math.round(h / 24), 'day')
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

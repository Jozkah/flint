// Studio's running job, as `studio.progress` events report it (a few a
// second), so the preview's progress moves without refetching the status.

import type { StudioJobWire } from '@/lib/remote/protocol'
import { createStore } from './store'

export const studioJob = createStore<{ job: StudioJobWire | null | undefined }>({ job: undefined })

export type StudioForm = {
  sizeIndex: number
  count: number
  seconds: number
  seed: string
  negative: string
}

/** What the phone's Studio is set to, per kind; the settings sheet edits it. */
export const studioForm = createStore<{
  kind: 'image' | 'video'
  image: StudioForm
  video: StudioForm
  /** The low-memory warning for video was accepted. */
  memoryAck: boolean
}>({
  kind: 'image',
  image: { sizeIndex: 0, count: 1, seconds: 2, seed: '', negative: '' },
  video: { sizeIndex: 0, count: 1, seconds: 2, seed: '', negative: '' },
  memoryAck: false,
})

export function setStudioForm(patch: Partial<StudioForm>) {
  const s = studioForm.get()
  studioForm.set({ [s.kind]: { ...s[s.kind], ...patch } })
}

/** `Square · 4 images · seed random`. */
export function studioSummary(
  kind: 'image' | 'video',
  f: StudioForm,
  sizes: { label: string; short: string }[] | undefined
): string {
  const size = sizes?.[Math.min(f.sizeIndex, sizes.length - 1)]?.label ?? 'Square'
  const amount = kind === 'image' ? `${f.count} image${f.count === 1 ? '' : 's'}` : `${f.seconds} s`
  return `${size} · ${amount} · seed ${f.seed.trim() || 'random'}`
}

/** `Making image 2 of 4`, the phase and roughly how long is left. */
export function progressText(job: StudioJobWire, now: number) {
  const f = Math.min(1, Math.max(0, job.fraction))
  const title =
    job.kind === 'video'
      ? 'Making video'
      : `Making image ${Math.min(job.count, Math.floor(f * job.count) + 1)} of ${job.count}`
  const elapsed = Math.max(0, now - job.startedAt)
  let left = ''
  if (f > 0.02 && f < 1) {
    const s = Math.round((elapsed * (1 - f)) / f / 1000)
    left = s < 60 ? `${s} s left` : `${Math.round(s / 60)} min left`
  }
  return { title, left, percent: Math.round(f * 100) }
}

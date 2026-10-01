// A Studio result's media and small helpers shared by the screen and sheets.

import type { StudioItemWire } from '@/lib/remote/protocol'
import { useRpc } from '../state/rpc'

/** A gallery item's picture or clip, fetched from the computer as a data URL. */
export function Media({ item, controls = false }: { item: StudioItemWire; controls?: boolean }) {
  const { data } = useRpc('studio.media', { kind: item.kind, id: item.id })
  if (!data) return null
  return item.kind === 'video' ? (
    <video src={data.dataUrl} muted playsInline loop controls={controls} autoPlay={controls} />
  ) : (
    <img src={data.dataUrl} alt={item.recipe.prompt} />
  )
}

export const clipLength = (i: StudioItemWire) =>
  i.recipe.frames && i.recipe.fps ? `▶ 0:${String(Math.round(i.recipe.frames / i.recipe.fps)).padStart(2, '0')}` : '▶'

/** A seed typed on the phone: a whole number in range, or undefined for random. */
export function parseSeedText(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return n <= 4_294_967_295 ? n : undefined
}


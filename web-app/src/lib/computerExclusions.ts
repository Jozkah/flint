import { invoke } from '@tauri-apps/api/core'

/** A desktop rectangle (screen pixels) the `computer` tool never acts in. */
export type ExcludedRegion = {
  x: number
  y: number
  width: number
  height: number
}

export type ComputerExclusions = {
  regions: ExcludedRegion[]
  /** Process names. When not empty the tool acts only in windows of these apps. */
  allowedApps: string[]
}

const inTauri = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

export async function getComputerExclusions(): Promise<ComputerExclusions> {
  if (!inTauri()) return { regions: [], allowedApps: [] }
  return invoke<ComputerExclusions>('get_computer_exclusions')
}

export async function setComputerExclusions(
  exclusions: ComputerExclusions
): Promise<ComputerExclusions> {
  return invoke<ComputerExclusions>('set_computer_exclusions', { exclusions })
}

/** Apps with a visible window, to pick allowed apps from. */
export async function listOpenApps(): Promise<string[]> {
  if (!inTauri()) return []
  return invoke<string[]>('list_open_apps')
}

/** The desktop as a PNG data URL, to draw a region on. */
export async function captureDesktopPreview(): Promise<string> {
  return invoke<string>('capture_desktop_preview')
}

/**
 * A drag on an image shown at `shown` size, as a region in the image's own
 * (desktop) pixels. Order-independent, clamped to the image.
 */
export function regionFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
  shown: { width: number; height: number },
  natural: { width: number; height: number }
): ExcludedRegion {
  const sx = natural.width / Math.max(1, shown.width)
  const sy = natural.height / Math.max(1, shown.height)
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n))
  const x1 = clamp(Math.min(a.x, b.x) * sx, natural.width)
  const y1 = clamp(Math.min(a.y, b.y) * sy, natural.height)
  const x2 = clamp(Math.max(a.x, b.x) * sx, natural.width)
  const y2 = clamp(Math.max(a.y, b.y) * sy, natural.height)
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1),
  }
}

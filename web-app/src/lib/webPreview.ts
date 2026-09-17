/**
 * Pure helpers for the in-app web preview: URL eligibility, PIP geometry
 * clamping, and the link-interception predicate. Kept free of React and Tauri
 * so they are unit-testable in isolation.
 */

export function isPreviewableUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export type PipRect = { x: number; y: number; w: number; h: number }
export type Viewport = { w: number; h: number }

/** Keep a PIP rectangle inside the viewport, with minimum size floors. */
export function clampPipRect(
  rect: PipRect,
  vp: Viewport,
  minW = 280,
  minH = 200
): PipRect {
  const w = Math.max(minW, Math.min(rect.w, vp.w))
  const h = Math.max(minH, Math.min(rect.h, vp.h))
  const x = Math.max(0, Math.min(rect.x, vp.w - w))
  const y = Math.max(0, Math.min(rect.y, vp.h - h))
  return { x, y, w, h }
}

type ClickLike = {
  defaultPrevented: boolean
  button: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}
type AnchorLike = { href: string; target: string; origin: string }

/**
 * Whether a link click should open in the in-app preview rather than proceed
 * normally. External http(s) links on a plain left click qualify; same-origin
 * (in-app route) links, non-http schemes, modified/middle clicks, and
 * already-handled events do not.
 */
export function shouldIntercept(
  e: ClickLike,
  anchor: AnchorLike | null,
  appOrigin: string
): boolean {
  if (!anchor) return false
  if (e.defaultPrevented) return false
  if (e.button !== 0) return false
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false
  if (!isPreviewableUrl(anchor.href)) return false
  if (anchor.origin === appOrigin) return false
  return true
}

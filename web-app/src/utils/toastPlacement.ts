import type { ToasterProps } from 'sonner'

export type NotificationPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export const NOTIFICATION_POSITIONS: readonly NotificationPosition[] = [
  'top-right',
  'top-left',
  'bottom-right',
  'bottom-left',
] as const

export function isNotificationPosition(
  value: string
): value is NotificationPosition {
  return (NOTIFICATION_POSITIONS as readonly string[]).includes(value)
}

/** Windows + Tauri: avoid overlap with custom caption controls (see janhq/jan#7878). */
export function getDefaultNotificationPosition(): NotificationPosition {
  if (IS_WINDOWS && IS_TAURI) {
    return 'bottom-right'
  }
  return 'top-right'
}

/** The app's top header is 52px tall (TopHeader): a top toast starts below it. */
const TOP_HEADER_PX = 52
const BASE_MARGIN = 8

export type PreviewPane = {
  surface: 'side' | 'pip'
  rect: { left: number; top: number; right: number; bottom: number }
}

const PANE_GAP = 16
/** How near a PIP must sit to the toast's edge for the two to collide. */
const PIP_ZONE = 240

/**
 * The toast offset with the open Web preview pane stepped around. Right-side
 * positions move left of the pane (its width plus a gap); left positions stay.
 * The docked pane spans the full height; a PIP only matters when it sits near
 * the edge (top or bottom) the toasts stack from.
 */
export function getToastOffsetAvoidingPane(
  position: NotificationPosition,
  pane: PreviewPane | null,
  viewport: { width: number; height: number }
): NonNullable<ToasterProps['offset']> {
  const base = getToastOffset(position)
  if (!pane || !position.endsWith('right')) return base
  const { rect } = pane
  if (rect.right - rect.left <= 0) return base
  if (pane.surface === 'pip') {
    const near = position.startsWith('top')
      ? rect.top < PIP_ZONE
      : rect.bottom > viewport.height - PIP_ZONE
    if (!near) return base
  }
  const right = Math.max(
    BASE_MARGIN,
    Math.round(viewport.width - rect.left + PANE_GAP)
  )
  return { ...(base as object), right }
}

export function getToastOffset(
  position: NotificationPosition
): NonNullable<ToasterProps['offset']> {
  const topSafe = TOP_HEADER_PX

  switch (position) {
    case 'top-left':
      return { top: BASE_MARGIN + topSafe, left: BASE_MARGIN }
    case 'top-right':
      return {
        top: BASE_MARGIN + topSafe,
        right: BASE_MARGIN,
      }
    case 'bottom-left':
      return { bottom: BASE_MARGIN, left: BASE_MARGIN }
    case 'bottom-right':
      return { bottom: BASE_MARGIN, right: BASE_MARGIN }
  }
}

/** Tiny phones: toasts run full width (sonner's own mobile layout kicks in below 600px). */
export const NARROW_TOAST_PX = 640
/** Bottom offset on narrow screens, clear of the composer. */
const NARROW_BOTTOM_OFFSET = '96px'

export type ToasterPlacement = {
  position: ToasterProps['position']
  offset: ToasterProps['offset']
  mobileOffset: ToasterProps['mobileOffset']
}

/**
 * While a modal dialog or sheet is open its header and close button sit where
 * a top toast lands, so toasts move to the bottom edge instead (still above
 * the dialog layer, so an approval toast stays reachable). Narrow screens get
 * full-width bottom toasts lifted above the composer.
 */
export function getDialogToastPlacement(viewportWidth: number): ToasterPlacement {
  if (viewportWidth < NARROW_TOAST_PX) {
    const edge = { bottom: NARROW_BOTTOM_OFFSET, left: '16px', right: '16px' }
    return { position: 'bottom-center', offset: edge, mobileOffset: edge }
  }
  return {
    position: 'bottom-right',
    offset: { bottom: '24px', right: '24px' },
    mobileOffset: { bottom: NARROW_BOTTOM_OFFSET },
  }
}

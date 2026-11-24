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

/**
 * Bottom-right everywhere: a top toast sat over the header icons and the
 * Controls tab (and over Windows caption controls, janhq/jan#7878).
 */
export function getDefaultNotificationPosition(): NotificationPosition {
  return 'bottom-right'
}

/** The app's top header is 52px tall (TopHeader): a top toast starts below it. */
const TOP_HEADER_PX = 52
const BASE_MARGIN = 8
/**
 * A bottom toast stacks from above the composer dock (input, chips and its
 * footer line), so it never covers what the user is typing or its send button.
 * The device's bottom safe area is added on top.
 */
export const COMPOSER_CLEARANCE_PX = 164
const bottomClear = (px: number) =>
  `calc(${px}px + env(safe-area-inset-bottom, 0px))`

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
  viewport: { width: number; height: number },
  bottomClearance: number = COMPOSER_CLEARANCE_PX
): NonNullable<ToasterProps['offset']> {
  const base = getToastOffset(position, bottomClearance)
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

/** Toasts sit in the very corner of the window on every page (phones keep their own placement above the composer). */
export function composerClearanceFor(): number {
  return BASE_MARGIN * 2
}

type Rect = { left: number; right: number; top: number; bottom: number }

/**
 * The one block a corner toast must stay clear of: the composer and anything
 * marked `data-toast-avoid` (a room's dock of approval cards sits right above
 * its composer and holds the Allow/Deny buttons). Empty rects are ignored.
 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  const live = rects.filter((r) => r.right > r.left && r.bottom > r.top)
  if (live.length === 0) return null
  return {
    left: Math.min(...live.map((r) => r.left)),
    right: Math.max(...live.map((r) => r.right)),
    top: Math.min(...live.map((r) => r.top)),
    bottom: Math.max(...live.map((r) => r.bottom)),
  }
}

/** A toast is 356px wide plus its side margin (sonner's default width). */
const TOAST_ZONE_PX = 356 + 16
const COMPOSER_GAP = 12

/**
 * Bottom clearance for corner toasts so they never sit over the composer's
 * Send/Stop/model controls. The corner stays free when the composer ends
 * before the toast's column starts (wide windows); when the two overlap the
 * toasts stack from above the composer instead. `composer` is the composer
 * block's bounding rect, or null when the page has none.
 */
export function composerAwareClearance(
  composer: { left: number; right: number; top: number; bottom: number } | null,
  viewport: { width: number; height: number }
): number {
  const corner = composerClearanceFor()
  if (!composer || composer.right <= composer.left) return corner
  if (composer.bottom <= 0 || composer.top >= viewport.height) return corner
  if (composer.right <= viewport.width - TOAST_ZONE_PX) return corner
  // Never lift past half the window: a toast stack must stay on screen.
  const lift = Math.round(viewport.height - composer.top + COMPOSER_GAP)
  return Math.max(corner, Math.min(lift, Math.round(viewport.height / 2)))
}

export function getToastOffset(
  position: NotificationPosition,
  bottomClearance: number = COMPOSER_CLEARANCE_PX
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
      return { bottom: bottomClear(bottomClearance), left: 16 }
    case 'bottom-right':
      return { bottom: bottomClear(bottomClearance), right: 16 }
  }
}

/** Tiny phones: toasts run full width (sonner's own mobile layout kicks in below 600px). */
export const NARROW_TOAST_PX = 640
/** Bottom offset on narrow screens, clear of the composer. */
const NARROW_BOTTOM_OFFSET = bottomClear(COMPOSER_CLEARANCE_PX)

/** Phones (<=640): full-width toasts, bottom-center, lifted above the composer. */
export function getNarrowToastPlacement(): ToasterPlacement {
  const edge = { bottom: NARROW_BOTTOM_OFFSET, left: '12px', right: '12px' }
  return { position: 'bottom-center', offset: edge, mobileOffset: edge }
}

export type ToasterPlacement = {
  position: ToasterProps['position']
  offset: ToasterProps['offset']
  mobileOffset: ToasterProps['mobileOffset']
}

/**
 * While a modal dialog or sheet is open toasts go to the bottom-left corner:
 * a dialog's Save / Cancel sit at the right of its footer, and the top edge is
 * where its header and close button are. The toast stays above the dialog layer
 * so an approval toast is still reachable. Narrow screens get full-width bottom
 * toasts lifted above the composer.
 */
export function getDialogToastPlacement(viewportWidth: number): ToasterPlacement {
  if (viewportWidth <= NARROW_TOAST_PX) return getNarrowToastPlacement()
  return {
    position: 'bottom-left',
    offset: { bottom: bottomClear(24), left: '24px' },
    mobileOffset: { bottom: NARROW_BOTTOM_OFFSET },
  }
}

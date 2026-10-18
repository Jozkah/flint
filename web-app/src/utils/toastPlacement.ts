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

/** Settings has no composer: its toasts sit at the corner, not above a dock that is not there. */
export function composerClearanceFor(pathname: string): number {
  return pathname.startsWith('/settings') ? BASE_MARGIN * 2 : COMPOSER_CLEARANCE_PX
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
 * While a modal dialog or sheet is open its header and close button sit where
 * a top toast lands, so toasts move to the bottom edge instead (still above
 * the dialog layer, so an approval toast stays reachable). Narrow screens get
 * full-width bottom toasts lifted above the composer.
 */
export function getDialogToastPlacement(viewportWidth: number): ToasterPlacement {
  if (viewportWidth <= NARROW_TOAST_PX) return getNarrowToastPlacement()
  return {
    position: 'bottom-right',
    offset: { bottom: bottomClear(24), right: '24px' },
    mobileOffset: { bottom: NARROW_BOTTOM_OFFSET },
  }
}

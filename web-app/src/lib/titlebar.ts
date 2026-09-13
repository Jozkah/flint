// Single source of truth for the platform-dependent title-bar layout.
//
// Before this, the "does the native macOS traffic-light overlay own the
// window's top-left?" decision was re-derived inline from the build-time
// `IS_MACOS` define in both the left sidebar and the page header. That had two
// problems the integration exposed:
//
//  1. Duplication — two components computed the same reservation slightly
//     differently, so a fix in one could miss the other.
//  2. A silent failure mode — `IS_MACOS` is defined from `TAURI_ENV_PLATFORM`
//     at *build* time (see vite.config.ts). A web bundle built without the
//     Tauri CLI (e.g. a bare `vite build`) has `IS_MACOS === false` even when
//     it later runs on macOS, which dropped the traffic-light reservation and
//     let the "Jan" wordmark slide underneath the native close/min/max buttons
//     — exactly the reported overlap.
//
// The reservation is therefore resolved from the build-time define OR a runtime
// check, and the pure layout maths live in one tested place both components
// consume.

/** Build-time defines (vite `define`), absent/false in unit tests. */
declare const IS_MACOS: boolean
declare const IS_LINUX: boolean

/**
 * Who draws the window's title bar.
 *
 *  - `native`: the operating system draws a real title bar (Windows). It owns
 *    dragging, double-click maximise, Snap Layouts, the system menu and the
 *    caption buttons, so the app must not reserve space for buttons of its own
 *    or declare any drag region -- a drag region inside the client area would
 *    only turn clicks on the page into window drags.
 *  - `mac-overlay`: macOS draws the traffic lights over the web content, and the
 *    app supplies the drag region.
 *  - `custom`: the window is borderless and the app draws everything (Linux,
 *    where GTK3 cannot negotiate a slim server-side bar on Wayland).
 */
export type WindowChrome = 'native' | 'mac-overlay' | 'custom'

export function detectWindowChrome(opts?: {
  macOverlay?: boolean
  linux?: boolean
}): WindowChrome {
  const macOverlay = opts?.macOverlay ?? detectMacOverlay()
  if (macOverlay) return 'mac-overlay'
  const linux = opts?.linux ?? (typeof IS_LINUX !== 'undefined' && IS_LINUX)
  return linux ? 'custom' : 'native'
}

/** Whether the page header must act as the window's drag handle. */
export function headerDragsWindow(chrome: WindowChrome): boolean {
  return chrome !== 'native'
}

/**
 * Window-control buttons the app itself has to draw. Only a borderless window
 * has any; with native chrome the system's own buttons are in the title bar
 * above the page, so reserving room for app-drawn ones leaves a dead strip.
 */
export function appDrawnButtonCounts(
  chrome: WindowChrome,
  layout: { left: number; right: number }
): { left: number; right: number } {
  return chrome === 'custom' ? layout : { left: 0, right: 0 }
}

/**
 * Whether the native macOS traffic-light overlay owns the window's top-left,
 * so the app must keep its own chrome clear of that corner.
 *
 * Authoritative when the build-time define says macOS. Otherwise falls back to
 * a runtime check, but only inside the Tauri shell — a plain browser tab has no
 * native traffic lights to avoid, and the web build must never reserve the
 * corner for buttons that aren't there.
 */
export function detectMacOverlay(nav?: {
  userAgent?: string
  platform?: string
}): boolean {
  if (typeof IS_MACOS !== 'undefined' && IS_MACOS) return true

  const navigatorLike =
    nav ??
    (typeof navigator !== 'undefined'
      ? { userAgent: navigator.userAgent, platform: navigator.platform }
      : undefined)
  if (!navigatorLike) return false

  const inTauri =
    typeof window !== 'undefined' &&
    ((window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ !== undefined ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined)
  if (!inTauri) return false

  const ua = `${navigatorLike.userAgent ?? ''} ${navigatorLike.platform ?? ''}`
  // iOS reports "iPhone"/"iPad" and has no traffic lights; exclude it. (An iPad
  // in desktop mode can spoof "Macintosh", but Jan ships no iPad target.)
  if (/iPhone|iPad|iPod/i.test(ua)) return false
  return /Mac OS X|Macintosh|MacIntel/i.test(ua)
}

/** Resolved sidebar-header layout for the current platform + window controls. */
export type SidebarTitlebar = {
  /** Left-anchored custom controls (Linux DEs that place them there). */
  controlsOnLeft: boolean
  /** Keep the top-left corner clear (macOS overlay, or left-anchored buttons). */
  reserveLeft: boolean
  /** Render the "Jan" wordmark on the left edge. */
  showWordmarkLeft: boolean
  /** Render the "Jan" wordmark inside the right control cluster instead. */
  showWordmarkRight: boolean
}

/**
 * Where the sidebar header may place the "Jan" wordmark.
 *
 * On macOS (native overlay) or when a Linux DE anchors its window buttons on
 * the left, the top-left belongs to those buttons: the wordmark is hidden there
 * and the header right-aligns. With left-anchored *custom* buttons the wordmark
 * moves into the right cluster; on macOS it is simply not shown, since the
 * native buttons already brand the corner and a second label would crowd them.
 */
export function resolveSidebarTitlebar(
  macOverlay: boolean,
  leftButtonCount: number
): SidebarTitlebar {
  const controlsOnLeft = !macOverlay && leftButtonCount > 0
  const reserveLeft = macOverlay || controlsOnLeft
  return {
    controlsOnLeft,
    reserveLeft,
    showWordmarkLeft: !reserveLeft,
    showWordmarkRight: controlsOnLeft,
  }
}

/** Width one window-control button reserves, matching the `size-8` buttons. */
const BUTTON_PX = 32
/** Breathing room past a control cluster so header content never touches it. */
const CLUSTER_GAP_PX = 24

/** Resolved page-header padding that keeps content clear of window controls. */
export type HeaderInset = {
  /** Apply the fixed macOS traffic-light indent (`pl-24`) on the left. */
  macLeftPad: boolean
  /** Explicit left padding in px for left-anchored Linux controls, if any. */
  leftPx?: number
  /** Explicit right padding in px for right-anchored controls, if any. */
  rightPx?: number
}

/**
 * Padding the page header needs so its content (the collapsed-sidebar toggle,
 * page title, etc.) never lands under the window controls, at any width.
 *
 * The macOS traffic lights only threaten the header when the sidebar is
 * collapsed (open, the sidebar itself covers the corner). Linux/Windows custom
 * controls are reserved by an exact pixel width derived from how many buttons
 * each side carries.
 */
export function resolveHeaderInset(opts: {
  macOverlay: boolean
  sidebarOpen: boolean
  leftButtonCount: number
  rightButtonCount: number
}): HeaderInset {
  const { macOverlay, sidebarOpen, leftButtonCount, rightButtonCount } = opts
  const clusterPx = (n: number) => (n > 0 ? n * BUTTON_PX + CLUSTER_GAP_PX : undefined)
  return {
    macLeftPad: macOverlay && !sidebarOpen,
    leftPx:
      !macOverlay && !sidebarOpen ? clusterPx(leftButtonCount) : undefined,
    rightPx: clusterPx(rightButtonCount),
  }
}

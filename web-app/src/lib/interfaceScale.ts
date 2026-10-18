import { getCurrentWebview } from '@tauri-apps/api/webview'

/** The size the design is drawn at; the interface size scales relative to it. */
export const DESIGN_FONT_SIZE = '16px'

/**
 * WebKitGTK (the Linux webview) mis-sizes the app surface under CSS zoom: it
 * leaves a bar under the window and offsets the sidebar glide. Those webviews
 * are marked with html.no-css-zoom (see .app-zoom in index.css).
 */
export function isWebKitGtk(userAgent: string): boolean {
  return (
    /Linux/.test(userAgent) &&
    !/Android/.test(userAgent) &&
    !/Chrome|Chromium|Edg\//.test(userAgent)
  )
}

/** Interface size ('18px') as a zoom factor of the 16px design. */
export function interfaceZoomFactor(size: string): number {
  const px = parseFloat(size)
  if (!Number.isFinite(px) || px <= 0) return 1
  return Math.round((px / 16) * 1000) / 1000
}

const isTauri = () => typeof IS_TAURI !== 'undefined' && !!IS_TAURI

/**
 * Whether the interface size is applied as native webview zoom. In the Linux
 * desktop app CSS zoom is off, and the rem fallback only grew the text while
 * icons, rows, paddings and the sidebar kept their pixel size. WebKitGTK's
 * page zoom scales the whole page uniformly, menus included, so it is used
 * instead there. Other platforms keep CSS zoom.
 */
export function usesNativeInterfaceZoom(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    isWebKitGtk(navigator.userAgent)
  )
}

type SetZoom = (factor: number) => Promise<unknown> | unknown

const defaultSetZoom: SetZoom = (factor) =>
  getCurrentWebview().setZoom(factor)

/**
 * Apply the chosen interface size. With native zoom the rem scale stays at
 * design size (or text would grow twice) and the webview zooms instead.
 */
export function applyInterfaceFontSize(
  size: string,
  setZoom: SetZoom = defaultSetZoom
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.style
  if (!usesNativeInterfaceZoom()) {
    root.setProperty('--font-size-base', size)
    return
  }
  root.setProperty('--font-size-base', DESIGN_FONT_SIZE)
  // Message zoom builds on --app-font-base; keep it at design size too.
  root.setProperty('--app-font-base', DESIGN_FONT_SIZE)
  try {
    Promise.resolve(setZoom(interfaceZoomFactor(size))).catch((e) =>
      console.warn('Could not apply the interface zoom', e)
    )
  } catch (e) {
    console.warn('Could not apply the interface zoom', e)
  }
}

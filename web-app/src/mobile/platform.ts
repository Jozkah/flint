// iOS detection for the phone app. Pure so it can be tested; main.tsx applies
// the result as the `ios` class on <html>, which ios.css scopes everything to.

export type IosProbe = {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  search?: string
}

/** iPhone/iPad (including iPadOS, which reports a Mac UA but has touch), or `?ios=1`. */
export function detectIos(p: IosProbe): boolean {
  if (/[?&]ios=1(?:&|$)/.test(p.search ?? '')) return true
  if (/iPhone|iPad|iPod/.test(p.userAgent)) return true
  const mac = /Macintosh/.test(p.userAgent) || p.platform === 'MacIntel'
  return mac && (p.maxTouchPoints ?? 0) > 1
}

export function isIos(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('ios')
}

/** Adds the `ios` class to <html> when running on iOS. Call before first render. */
export function applyIosClass(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false
  const on = detectIos({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    search: typeof location !== 'undefined' ? location.search : '',
  })
  if (on) document.documentElement.classList.add('ios')
  return on
}

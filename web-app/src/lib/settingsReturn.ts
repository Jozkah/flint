/**
 * Where "leave Settings" goes: the last page visited outside Settings, else
 * home (janhq/jan#8581). Fed from the router in main.tsx.
 */
let lastOutside = '/'
let go: (to: string) => void = () => {}

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

export function noteLocation(href: string): void {
  const pathname = href.split(/[?#]/)[0]
  if (!isSettingsPath(pathname)) lastOutside = href
}

export function settingsReturnPath(): string {
  return lastOutside
}

/** Wires navigation (main.tsx), so the button needs no router hook. */
export function setSettingsNavigator(navigate: (to: string) => void): void {
  go = navigate
}

export function leaveSettings(): void {
  go(lastOutside)
}

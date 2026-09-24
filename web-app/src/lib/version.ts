import { isDev } from './utils'

export const isNightly = VERSION.includes('-')
export const isBeta = VERSION.includes('beta')
export const isProd = !isNightly && !isBeta && !isDev()

/**
 * Builds that show the Cowork surface (sidebar tab, routes and settings).
 *
 * Upstream Jan gates Cowork to nightly and dev builds (janhq/jan#9024). In this
 * fork Cowork is a first-class surface, so it is on in every channel by
 * default. A build can opt back into upstream's channel gate by setting
 * `VITE_COWORK_CHANNEL_GATE=true`, in which case it ships in nightly builds and
 * the dev server only - beta builds carry a hyphen too (`0.7.4-beta`), so
 * `isBeta` is excluded explicitly. Read at render time: `isDev()` looks at
 * `window.location`, so tests can stub the channel per case.
 */
export const isCoworkEnabled = (): boolean => {
  if (import.meta.env.VITE_COWORK_CHANNEL_GATE !== 'true') return true
  return (isNightly && !isBeta) || isDev()
}

import { redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { isCoworkEnabled } from '@/lib/version'

/**
 * `beforeLoad` guard for every Cowork URL. When a build opts into the channel
 * gate (see `isCoworkEnabled`) and does not ship Cowork, a bookmarked
 * `/cowork` or `/artifacts` link lands on `fallback` instead of mounting a
 * surface that has no entry point left. A no-op in the default fork build.
 *
 * Named `coworkGate` rather than upstream's `coworkAccess`, which in this fork
 * is the Cowork write-access model.
 */
export function ensureCoworkEnabled(fallback: string = route.home) {
  if (!isCoworkEnabled()) throw redirect({ to: fallback })
}

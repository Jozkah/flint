/**
 * Asset-protocol access for user-chosen paths.
 *
 * The static `assetProtocol.scope` in tauri.conf.json covers only the standard
 * user roots. Files on other drives or in a custom data folder need a runtime
 * grant (`allow_asset_path`) before `convertFileSrc` URLs for them will load.
 * Grants are requested once per path and remembered.
 */
import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getServiceHub } from '@/hooks/useServiceHub'

/** 1x1 transparent GIF shown while a grant is pending (allowed by img/media CSP). */
export const ASSET_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const inTauri = () => typeof IS_TAURI !== 'undefined' && IS_TAURI

const pending = new Map<string, Promise<void>>()
const granted = new Set<string>()

/** Grant the webview asset access to `path`. Never rejects; a refusal just leaves the URL unloadable. */
export function ensureAssetAccess(path: string, recursive = false): Promise<void> {
  if (!inTauri()) return Promise.resolve()
  const key = `${recursive ? 'r' : 'f'}:${path}`
  const known = pending.get(key)
  if (known) return known
  const run = invoke<void>('allow_asset_path', { path, recursive })
    .then(() => {
      granted.add(key)
    })
    .catch((error) => {
      console.warn('allow_asset_path refused:', path, error)
      granted.add(key) // refused is final; do not retry on every render
    })
  pending.set(key, run)
  return run
}

/** Grant access, then return the `asset:` URL for `path`. */
export async function toAssetUrl(path: string, protocol?: string): Promise<string> {
  await ensureAssetAccess(path)
  return getServiceHub().core().convertFileSrc(path, protocol)
}

/**
 * Render-time converter. Returns the asset URL once the grant for `path` has
 * landed (re-rendering the caller then); a transparent placeholder until then.
 */
export function useAssetUrl(): (path: string) => string {
  const [version, bump] = useState(0)
  return useCallback(
    (path: string) => {
      if (!inTauri() || granted.has(`f:${path}`)) {
        return getServiceHub().core().convertFileSrc(path)
      }
      void ensureAssetAccess(path).then(() => bump((n) => n + 1))
      return ASSET_PLACEHOLDER
    },
    // A new identity per grant lets memoised callers recompute their URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  )
}

/** Test seam. */
export function resetAssetAccessCache() {
  pending.clear()
  granted.clear()
}

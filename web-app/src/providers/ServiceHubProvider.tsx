import { useEffect, useState } from 'react'
import { initializeServiceHub } from '@/services'
import { initializeServiceHubStore } from '@/hooks/useServiceHub'
import { hydrateBackendStores } from '@/lib/hydrateStores'
import { migrateLocalStorageToBackend } from '@/lib/migrateLocalStorageSettings'
import { isChatWindow } from '@/lib/soloFlag'
import { bootMark } from '@/lib/bootMarks'
import { noteBootError } from '@/lib/bootWatchdog'

interface ServiceHubProviderProps {
  children: React.ReactNode
}

/**
 * One failed fetch of a service module ("Failed to fetch dynamically imported
 * module": the dev server re-optimising dependencies, a busy server, a file
 * saved mid-load) must not end the app, so the hub is tried a few times.
 */
export const HUB_ATTEMPTS = 3
export const HUB_RETRY_MS = 1500

export async function initializeServiceHubWithRetry(
  attempts: number = HUB_ATTEMPTS,
  pauseMs: number = HUB_RETRY_MS
) {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await initializeServiceHub()
    } catch (error) {
      last = error
      noteBootError(error)
      console.error(`Service initialization failed (attempt ${i + 1}/${attempts}):`, error)
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, pauseMs))
    }
  }
  throw last
}

/**
 * A module that failed to fetch is remembered as failed by the page, so more
 * tries in the same page cannot succeed; a reload can. At most once a minute,
 * so a server that is really down ends on the error screen, not in a loop.
 */
export function reloadOnceForModuleFetch(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  if (!/dynamically imported module|Importing a module script failed/i.test(text))
    return false
  try {
    const key = 'flint-hub-reload-at'
    const last = Number(sessionStorage.getItem(key) ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(key, String(Date.now()))
    window.location.reload()
    return true
  } catch {
    return false
  }
}

/** Migration + hydration of the persisted stores; throws if any saved settings could not be read. */
async function loadPersistedStores() {
  // One-time localStorage -> backend migration must run before hydration
  // so the backend store is populated before any store reads it.
  // (A "New window" opens after the main window did that.)
  if (!isChatWindow()) await migrateLocalStorageToBackend()
  // Settings stores use async backend storage; hydrate before rendering
  // children so no component reads pre-hydration defaults.
  await hydrateBackendStores()
  bootMark('hub:stores-hydrated')
}

export function ServiceHubProvider({ children }: ServiceHubProviderProps) {
  const [isReady, setIsReady] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The hub works but the saved settings could not be read.
  const [hydrationFailed, setHydrationFailed] = useState<string | null>(null)

  const hydrate = () => {
    setHydrationFailed(null)
    loadPersistedStores().then(
      () => setIsReady(true),
      (error) => {
        // Never start on defaults: the next write would replace the user's
        // saved settings with them. Stop here and offer a retry.
        console.error('Store hydration failed:', error)
        setHydrationFailed(error instanceof Error ? error.message : String(error))
      }
    )
  }

  useEffect(() => {
    initializeServiceHubWithRetry()
      .then((hub) => {
        console.log('Services initialized, initializing Zustand store')
        bootMark('hub:initialized')
        initializeServiceHubStore(hub)
        hydrate()
      })
      .catch((error) => {
        console.error('Service initialization failed:', error)
        if (reloadOnceForModuleFetch(error)) return
        // Rendering the app without its services only throws in every
        // component and leaves the splash up; say what happened instead.
        setFailed(error instanceof Error ? error.message : String(error))
      })
  }, [])

  const errorText = failed ?? hydrationFailed
  if (errorText) {
    // Plain markup: the i18n bundle and the stores may be what failed.
    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10000,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          textAlign: 'center',
          background: 'var(--background, #0a0b0d)',
          color: 'var(--foreground, #e6e8eb)',
        }}
      >
        <strong>
          {failed
            ? 'Flint could not finish starting.'
            : 'Flint could not read your saved settings.'}
        </strong>
        <span style={{ maxWidth: 520, opacity: 0.75 }}>{errorText.slice(0, 300)}</span>
        {!failed && (
          <span style={{ maxWidth: 520, opacity: 0.75 }}>
            Nothing was changed. Try again, or reload.
          </span>
        )}
        {!failed && (
          <button type="button" onClick={hydrate}>
            Try again
          </button>
        )}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }

  return <>{isReady && children}</>
}

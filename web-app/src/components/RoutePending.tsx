import { useEffect, useState } from 'react'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { AlertTriangle, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { crumbForPath } from '@/lib/breadcrumb'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * What the main area shows while a page's code loads.
 *
 * Pages are separate chunks. Without this the URL and breadcrumb moved on at
 * once while the previous page stayed on screen for seconds, and once for
 * over 20 s with no sign anything was happening (T7-131, T7-134).
 */

/** How long a page may take before the user is offered a reload. */
export const ROUTE_STALL_MS = 8000

export function RoutePending() {
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const crumb = crumbForPath(pathname)
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    setStalled(false)
    const id = window.setTimeout(() => setStalled(true), ROUTE_STALL_MS)
    return () => window.clearTimeout(id)
  }, [pathname])

  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="route-pending"
      className="flex h-full w-full flex-col gap-4 p-6"
    >
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t(crumb.parentKey)}</p>
        {crumb.currentKey && (
          <h1 className="text-lg font-semibold text-foreground">
            {t(crumb.currentKey)}
          </h1>
        )}
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      {stalled && (
        <p className="text-sm text-muted-foreground">
          {t('common:routeLoading.slow')}{' '}
          <button
            type="button"
            className="font-medium text-acc-text hover:underline"
            onClick={() => window.location.reload()}
          >
            {t('common:routeLoading.reload')}
          </button>
        </p>
      )}
    </div>
  )
}

/** A page whose code failed to load: say so, and offer another try. */
export function RouteLoadError({ error }: { error: unknown; reset?: () => void }) {
  const { t } = useTranslation()
  const router = useRouter()
  return (
    <div className="flex h-full w-full items-start justify-center p-6">
      <div role="alert" className="w-full max-w-lg space-y-3">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <h1 className="text-sm font-semibold">{t('common:routeLoading.failed')}</h1>
        </div>
        <p className="break-words text-sm text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <div className="flex gap-3 text-sm">
          <button
            type="button"
            className="font-medium text-acc-text hover:underline"
            onClick={() => void router.invalidate()}
          >
            {t('common:routeLoading.retry')}
          </button>
          <button
            type="button"
            className="font-medium text-acc-text hover:underline"
            onClick={() => window.location.reload()}
          >
            {t('common:routeLoading.reload')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * An address with no page (an old link, a typed path): say so in the app's own
 * frame, with a way back, instead of a bare "Not Found" (X-002).
 */
export function RouteNotFound() {
  const { t } = useTranslation()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const inSettings = pathname.startsWith('/settings')
  return (
    <div className="flex h-full w-full items-start justify-center p-6">
      <div role="alert" data-testid="route-not-found" className="w-full max-w-lg space-y-3 pt-10 text-center">
        <SearchX className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold text-foreground">{t('common:routeNotFound.title')}</h1>
        <p className="break-words text-sm text-muted-foreground">
          {t('common:routeNotFound.body', { path: pathname })}
        </p>
        <div className="flex justify-center gap-2 pt-1">
          {inSettings && (
            <Button size="sm" onClick={() => void router.navigate({ to: '/settings/general' })}>
              {t('common:routeNotFound.settings')}
            </Button>
          )}
          <Button
            size="sm"
            variant={inSettings ? 'outline' : 'default'}
            onClick={() => void router.navigate({ to: '/' })}
          >
            {t('common:routeNotFound.home')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Router-wide defaults: show the pending page almost at once, and errors in place. */
export const routerDefaults = {
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteLoadError,
  defaultNotFoundComponent: RouteNotFound,
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
}

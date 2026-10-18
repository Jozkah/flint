import type { ComponentType, ReactElement } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isServedByFlint } from '@/lib/platform/utils'
import { DesktopOnlyPage } from '@/containers/DesktopOnlyPage'

/**
 * A route component that renders `Page` in the desktop app and the
 * desktop-only notice in the browser `flint serve` serves, for pages whose
 * every control drives this machine (opened by URL or a stale link, the page
 * must say so rather than fail with "Unknown command").
 */
export function desktopOnlyRoute(Page: ComponentType, titleKey: string): () => ReactElement {
  function Guarded() {
    const { t } = useTranslation()
    return isServedByFlint() ? <DesktopOnlyPage title={t(titleKey)} /> : <Page />
  }
  Guarded.displayName = `DesktopOnly(${Page.displayName ?? Page.name ?? 'Page'})`
  return Guarded
}

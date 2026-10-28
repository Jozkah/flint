import { useCallback, useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { webFetch } from '@janhq/tauri-plugin-websearch-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ServiceHub } from '@/services'
import { useServiceHub } from '@/hooks/useServiceHub'
import { buildSearchChain, useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, type VectorDBExtension } from '@janhq/core'
import {
  addWebPageToProject,
  refreshWebPageSource,
  UrlSourceError,
  validateWebPageUrl,
  type AddedWebPage,
  type UrlSourceDeps,
} from '@/lib/projectUrlSources'
import { useProjectUrlSources, type UrlSource } from '@/stores/project-url-sources-store'

/** The real fetch / save / ingest / delete path for a project's page sources. */
export function urlSourceDeps(serviceHub: ServiceHub): UrlSourceDeps {
  return {
    fetchPage: (url) => {
      const config = useWebSearchConfig.getState()
      const { apiKeys, endpoints, searchProvider } = config
      return webFetch(
        url,
        apiKeys[searchProvider] || undefined,
        searchProvider,
        endpoints[searchProvider] || undefined,
        buildSearchChain(config)
      )
    },
    saveFile: (name, text) =>
      serviceHub
        .uploads()
        .saveDroppedFile(new File([text], name, { type: 'text/markdown' })),
    ingest: (pid, att) => serviceHub.uploads().ingestFileAttachmentForProject(pid, att),
    deleteFile: async (pid, fileId) => {
      const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
        ExtensionTypeEnum.VectorDB
      )
      await ext?.deleteFileForProject?.(pid, fileId)
    },
  }
}

type T = ReturnType<typeof useTranslation>['t']

/** The sentence a failed add or refresh shows. */
export function urlSourceErrorText(t: T, e: unknown): string {
  const code = e instanceof UrlSourceError ? e.code : 'failed'
  const message = e instanceof Error ? e.message : String(e)
  return t(`common:projects.webPage.errors.${code}`, { message })
}

/** Toast for a finished add or refresh. */
export function announceWebPage(t: T, added: AddedWebPage, refreshed = false) {
  toast.success(
    t(refreshed ? 'common:projects.webPage.refreshed' : 'common:projects.webPage.added', {
      name: added.name,
    }),
    added.truncated
      ? { description: t('common:projects.webPage.truncated') }
      : undefined
  )
}

/**
 * Re-fetch a page source and re-index it, replacing the old file's chunks.
 * Returns the refresh action and the id of the file being refreshed.
 */
export function useRefreshWebPage(projectId: string, onDone: () => void) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const refresh = useCallback(
    async (fileId: string, source: UrlSource) => {
      setRefreshing(fileId)
      try {
        const added = await refreshWebPageSource(
          projectId,
          fileId,
          source,
          urlSourceDeps(serviceHub)
        )
        const store = useProjectUrlSources.getState()
        if (added.source.path !== source.path) store.remove(projectId, source.path)
        store.put(projectId, added.source)
        announceWebPage(t, added, true)
        onDone()
      } catch (err) {
        toast.error(t('common:projects.webPage.refreshFailed'), {
          description: urlSourceErrorText(t, err),
        })
      } finally {
        setRefreshing(null)
      }
    },
    [projectId, serviceHub, t, onDone]
  )
  return { refresh, refreshing }
}

type Props = {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}

export function AddWebPageDialog({ projectId, open, onOpenChange, onAdded }: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const putSource = useProjectUrlSources((s) => s.put)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (next: boolean) => {
    if (busy) return
    if (!next) {
      setValue('')
      setError(null)
    }
    onOpenChange(next)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      validateWebPageUrl(value)
    } catch (err) {
      setError(urlSourceErrorText(t, err))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const added = await addWebPageToProject(projectId, value, urlSourceDeps(serviceHub))
      putSource(projectId, added.source)
      announceWebPage(t, added)
      setValue('')
      onOpenChange(false)
      onAdded()
    } catch (err) {
      setError(urlSourceErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('common:projects.webPage.title')}</DialogTitle>
            <DialogDescription>{t('common:projects.webPage.description')}</DialogDescription>
          </DialogHeader>
          <Input
            type="url"
            autoFocus
            inputMode="url"
            placeholder="https://"
            aria-label={t('common:projects.webPage.urlLabel')}
            aria-invalid={error ? true : undefined}
            value={value}
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Globe className="size-4" />
              )}
              {t('common:projects.webPage.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { listRunModels, type RunModel } from '@/lib/remoteRunner'
import { runnerInfo, sendRemoteTurn, startRemoteSession } from '@/lib/remoteCowork'
import { ResponsiveSheet, ServerFolderBrowser } from '@/containers/ServerFolderChooser'
import { displayPath } from '@/lib/serverFolderPicker'

/**
 * Start a session on the server from Cowork: a folder the server allows, the
 * model to run it with and the first message. The model chosen here becomes
 * the browser's selection too, the one server sessions default to.
 */
export function ServerSessionDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After the session is created and opened (the phone drawer closes). */
  onStarted?: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [folder, setFolder] = useState<string | null>(null)
  const [models, setModels] = useState<RunModel[]>([])
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setMissing(null)
    void runnerInfo(undefined, 0)
      .then((info) => {
        if (!live) return
        if (info.agent && !info.runsSessions) {
          setMissing(info.missing.join('; ') || t('integrations:serverSession.notReady'))
        }
      })
      .catch(() => {})
    listRunModels()
      .then((out) => {
        if (!live) return
        setModels(out.models)
        const selected = useModelProvider.getState().selectedModel?.id
        const pick =
          (selected && out.models.find((m) => m.id === selected)?.id) ??
          out.default ??
          out.models[0]?.id ??
          ''
        setModel(pick)
      })
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [open, t])

  const onFolder = useCallback((path: string | null) => setFolder(path), [])

  const start = async () => {
    if (!folder || !prompt.trim()) return
    setBusy(true)
    try {
      const chosen = models.find((m) => m.id === model)
      if (chosen) {
        const store = useModelProvider.getState()
        if (store.getProviderByName(chosen.provider)) {
          store.selectModelProvider(chosen.provider, chosen.id)
        }
      }
      const text = prompt.trim()
      const id = await startRemoteSession({
        folder,
        ...(model ? { model } : {}),
        title: text.slice(0, 60),
      })
      onOpenChange(false)
      setPrompt('')
      void navigate({ to: route.cowork })
      onStarted?.()
      await sendRemoteTurn(id, text)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('integrations:serverSession.title')}
      description={t('integrations:serverSession.description')}
      testId="server-session-dialog"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            disabled={!folder || !prompt.trim() || busy || !!missing}
            onClick={() => void start()}
            data-testid="server-session-start"
          >
            {busy ? t('integrations:serverSession.starting') : t('integrations:serverSession.start')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3 pb-2">
        {missing && (
          <p className="rounded border border-dashed p-2 text-xs" role="alert">
            {missing}
          </p>
        )}
        <ServerFolderBrowser onChange={onFolder} className="h-56" />
        <p className="truncate text-xs" data-testid="server-session-folder">
          {t('integrations:serverSession.folder', {
            path: folder ? displayPath(folder) : t('integrations:serverSession.noFolder'),
          })}
        </p>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('integrations:remoteRunner.model')}</span>
          <select
            className="rounded border bg-transparent px-2 py-1.5 text-sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            data-testid="server-session-model"
          >
            {models.length === 0 && (
              <option value="">{t('integrations:remoteRunner.serverDefault')}</option>
            )}
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={m.id}>
                {m.label || `${m.provider} / ${m.id}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span>{t('integrations:serverSession.prompt')}</span>
          <textarea
            className="min-h-20 rounded border bg-transparent px-2 py-1.5 text-sm"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
            }}
            placeholder={t('integrations:serverSession.promptPlaceholder')}
            data-testid="server-session-prompt"
          />
        </label>
      </div>
    </ResponsiveSheet>
  )
}

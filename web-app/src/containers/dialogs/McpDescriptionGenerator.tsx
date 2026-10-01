import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Segmented } from '@/components/ui/segmented'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { MCPServers } from '@/hooks/useMCPServers'
import {
  cacheServerTools,
  cachedServerTools,
  descriptionsToSave,
  generateServerDescription,
  hasDescription,
  selectServersForGeneration,
  type DescriptionScope,
  type ReviewItem,
} from '@/lib/mcpDescriptionGen'

type Progress =
  | { status: 'queued' }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  servers: MCPServers
  connectedServers: string[]
  /** Describe only this server (the per-server Generate button). */
  onlyServer?: string
  onSave: (descriptions: Record<string, string>) => void
}

/**
 * Asks a chosen model for "About this server" texts, then lets the user
 * edit, accept or reject each one. Nothing is written until Save, and only
 * accepted items whose stored description has not changed meanwhile.
 */
export function McpDescriptionGenerator({
  open,
  onOpenChange,
  servers,
  connectedServers,
  onlyServer,
  onSave,
}: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const providers = useModelProvider((s) => s.providers)
  const chatProvider = useModelProvider((s) => s.selectedProvider)
  const chatModel = useModelProvider((s) => s.selectedModel)
  const [providerName, setProviderName] = useState('')
  const [modelId, setModelId] = useState('')
  const [scope, setScope] = useState<DescriptionScope>('empty')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [items, setItems] = useState<ReviewItem[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setRunning(false)
      setProgress({})
      setItems([])
      return
    }
    if (!modelId && chatProvider && chatModel) {
      setProviderName(chatProvider)
      setModelId(chatModel.id)
    }
    // Defaults are taken once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const targets = onlyServer
    ? servers[onlyServer]
      ? [onlyServer]
      : []
    : selectServersForGeneration(servers, scope)

  const loadTools = async (server: string) => {
    if (connectedServers.includes(server)) {
      try {
        const tools = (
          await serviceHub.mcp().getToolsForServers([server], { start: true })
        ).filter((tool) => !tool.server || tool.server === server)
        cacheServerTools(server, tools)
        return tools
      } catch {
        // Fall through to the cache.
      }
    }
    return cachedServerTools(server)
  }

  const run = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setItems([])
    setProgress(
      Object.fromEntries(targets.map((s) => [s, { status: 'queued' } as Progress]))
    )
    const set = (server: string, p: Progress) =>
      setProgress((prev) => ({ ...prev, [server]: p }))

    for (const server of targets) {
      if (controller.signal.aborted) break
      set(server, { status: 'running' })
      const tools = await loadTools(server)
      if (!tools) {
        set(server, {
          status: 'skipped',
          reason: t('mcp-servers:describe.skippedNoTools'),
        })
        continue
      }
      try {
        const text = await generateServerDescription(
          providerName,
          modelId,
          server,
          tools,
          controller.signal
        )
        if (controller.signal.aborted) break
        set(server, { status: 'done' })
        setItems((prev) => [
          ...prev,
          {
            server,
            before: servers[server]?.description ?? '',
            text,
            // A server with no description has nothing to lose; one the user
            // wrote waits for an explicit accept.
            decision: hasDescription(servers[server]) ? 'pending' : 'accepted',
          },
        ])
      } catch (error) {
        if (controller.signal.aborted) break
        set(server, {
          status: 'failed',
          reason: (error as Error)?.message || String(error),
        })
      }
    }
    if (controller.signal.aborted) {
      setProgress((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([s, p]) => [
            s,
            p.status === 'queued' || p.status === 'running'
              ? ({ status: 'skipped', reason: t('mcp-servers:describe.cancelled') } as Progress)
              : p,
          ])
        )
      )
    }
    abortRef.current = null
    setRunning(false)
  }

  const cancel = () => abortRef.current?.abort()

  const update = (server: string, patch: Partial<ReviewItem>) =>
    setItems((prev) =>
      prev.map((item) => (item.server === server ? { ...item, ...patch } : item))
    )

  const toSave = descriptionsToSave(items, servers)
  const saveCount = Object.keys(toSave).length

  const statusLabel = (p: Progress) => {
    switch (p.status) {
      case 'queued':
        return t('mcp-servers:describe.status.queued')
      case 'running':
        return t('mcp-servers:describe.status.running')
      case 'done':
        return t('mcp-servers:describe.status.done')
      case 'skipped':
        return t('mcp-servers:describe.status.skipped', { reason: p.reason })
      case 'failed':
        return t('mcp-servers:describe.status.failed', { reason: p.reason })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {onlyServer
              ? t('mcp-servers:describe.titleOne', { serverName: onlyServer })
              : t('mcp-servers:describe.title')}
          </DialogTitle>
          <DialogDescription>{t('mcp-servers:describe.intro')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-fg-2">{t('mcp-servers:describe.model')}</span>
            <McpRouterModelPicker
              ariaLabel={t('mcp-servers:describe.model')}
              providers={providers}
              selectedProvider={providerName}
              selectedModelId={modelId}
              disabled={running}
              onSelect={(p, m) => {
                setProviderName(p)
                setModelId(m)
              }}
              placeholder={t('mcp-servers:runtimeSettings.selectRouterModelPlaceholder')}
              searchPlaceholder={t('mcp-servers:runtimeSettings.routerModelSearchPlaceholder')}
              emptyListMessage={t('mcp-servers:runtimeSettings.routerModelEmptyList')}
              formatEmptySearch={(q) =>
                t('mcp-servers:runtimeSettings.routerModelEmptySearch', { query: q })
              }
            />
          </div>
          {!onlyServer && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-fg-2">{t('mcp-servers:describe.scope')}</span>
              <Segmented<DescriptionScope>
                size="sm"
                aria-label={t('mcp-servers:describe.scope')}
                value={scope}
                onValueChange={(v) => !running && setScope(v)}
                options={[
                  { value: 'empty', label: t('mcp-servers:describe.scopeEmpty') },
                  { value: 'all', label: t('mcp-servers:describe.scopeAll') },
                ]}
              />
            </div>
          )}
          <p className="m-0 text-xs text-muted-foreground">
            {t('mcp-servers:describe.targetCount', { count: targets.length })}
          </p>

          {Object.keys(progress).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" aria-live="polite">
              {Object.entries(progress).map(([server, p]) => (
                <li key={server} className="flex justify-between gap-2">
                  <span className="font-medium">{server}</span>
                  <span
                    className={
                      p.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                    }
                  >
                    {statusLabel(p)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="m-0 text-xs font-semibold">
                {t('mcp-servers:describe.review')}
              </h3>
              {items.map((item) => (
                <div
                  key={item.server}
                  className="flex flex-col gap-1.5 rounded-lg bg-muted p-2.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{item.server}</span>
                    <span className="text-muted-foreground">
                      {item.decision === 'accepted'
                        ? t('mcp-servers:describe.accepted')
                        : item.decision === 'rejected'
                          ? t('mcp-servers:describe.rejected')
                          : t('mcp-servers:describe.pending')}
                    </span>
                  </div>
                  {item.before.trim() && (
                    <p className="m-0 text-xs text-muted-foreground">
                      {t('mcp-servers:describe.current', { text: item.before })}
                    </p>
                  )}
                  <Textarea
                    aria-label={t('mcp-servers:describe.editLabel', {
                      serverName: item.server,
                    })}
                    value={item.text}
                    onChange={(e) => update(item.server, { text: e.target.value })}
                    className="min-h-16 text-xs"
                  />
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => update(item.server, { decision: 'rejected' })}
                    >
                      {t('mcp-servers:describe.reject')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => update(item.server, { decision: 'accepted' })}
                    >
                      {t('mcp-servers:describe.accept')}
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          {running ? (
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t('mcp-servers:describe.cancel')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common:close')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={running || !modelId || targets.length === 0}
            onClick={() => void run()}
          >
            {t('mcp-servers:describe.generate')}
          </Button>
          <Button
            size="sm"
            disabled={running || saveCount === 0}
            onClick={() => {
              onSave(toSave)
              onOpenChange(false)
            }}
          >
            {t('mcp-servers:describe.save', { count: saveCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

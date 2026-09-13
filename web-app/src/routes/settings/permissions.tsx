import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import {
  permissionAuditRecent,
  type PermissionAuditRecord,
} from '@/lib/permissionAudit'

// `as any` matches every other settings route: the typed route tree is
// generated during the build, after this file is typechecked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.permissions as any)({
  component: PermissionsSettings,
})

/** How many recorded decisions the page shows. */
const HISTORY_LIMIT = 50

type ServerRow = {
  name: string
  /** The backend gate trusts it: its tools run without a ticket. */
  inBackend: boolean
  /** The renderer store trusts it: its tools run without a prompt. */
  inApp: boolean
}

function PermissionsSettings() {
  const { t } = useTranslation()
  const approvedTools = useToolApproval((s) => s.approvedTools)
  const approvedToolsGlobal = useToolApproval((s) => s.approvedToolsGlobal)
  const approvedServers = useToolApproval((s) => s.approvedServers)
  const allowAll = useToolApproval((s) => s.allowAllMCPPermissions)
  const revokeToolForThread = useToolApproval((s) => s.revokeToolForThread)
  const revokeToolEverywhere = useToolApproval((s) => s.revokeToolEverywhere)
  const revokeServerTrust = useToolApproval((s) => s.revokeServerTrust)
  const revokeAllowAll = useToolApproval((s) => s.revokeAllowAllMCPPermissions)
  const threads = useThreads((s) => s.threads)
  const coworkSessions = useCoworkSessions((s) => s.sessions)

  /** `null` until the backend answers; kept on failure so nothing is hidden. */
  const [backendServers, setBackendServers] = useState<string[] | null>(null)
  const [serversError, setServersError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [busyServer, setBusyServer] = useState<string | null>(null)

  const [history, setHistory] = useState<PermissionAuditRecord[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getServiceHub()
      .mcp()
      .trustedServers()
      .then((servers) => {
        if (!cancelled) setBackendServers(servers ?? [])
      })
      .catch((error) => {
        if (!cancelled) setServersError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const folder = await getServiceHub().app().getJanDataFolder()
        if (!folder) throw new Error('no data folder')
        const records = await permissionAuditRecent(folder, HISTORY_LIMIT)
        if (!cancelled) setHistory(records)
      } catch (error) {
        if (!cancelled) setHistoryError(errorText(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const conversationTitle = useCallback(
    (id: string) =>
      threads[id]?.title ||
      coworkSessions.find((session) => session.id === id)?.title ||
      t('permissions:settings.untitledConversation', { id: id.slice(0, 8) }),
    [threads, coworkSessions, t]
  )

  const conversations = useMemo(
    () =>
      Object.entries(approvedTools).filter(([, tools]) => tools.length > 0),
    [approvedTools]
  )

  // The backend and the renderer store each keep a list; showing only one
  // would hide a server the other still trusts.
  const servers: ServerRow[] = useMemo(() => {
    const names = [...(backendServers ?? []), ...approvedServers].filter(
      (name, index, all) => all.indexOf(name) === index
    )
    return names.map((name) => ({
      name,
      inBackend: backendServers?.includes(name) ?? false,
      inApp: approvedServers.includes(name),
    }))
  }, [backendServers, approvedServers])

  const onRevokeServer = useCallback(
    async (name: string) => {
      setBusyServer(name)
      setServerErrors((errors) => {
        const next = { ...errors }
        delete next[name]
        return next
      })
      try {
        await revokeServerTrust(name)
        setBackendServers((list) => list?.filter((s) => s !== name) ?? list)
        toast.success(t('permissions:settings.revoked'))
      } catch (error) {
        // Still trusted where it counts, so it stays listed, with the reason.
        const message = `${t('permissions:settings.revokeFailed', {
          server: name,
        })} ${errorText(error)}`
        setServerErrors((errors) => ({ ...errors, [name]: message }))
        toast.error(message)
      } finally {
        setBusyServer(null)
      }
    },
    [revokeServerTrust, t]
  )

  const hasGlobal =
    allowAll || approvedToolsGlobal.length > 0 || servers.length > 0

  return (
    <div className="flex flex-col h-full">
      <HeaderPage>
        <h1 className="font-medium">{t('common:settings')}</h1>
      </HeaderPage>
      <div className="flex h-full w-full">
        <SettingsMenu />
        <div className="p-4 w-full h-[calc(100%-32px)] overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card title={t('permissions:settings.title')}>
              <CardItem
                title={t('permissions:settings.intro')}
                description={t('permissions:settings.revokeEffect')}
              />
            </Card>

            <Card title={t('permissions:settings.conversations')}>
              <CardItem
                anchor="settings-permissions-conversations"
                title={t('permissions:settings.conversations')}
                description={t('permissions:settings.conversationsDesc')}
              />
              {conversations.length === 0 ? (
                <p className="py-3 text-sm">
                  {t('permissions:settings.noConversationGrants')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/40">
                  {conversations.map(([threadId, tools]) => (
                    <li key={threadId} className="py-2">
                      <p className="text-sm font-medium text-foreground">
                        {conversationTitle(threadId)}
                      </p>
                      <ul className="mt-1 flex flex-col gap-1">
                        {tools.map((tool) => (
                          <li
                            key={tool}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="font-mono text-xs">
                              {t('permissions:settings.toolLabel', { tool })}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={t('permissions:settings.revokeLabel', {
                                name: `${tool} (${conversationTitle(threadId)})`,
                              })}
                              onClick={() => revokeToolForThread(threadId, tool)}
                            >
                              {t('permissions:settings.revoke')}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={t('permissions:settings.everywhere')}>
              <CardItem
                anchor="settings-permissions-everywhere"
                title={t('permissions:settings.everywhere')}
                description={t('permissions:settings.everywhereDesc')}
              />
              {serversError && (
                <p role="alert" className="py-2 text-sm text-destructive">
                  {t('permissions:settings.loadServersFailed', {
                    error: serversError,
                  })}
                </p>
              )}
              {!hasGlobal ? (
                <p className="py-3 text-sm">
                  {t('permissions:settings.noGlobalGrants')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/40">
                  {allowAll && (
                    <li className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {t('permissions:settings.allowAll')}
                        </p>
                        <p className="text-xs">
                          {t('permissions:settings.allowAllDesc')}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={revokeAllowAll}>
                        {t('permissions:settings.revokeAll')}
                      </Button>
                    </li>
                  )}
                  {servers.map((server) => (
                    <li key={`server-${server.name}`} className="py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-mono text-xs text-foreground">
                            {t('permissions:settings.serverLabel', {
                              server: server.name,
                            })}
                          </p>
                          {server.inApp && !server.inBackend && backendServers && (
                            <p className="text-xs">
                              {t('permissions:settings.serverAppOnly')}
                            </p>
                          )}
                          {server.inBackend && !server.inApp && (
                            <p className="text-xs">
                              {t('permissions:settings.serverBackendOnly')}
                            </p>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyServer === server.name}
                          aria-busy={busyServer === server.name}
                          aria-label={t('permissions:settings.revokeLabel', {
                            name: server.name,
                          })}
                          onClick={() => void onRevokeServer(server.name)}
                        >
                          {t('permissions:settings.revoke')}
                        </Button>
                      </div>
                      {serverErrors[server.name] && (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          {serverErrors[server.name]}
                        </p>
                      )}
                    </li>
                  ))}
                  {approvedToolsGlobal.map((tool) => (
                    <li
                      key={`tool-${tool}`}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <span className="font-mono text-xs">
                        {t('permissions:settings.toolLabel', { tool })}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('permissions:settings.revokeLabel', {
                          name: tool,
                        })}
                        onClick={() => revokeToolEverywhere(tool)}
                      >
                        {t('permissions:settings.revoke')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={t('permissions:settings.history')}>
              <CardItem
                anchor="settings-permissions-history"
                title={t('permissions:settings.history')}
                description={t('permissions:settings.historyDesc')}
              />
              {historyError ? (
                <p className="py-3 text-sm">
                  {t('permissions:settings.historyUnavailable', {
                    error: historyError,
                  })}
                </p>
              ) : history && history.length === 0 ? (
                <p className="py-3 text-sm">
                  {t('permissions:settings.historyEmpty')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/40">
                  {(history ?? []).map((record, index) => (
                    <li key={`${record.at}-${record.call}-${index}`} className="py-2">
                      <p className="text-sm text-foreground">
                        {t('permissions:settings.historyRow', {
                          decision: record.decision,
                          tool: record.tool,
                          at: record.at,
                        })}
                      </p>
                      {record.resource && (
                        <p className="break-all font-mono text-xs">
                          {record.resource}
                        </p>
                      )}
                      {record.reason && (
                        <p className="text-xs">{record.reason}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

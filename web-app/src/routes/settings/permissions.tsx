import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { route } from '@/constants/routes'
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
import type { MCPTrustReport } from '@/services/mcp/types'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { StatusChip, type StatusTone } from '@/containers/StatusChip'

// `as any` matches every other settings route: the typed route tree is
// generated during the build, after this file is typechecked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.permissions as any)({
  component: PermissionsSettings,
})

/** How many recorded decisions the page shows. */
const HISTORY_LIMIT = 50

/** Whether a standing server grant still describes the configured server. */
type GrantState = 'current' | 'changed' | 'missing' | 'unknown'

type ServerRow = {
  name: string
  /** The backend gate trusts it: its tools run without a ticket. */
  inBackend: boolean
  /** The renderer store trusts it: its tools run without a prompt. */
  inApp: boolean
  state: GrantState
}

type RenewalRow = {
  name: string
  reason: 'legacy' | 'changed'
}

/** One grant: what it is, what it means, and the control that removes it. */
const GRANT_ROW =
  'flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
const EMPTY =
  'rounded-md border border-dashed border-line-strong px-3 py-4 text-sm text-muted-foreground'
const REVOKE = 'self-start shrink-0 pointer-coarse:h-11 sm:self-auto'

/** The tone a recorded decision is drawn in; the word itself is shown as is. */
function decisionTone(decision: string): StatusTone {
  const value = decision.toLowerCase()
  if (value.startsWith('allow') || value === 'approved') return 'success'
  if (value.startsWith('deny') || value.startsWith('refuse')) {
    return 'destructive'
  }
  return 'neutral'
}

function formatWhen(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

function PermissionsSettings() {
  const { t } = useTranslation()
  const approvedTools = useToolApproval((s) => s.approvedTools)
  const approvedMcpTools = useToolApproval((s) => s.approvedMcpTools)
  const approvedToolsGlobal = useToolApproval((s) => s.approvedToolsGlobal)
  const approvedServers = useToolApproval((s) => s.approvedServers)
  const invalidatedServers = useToolApproval((s) => s.invalidatedServers)
  const allowAll = useToolApproval((s) => s.allowAllMCPPermissions)
  const revokeToolForThread = useToolApproval((s) => s.revokeToolForThread)
  const revokeMcpToolForThread = useToolApproval((s) => s.revokeMcpToolForThread)
  const revokeToolEverywhere = useToolApproval((s) => s.revokeToolEverywhere)
  const revokeServerTrust = useToolApproval((s) => s.revokeServerTrust)
  const revokeAllowAll = useToolApproval((s) => s.revokeAllowAllMCPPermissions)
  const threads = useThreads((s) => s.threads)
  const coworkSessions = useCoworkSessions((s) => s.sessions)

  /** `null` until the backend answers; kept on failure so nothing is hidden. */
  const [report, setReport] = useState<MCPTrustReport | null>(null)
  /** Current fingerprint per configured server; `null` until known. */
  const [fingerprints, setFingerprints] = useState<Record<
    string,
    string
  > | null>(null)
  const [serversError, setServersError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [busyServer, setBusyServer] = useState<string | null>(null)

  const [history, setHistory] = useState<PermissionAuditRecord[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const mcp = getServiceHub().mcp()
    mcp
      .trustReport()
      .then((next) => {
        if (!cancelled) {
          setReport({
            trusted: next?.trusted ?? [],
            invalidated: next?.invalidated ?? [],
          })
        }
      })
      .catch((error) => {
        if (!cancelled) setServersError(errorText(error))
      })
    Promise.resolve()
      .then(() => mcp.serverFingerprints())
      .then((next) => {
        if (!cancelled) setFingerprints(next ?? {})
      })
      .catch(() => {
        // Without fingerprints the page cannot say whether an app-side grant
        // still matches; it says "unknown" rather than guessing.
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

  const conversations = useMemo(() => {
    const ids = [
      ...Object.keys(approvedTools),
      ...Object.keys(approvedMcpTools ?? {}),
    ].filter((id, index, all) => all.indexOf(id) === index)
    return ids
      .map((id) => ({
        id,
        tools: approvedTools[id] ?? [],
        mcpTools: approvedMcpTools?.[id] ?? [],
      }))
      .filter((row) => row.tools.length > 0 || row.mcpTools.length > 0)
  }, [approvedTools, approvedMcpTools])

  // The backend and the renderer store each keep a list; showing only one
  // would hide a server the other still trusts.
  const servers: ServerRow[] = useMemo(() => {
    const backend = report?.trusted ?? []
    const names = [
      ...backend.map((entry) => entry.name),
      ...approvedServers.map((grant) => grant.name),
    ].filter((name, index, all) => all.indexOf(name) === index)
    return names.map((name) => {
      const entry = backend.find((one) => one.name === name)
      const grant = approvedServers.find((one) => one.name === name)
      let state: GrantState = 'current'
      if (entry) {
        if (entry.currentFingerprint === null) state = 'missing'
        else if (entry.currentFingerprint !== entry.fingerprint) state = 'changed'
      }
      if (state === 'current' && grant) {
        if (!fingerprints) state = entry ? state : 'unknown'
        else if (!(name in fingerprints)) state = 'missing'
        else if (fingerprints[name] !== grant.fingerprint) state = 'changed'
      }
      return { name, inBackend: !!entry, inApp: !!grant, state }
    })
  }, [report, approvedServers, fingerprints])

  // Approvals that stopped applying, from either record, once per name.
  const renewals: RenewalRow[] = useMemo(() => {
    const rows: RenewalRow[] = []
    const add = (name: string, reason: string) => {
      if (rows.some((row) => row.name === name)) return
      rows.push({
        name,
        reason: reason === 'configuration-changed' ? 'changed' : 'legacy',
      })
    }
    for (const entry of report?.invalidated ?? []) add(entry.name, entry.reason)
    for (const entry of invalidatedServers ?? []) add(entry.name, entry.reason)
    return rows
  }, [report, invalidatedServers])

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
        setReport((current) =>
          current
            ? {
                trusted: current.trusted.filter((entry) => entry.name !== name),
                invalidated: current.invalidated.filter(
                  (entry) => entry.name !== name
                ),
              }
            : current
        )
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

  const errorId = (name: string) =>
    `permissions-server-error-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  const pendingRenewals = renewals.filter(
    (row) =>
      !servers.some(
        (server) => server.name === row.name && server.state === 'current'
      )
  )

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader />
      <div className="flex h-[calc(100%-var(--ctx-h))] min-h-0 w-full">
        <div className="w-full min-w-0 overflow-x-hidden overflow-y-auto px-3 py-4 md:px-6 md:py-6">
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
            <Card title={t('permissions:settings.title')}>
              <CardItem
                title={t('permissions:settings.intro')}
                description={t('permissions:settings.revokeEffect')}
              />
            </Card>

            {/* 1. Allowed in one conversation */}
            <Card title={t('permissions:settings.conversations')}>
              <CardItem
                anchor="settings-permissions-conversations"
                title={t('permissions:settings.conversations')}
                description={t('permissions:settings.conversationsDesc')}
              />
              {conversations.length === 0 ? (
                <p className={EMPTY}>
                  {t('permissions:settings.noConversationGrants')}
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {conversations.map(({ id: threadId, tools, mcpTools }) => (
                    <li
                      key={threadId}
                      className="rounded-md border border-border bg-sunken/40 px-3 pt-2"
                    >
                      <p className="truncate font-medium text-foreground">
                        {conversationTitle(threadId)}
                      </p>
                      <ul className="flex flex-col divide-y divide-border">
                        {tools.map((tool) => (
                          <li key={tool} className={GRANT_ROW}>
                            <span className="min-w-0 break-all font-mono text-xs text-ink-2">
                              {t('permissions:settings.toolLabel', { tool })}
                            </span>
                            <Button
                              variant="destructive"
                              size="sm"
                              className={REVOKE}
                              aria-label={t('permissions:settings.revokeLabel', {
                                name: `${tool} (${conversationTitle(threadId)})`,
                              })}
                              onClick={() => revokeToolForThread(threadId, tool)}
                            >
                              {t('permissions:settings.revoke')}
                            </Button>
                          </li>
                        ))}
                        {mcpTools.map((grant) => (
                          <li
                            key={`${grant.server}::${grant.tool}`}
                            className={GRANT_ROW}
                          >
                            <span className="min-w-0 break-all font-mono text-xs text-ink-2">
                              {t('permissions:settings.mcpToolLabel', {
                                server: grant.server,
                                tool: grant.tool,
                              })}
                            </span>
                            <Button
                              variant="destructive"
                              size="sm"
                              className={REVOKE}
                              aria-label={t('permissions:settings.revokeLabel', {
                                name: `${grant.server} ${grant.tool} (${conversationTitle(threadId)})`,
                              })}
                              onClick={() =>
                                revokeMcpToolForThread(
                                  threadId,
                                  grant.server,
                                  grant.tool
                                )
                              }
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

            {/* 2. Tools allowed in every conversation */}
            <Card title={t('permissions:settings.toolsEverywhere')}>
              <CardItem
                anchor="settings-permissions-everywhere"
                title={t('permissions:settings.everywhere')}
                description={t('permissions:settings.toolsEverywhereDesc')}
              />
              {approvedToolsGlobal.length === 0 ? (
                <p className={EMPTY}>
                  {t('permissions:settings.noToolsEverywhere')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {approvedToolsGlobal.map((tool) => (
                    <li key={`tool-${tool}`} className={GRANT_ROW}>
                      <span className="min-w-0 break-all font-mono text-xs text-ink-2">
                        {t('permissions:settings.toolLabel', { tool })}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        className={REVOKE}
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

            {/* 3. Trusted MCP servers */}
            <Card title={t('permissions:settings.trustedServers')}>
              <CardItem
                title={t('permissions:settings.trustedServers')}
                description={t('permissions:settings.trustedServersDesc')}
              />
              {serversError && (
                <p
                  role="alert"
                  className="mb-3 rounded-md border border-destructive/40 bg-destructive-tint px-3 py-2 text-sm text-destructive"
                >
                  {t('permissions:settings.loadServersFailed', {
                    error: serversError,
                  })}
                </p>
              )}
              {servers.length === 0 ? (
                <p className={EMPTY}>
                  {t('permissions:settings.noTrustedServers')}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {servers.map((server) => (
                    <li key={`server-${server.name}`} className="py-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0 space-y-1">
                          <p className="break-all font-mono text-xs text-foreground">
                            {t('permissions:settings.serverLabel', {
                              server: server.name,
                            })}
                          </p>
                          {server.state === 'changed' && (
                            <p className="text-xs text-warning">
                              {t('permissions:settings.serverChanged')}
                            </p>
                          )}
                          {server.state === 'missing' && (
                            <p className="text-xs text-muted-foreground">
                              {t('permissions:settings.serverMissing')}
                            </p>
                          )}
                          {server.inApp && !server.inBackend && report && (
                            <p className="text-xs text-muted-foreground">
                              {t('permissions:settings.serverAppOnly')}
                            </p>
                          )}
                          {server.inBackend && !server.inApp && (
                            <p className="text-xs text-muted-foreground">
                              {t('permissions:settings.serverBackendOnly')}
                            </p>
                          )}
                        </div>
                        <Button
                          variant="destructive"
                          size="sm"
                          className={REVOKE}
                          disabled={busyServer === server.name}
                          aria-busy={busyServer === server.name}
                          aria-describedby={
                            serverErrors[server.name]
                              ? errorId(server.name)
                              : undefined
                          }
                          aria-label={t('permissions:settings.revokeLabel', {
                            name: server.name,
                          })}
                          onClick={() => void onRevokeServer(server.name)}
                        >
                          {t('permissions:settings.revoke')}
                        </Button>
                      </div>
                      {serverErrors[server.name] && (
                        <p
                          id={errorId(server.name)}
                          role="alert"
                          className="mt-2 rounded-md bg-destructive-tint px-3 py-2 text-xs text-destructive"
                        >
                          {serverErrors[server.name]}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* 4. Every MCP tool, without asking */}
            <Card title={t('permissions:settings.allowAllGroup')}>
              {allowAll ? (
                <div className={GRANT_ROW}>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-foreground">
                        {t('permissions:settings.allowAll')}
                      </p>
                      <StatusChip tone="warning">
                        {t('permissions:settings.allowAllOn')}
                      </StatusChip>
                    </div>
                    <p className="text-muted-foreground">
                      {t('permissions:settings.allowAllDesc')}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className={REVOKE}
                    onClick={revokeAllowAll}
                  >
                    {t('permissions:settings.revokeAll')}
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  {t('permissions:settings.allowAllOff')}
                </p>
              )}
            </Card>

            {pendingRenewals.length > 0 && (
              <Card title={t('permissions:settings.needsRenewal')}>
                <CardItem
                  anchor="settings-permissions-renewal"
                  title={t('permissions:settings.needsRenewal')}
                  description={t('permissions:settings.needsRenewalDesc')}
                />
                <ul className="flex flex-col divide-y divide-border">
                  {pendingRenewals.map((row) => (
                    <li key={`renewal-${row.name}`} className="py-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0 space-y-1">
                          <p className="break-all font-mono text-xs text-foreground">
                            {t('permissions:settings.needsRenewalLabel', {
                              server: row.name,
                            })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {row.reason === 'changed'
                              ? t('permissions:settings.reasonChanged')
                              : t('permissions:settings.reasonLegacy')}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className={REVOKE}
                          disabled={busyServer === row.name}
                          aria-busy={busyServer === row.name}
                          aria-describedby={
                            serverErrors[row.name] ? errorId(row.name) : undefined
                          }
                          aria-label={t('permissions:settings.dismissLabel', {
                            name: row.name,
                          })}
                          onClick={() => void onRevokeServer(row.name)}
                        >
                          {t('permissions:settings.dismiss')}
                        </Button>
                      </div>
                      {serverErrors[row.name] &&
                        !servers.some((server) => server.name === row.name) && (
                          <p
                            id={errorId(row.name)}
                            role="alert"
                            className="mt-2 rounded-md bg-destructive-tint px-3 py-2 text-xs text-destructive"
                          >
                            {serverErrors[row.name]}
                          </p>
                        )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Card title={t('permissions:settings.history')}>
              <CardItem
                anchor="settings-permissions-history"
                title={t('permissions:settings.history')}
                description={t('permissions:settings.historyDesc')}
              />
              {historyError ? (
                <p className={EMPTY}>
                  {t('permissions:settings.historyUnavailable', {
                    error: historyError,
                  })}
                </p>
              ) : history && history.length === 0 ? (
                <p className={EMPTY}>
                  {t('permissions:settings.historyEmpty')}
                </p>
              ) : (
                // A table from 640px up; below that each decision is a
                // label/value record, so nothing scrolls sideways on a phone.
                <div className="min-w-0 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm tabular-nums">
                    <thead className="sr-only sm:not-sr-only">
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th scope="col" className="py-2 pr-4 font-medium">
                          {t('permissions:settings.historyTime')}
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          {t('permissions:settings.historyDecision')}
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          {t('permissions:settings.historyTool')}
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          {t('permissions:settings.historyScope')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(history ?? []).map((record, index) => (
                        <tr
                          key={`${record.at}-${record.call}-${index}`}
                          className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border py-3 last:border-b-0 sm:table-row sm:py-0"
                        >
                          <td className="contents sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top sm:whitespace-nowrap">
                            <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
                              {t('permissions:settings.historyTime')}
                            </span>
                            <time
                              dateTime={record.at}
                              className="text-xs text-ink-2"
                            >
                              {formatWhen(record.at)}
                            </time>
                          </td>
                          <td className="contents sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top">
                            <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
                              {t('permissions:settings.historyDecision')}
                            </span>
                            <span>
                              <StatusChip tone={decisionTone(record.decision)}>
                                {record.decision}
                              </StatusChip>
                            </span>
                          </td>
                          <td className="contents sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top">
                            <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
                              {t('permissions:settings.historyTool')}
                            </span>
                            <span className="break-all font-mono text-xs text-foreground">
                              {record.tool}
                            </span>
                          </td>
                          <td className="contents sm:table-cell sm:py-2.5 sm:align-top">
                            <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
                              {t('permissions:settings.historyScope')}
                            </span>
                            <span className="min-w-0">
                              {record.resource && (
                                <span className="block break-all font-mono text-xs text-ink-2">
                                  {record.resource}
                                </span>
                              )}
                              {record.reason && (
                                <span className="block text-xs text-muted-foreground">
                                  {record.reason}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

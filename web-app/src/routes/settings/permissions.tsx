import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { OctagonAlert } from 'lucide-react'
import { DecisionScope } from '@/containers/DecisionScope'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { Input } from '@/components/ui/input'
import {
  MAX_AUTO_APPROVE_LIMIT,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'
import { FolderAccessCard } from '@/containers/FolderAccessCard'
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
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
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

/** One integrated row: what the grant is on the left, its control on the right. */
const ROW =
  'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0 [&>:first-child]:flex-[1_1_10rem]'
const EMPTY = 'py-3 text-[13px] text-muted-foreground'
/** Outlined destructive, never the accent fill. */
const REVOKE = 'shrink-0 pointer-coarse:h-11'

const GRANT_TONE: Record<GrantState, StatusTone> = {
  current: 'success',
  changed: 'warning',
  missing: 'neutral',
  unknown: 'neutral',
}

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
  if (Number.isNaN(date.getTime())) return at
  // Today's decisions read as a time of day; older ones keep their date.
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour12: false })
    : date.toLocaleString([], { hour12: false })
}

/** The word a recorded decision is shown as. */
function decisionKey(decision: string): string | null {
  const value = decision.toLowerCase()
  if (value.startsWith('allow') || value === 'approved' || value === 'granted')
    return 'permissions:settings.decisionAllowed'
  if (value.startsWith('deny') || value.startsWith('refuse'))
    return 'permissions:settings.decisionDenied'
  return null
}

function InlineError({ id, children }: { id?: string; children: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-md bg-destructive-tint px-3 py-2 text-xs text-destructive"
    >
      <OctagonAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
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

  const grantLabel = (state: GrantState) => {
    switch (state) {
      case 'current':
        return t('permissions:settings.stateTrusted')
      case 'changed':
        return t('permissions:settings.stateChanged')
      case 'missing':
        return t('permissions:settings.stateMissing')
      case 'unknown':
        return t('permissions:settings.stateUnknown')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader title={t('permissions:settings.title')} />
      <SettingsPageBody
        title={t('permissions:settings.title')}
        description={
          <>
            <span>{t('permissions:settings.intro')}</span>{' '}
            <span>{t('permissions:settings.revokeEffect')}</span>
          </>
        }
        layout={[0, 1, 0, 1, 0, 1, 0]}
      >
        {/* 0. How long an auto-approved run goes before checking in */}
        <AutoApproveLimitCard />

        {/* 1. Allowed in one conversation */}
        <Card
          anchor="settings-permissions-conversations"
          title={t('permissions:settings.conversations')}
          description={t('permissions:settings.conversationsDesc')}
          aside={
            <span className="tabular-nums">
              {conversations.reduce(
                (n, row) => n + row.tools.length + row.mcpTools.length,
                0
              )}
            </span>
          }
        >
          {conversations.length === 0 ? (
            <p className={EMPTY}>
              {t('permissions:settings.noConversationGrants')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {conversations.map(({ id: threadId, tools, mcpTools }) => (
                <li key={threadId} className="py-1.5">
                  <p className="truncate pt-1 text-[11px] font-medium tracking-[.025em] text-subtle-foreground uppercase">
                    {conversationTitle(threadId)}
                  </p>
                  <ul className="flex flex-col">
                    {tools.map((tool) => (
                      <li key={tool} className={ROW}>
                        <span className="min-w-0 break-all text-[13px] font-medium text-foreground">
                          {t('permissions:settings.toolLabel', { tool })}
                        </span>
                        <Button
                          variant="destructive"
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
                        className={ROW}
                      >
                        <span className="min-w-0 break-all text-[13px] font-medium text-foreground">
                          {t('permissions:settings.mcpToolLabel', {
                            server: grant.server,
                            tool: grant.tool,
                          })}
                        </span>
                        <Button
                          variant="destructive"
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
        <Card
          anchor="settings-permissions-everywhere"
          title={t('permissions:settings.toolsEverywhere')}
          description={t('permissions:settings.toolsEverywhereDesc')}
          aside={
            <span className="tabular-nums">{approvedToolsGlobal.length}</span>
          }
        >
          {approvedToolsGlobal.length === 0 ? (
            <p className={EMPTY}>{t('permissions:settings.noToolsEverywhere')}</p>
          ) : (
            <ul className="flex flex-col">
              {approvedToolsGlobal.map((tool) => (
                <li key={`tool-${tool}`} className={ROW}>
                  <span className="min-w-0 break-all text-[13px] font-medium text-foreground">
                    {t('permissions:settings.toolLabel', { tool })}
                  </span>
                  <Button
                    variant="destructive"
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

        {/* Folders granted through request_access */}
        <FolderAccessCard />

        {/* 3. Trusted MCP servers, with the state of each approval */}
        <Card
          title={t('permissions:settings.trustedServers')}
          description={t('permissions:settings.trustedServersDesc')}
        >
          {serversError && (
            <InlineError>
              {t('permissions:settings.loadServersFailed', {
                error: serversError,
              })}
            </InlineError>
          )}
          {servers.length === 0 ? (
            <p className={EMPTY}>{t('permissions:settings.noTrustedServers')}</p>
          ) : (
            <ul className="flex flex-col">
              {servers.map((server) => (
                <li
                  key={`server-${server.name}`}
                  className="border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&>:first-child]:flex-[1_1_10rem]">
                    <div className="min-w-0 space-y-0.5">
                      <p className="break-all text-[13px] font-medium text-foreground">
                        {t('permissions:settings.serverLabel', {
                          server: server.name,
                        })}
                      </p>
                      {server.state === 'changed' && (
                        <p className="text-xs leading-[1.4] text-muted-foreground">
                          {t('permissions:settings.serverChanged')}
                        </p>
                      )}
                      {server.state === 'missing' && (
                        <p className="text-xs leading-[1.4] text-muted-foreground">
                          {t('permissions:settings.serverMissing')}
                        </p>
                      )}
                      {server.inApp && !server.inBackend && report && (
                        <p className="text-xs leading-[1.4] text-muted-foreground">
                          {t('permissions:settings.serverAppOnly')}
                        </p>
                      )}
                      {server.inBackend && !server.inApp && (
                        <p className="text-xs leading-[1.4] text-muted-foreground">
                          {t('permissions:settings.serverBackendOnly')}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <StatusChip
                        tone={GRANT_TONE[server.state]}
                        data-testid={`permissions-server-state-${server.name}`}
                      >
                        {grantLabel(server.state)}
                      </StatusChip>
                      <Button
                        variant="destructive"
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
                  </div>
                  {serverErrors[server.name] && (
                    <InlineError id={errorId(server.name)}>
                      {serverErrors[server.name]}
                    </InlineError>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 4. Every MCP tool, without asking */}
        <Card title={t('permissions:settings.allowAllGroup')}>
          {allowAll ? (
            <div className={ROW}>
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium text-foreground">
                    {t('permissions:settings.allowAll')}
                  </p>
                  <StatusChip tone="warning">
                    {t('permissions:settings.allowAllOn')}
                  </StatusChip>
                </div>
                <p className="text-xs leading-[1.4] text-muted-foreground">
                  {t('permissions:settings.allowAllDesc')}
                </p>
              </div>
              <Button
                variant="destructive"
                className={REVOKE}
                onClick={revokeAllowAll}
              >
                {t('permissions:settings.revokeAll')}
              </Button>
            </div>
          ) : (
            <p className={EMPTY}>{t('permissions:settings.allowAllOff')}</p>
          )}
        </Card>

        {/* 5. Approvals that stopped applying, with the reason */}
        {pendingRenewals.length > 0 && (
          <Card
            anchor="settings-permissions-renewal"
            title={t('permissions:settings.needsRenewal')}
            description={t('permissions:settings.needsRenewalDesc')}
          >
            <ul className="flex flex-col">
              {pendingRenewals.map((row) => (
                <li
                  key={`renewal-${row.name}`}
                  className="border-b border-dashed border-border px-0.5 py-[11px] last:border-b-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&>:first-child]:flex-[1_1_10rem]">
                    <div className="min-w-0 space-y-0.5">
                      <p className="break-all text-[13px] font-medium text-foreground">
                        {t('permissions:settings.needsRenewalLabel', {
                          server: row.name,
                        })}
                      </p>
                      <p className="text-xs leading-[1.4] text-muted-foreground">
                        {row.reason === 'changed'
                          ? t('permissions:settings.reasonChanged')
                          : t('permissions:settings.reasonLegacy')}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <StatusChip tone="warning">
                        {t('permissions:settings.stateNeedsRenewal')}
                      </StatusChip>
                      <Button
                        variant="outline"
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
                  </div>
                  {serverErrors[row.name] &&
                    !servers.some((server) => server.name === row.name) && (
                      <InlineError id={errorId(row.name)}>
                        {serverErrors[row.name]}
                      </InlineError>
                    )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* 6. Recent decisions: the audit log, last 50 */}
        <Card
          anchor="settings-permissions-history"
          title={t('permissions:settings.history')}
          description={t('permissions:settings.historyDesc')}
          aside={t('permissions:settings.historyLimit', {
            count: HISTORY_LIMIT,
          })}
        >
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
          ) : history === null ? (
            <p className={EMPTY} aria-busy>
              {t('permissions:settings.loading')}
            </p>
          ) : (
            // A real table at every width; on a narrow screen it scrolls
            // sideways inside this container, never the page.
            <div
              className="min-w-0 overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label={t('permissions:settings.history')}
            >
              <table className="w-full min-w-[28rem] table-fixed border-collapse text-left text-[12.5px] tabular-nums">
                <colgroup>
                  <col className="w-[84px]" />
                  <col className="w-[96px]" />
                  <col />
                  <col className="w-[96px]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-dashed border-border text-xs text-muted-foreground">
                    <th scope="col" className="px-0.5 py-2 font-normal">
                      {t('permissions:settings.historyTime')}
                    </th>
                    <th scope="col" className="px-0.5 py-2 font-normal">
                      {t('permissions:settings.historyTool')}
                    </th>
                    <th scope="col" className="px-0.5 py-2 font-normal">
                      {t('permissions:settings.historyScope')}
                    </th>
                    <th scope="col" className="px-0.5 py-2 font-normal">
                      {t('permissions:settings.historyDecision')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record, index) => (
                    <tr
                      key={`${record.at}-${record.call}-${index}`}
                      className="border-b border-dashed border-border last:border-b-0"
                    >
                      <td className="px-0.5 py-2 align-middle whitespace-nowrap">
                        <time dateTime={record.at} className="font-mono text-xs text-foreground">
                          {formatWhen(record.at)}
                        </time>
                      </td>
                      <td className="px-0.5 py-2 align-middle">
                        <span
                          className="block truncate font-mono text-xs text-foreground"
                          title={record.tool}
                        >
                          {record.tool}
                        </span>
                      </td>
                      <td className="min-w-0 px-0.5 py-2 align-middle">
                        <DecisionScope
                          resource={record.resource}
                          reason={record.reason}
                        />
                      </td>
                      <td className="px-0.5 py-2 align-middle">
                        <StatusChip tone={decisionTone(record.decision)}>
                          {decisionKey(record.decision)
                            ? t(decisionKey(record.decision)!)
                            : record.decision}
                        </StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </SettingsPageBody>
    </div>
  )
}

function AutoApproveLimitCard() {
  const { t } = useTranslation()
  const limit = useAutoApproveLimit((s) => s.limit)
  const setLimit = useAutoApproveLimit((s) => s.setLimit)
  const [draft, setDraft] = useState(String(limit))
  useEffect(() => setDraft(String(limit)), [limit])
  const commit = () => {
    setLimit(draft)
    // Show the value actually kept, e.g. 5000 clamped to the maximum.
    setDraft(String(useAutoApproveLimit.getState().limit))
  }
  return (
    <Card
      anchor="settings-permissions-auto-approve-limit"
      title={t('permissions:settings.autoApproveLimit')}
    >
      <CardItem
        anchor="settings-permissions-auto-approve-limit-value"
        title={t('permissions:settings.autoApproveLimitLabel')}
        description={
          limit === 0
            ? t('permissions:settings.autoApproveLimitOff')
            : t('permissions:settings.autoApproveLimitDesc', {
                count: limit,
                max: MAX_AUTO_APPROVE_LIMIT,
              })
        }
        actions={
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_AUTO_APPROVE_LIMIT}
            step={1}
            aria-label={t('permissions:settings.autoApproveLimitLabel')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
            className="w-28"
          />
        }
      />
    </Card>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval } from '@/hooks/useToolApproval'
import { getServiceHub } from '@/hooks/useServiceHub'
import { errorText } from '@/lib/errorText'
import type { MCPTrustReport } from '@/services/mcp/types'
import type { RenewalRow, ServerRow, GrantState } from '@/containers/permissions/shared'

/**
 * The MCP trust report and what the page derives from it: the servers trusted
 * by the backend gate or the renderer store, the approvals that need renewing,
 * and revoking one. `report` is `null` until the backend answers.
 */
export function useMcpTrustReport() {
  const { t } = useTranslation()
  const approvedServers = useToolApproval((s) => s.approvedServers)
  const invalidatedServers = useToolApproval((s) => s.invalidatedServers)
  const revokeServerTrust = useToolApproval((s) => s.revokeServerTrust)
  const [report, setReport] = useState<MCPTrustReport | null>(null)
  /** Current fingerprint per configured server; `null` until known. */
  const [fingerprints, setFingerprints] = useState<Record<
    string,
    string
  > | null>(null)
  const [serversError, setServersError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [busyServer, setBusyServer] = useState<string | null>(null)

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
        else if (entry.currentFingerprint !== entry.fingerprint)
          state = 'changed'
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

  const pendingRenewals = renewals.filter(
    (row) =>
      !servers.some(
        (server) => server.name === row.name && server.state === 'current'
      )
  )

  return {
    report,
    servers,
    pendingRenewals,
    serversError,
    serverErrors,
    busyServer,
    onRevokeServer,
  }
}

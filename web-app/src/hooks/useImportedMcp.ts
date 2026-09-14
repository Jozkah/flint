import { useCallback } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import {
  consentStillMatches,
  fingerprintMcp,
  startImportedMcp,
  stopImportedMcp,
  type McpRuntime,
} from '@/lib/claudeCompatMcp'
import type { McpProbe } from '@/lib/claudeCompat'

/**
 * Allowing and withdrawing an imported MCP server, for real.
 *
 * The consent switch in readiness drives Flint's own MCP subsystem through this
 * — the same `activate`/`deactivate` path a hand-configured server uses, not a
 * second launcher. Everything about *when* a server counts as up lives in
 * `claudeCompatMcp`; this is the wiring that gives it the subsystem and puts
 * the result back where readiness can see it.
 */

/** Flint's MCP subsystem, narrowed to what starting a server needs. */
const janRuntime = (): McpRuntime => {
  const mcp = getServiceHub().mcp()
  return {
    activate: (name, config) =>
      mcp.activateMCPServer(name, config as Parameters<typeof mcp.activateMCPServer>[1]),
    deactivate: (name) => mcp.deactivateMCPServer(name),
    connected: () => mcp.getConnectedServers(),
    toolsFor: (names) => mcp.getToolsForServers(names),
  }
}

export function useImportedMcp(input: {
  folder: string | null
  /** The session workspace an imported server would run in. */
  workspacePath: string | null
  /** Flint's data folder, hidden from any server started here. */
  dataFolder: string | null
  /** The repository, writable, only where a live grant says so. */
  writableRepository: string | null
}) {
  const { folder, workspacePath, dataFolder, writableRepository } = input
  /**
   * Allow one server and bring it up, or withdraw it and take it down.
   *
   * Consent is recorded against the exact definition it was given for, so a
   * `.mcp.json` edited afterwards does not inherit it. The runtime record is
   * written as the server moves, which is what stops readiness showing
   * "active" for something still shaking hands.
   */
  const setConsent = useCallback(
    async (probe: McpProbe, allowed: boolean) => {
      if (!folder) return
      const store = useClaudeCompat.getState()

      if (!allowed) {
        store.setMcpConsent(folder, probe.name, false)
        await stopImportedMcp(
          probe.name,
          fingerprintMcp(probe),
          janRuntime(),
          (record) => useClaudeCompat.getState().setMcpRuntime(folder, probe.name, record)
        )
        return
      }

      const fingerprint = fingerprintMcp(probe)
      store.setMcpConsent(folder, probe.name, true)
      store.setMcpFingerprint(folder, probe.name, fingerprint)

      /**
       * How the backend must confine a local server.
       *
       * Built here, from the session's own authority — never from the
       * repository's file. Without a workspace there is nothing to confine it
       * to, so none is sent and the backend refuses to start it, which is the
       * right outcome: an imported server with no confinement must fail closed.
       */
      const local = (probe.transport ?? (probe.command ? 'stdio' : null)) === 'stdio'
      const confinement =
        local && workspacePath
          ? {
              workspace: workspacePath,
              ...(folder ? { repository: folder } : {}),
              // Only where the session actually holds direct-edit authority.
              ...(writableRepository
                ? { writableRepository }
                : {}),
              ...(dataFolder ? { janData: dataFolder } : {}),
              // Names only. Values are supplied through Flint's own handling.
              allowedEnv: [...(probe.envNames ?? [])],
            }
          : undefined

      await startImportedMcp(
        probe,
        janRuntime(),
        (record) =>
          useClaudeCompat.getState().setMcpRuntime(folder, probe.name, record),
        confinement
      )
    },
    [folder, workspacePath, dataFolder, writableRepository]
  )

  /**
   * Withdraw a consent whose definition has since changed.
   *
   * Called when a rescan finds the file edited. The server is stopped rather
   * than left running: it is a different program from the one that was
   * allowed, and it is already up.
   */
  const revalidate = useCallback(
    async (probes: readonly McpProbe[]) => {
      if (!folder) return
      const state = useClaudeCompat.getState()
      const consented = state.consentedMcp(folder)
      const fingerprints = state.mcpFingerprints[folder] ?? {}

      for (const probe of probes) {
        if (!consented.has(probe.name)) continue
        if (consentStillMatches(probe, fingerprints[probe.name])) continue
        state.setMcpConsent(folder, probe.name, false)
        await stopImportedMcp(
          probe.name,
          fingerprintMcp(probe),
          janRuntime(),
          (record) =>
            useClaudeCompat.getState().setMcpRuntime(folder, probe.name, record)
        )
      }
    },
    [folder]
  )

  return { setConsent, revalidate }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  emptyManifest,
  resolveCompatibility,
  type CompatibilityManifest,
  type McpProbe,
} from '@/lib/claudeCompat'
import { sandboxEnforces } from '@/lib/agentTools'
import {
  discoverCompatibility,
  type CompatIO,
  type UserSkillRoot,
} from '@/lib/claudeCompatDiscovery'
import { bindingKey, type Binding } from '@/lib/coworkReadiness'

/**
 * The repository's Claude configuration, resolved for the binding on screen.
 *
 * Rescanned when the folder, the opt-in, or what the user has consented to
 * changes — and guarded by the binding it started for, so a scan that resolves
 * after the user has attached a different folder is dropped rather than
 * activating one repository's configuration against another.
 *
 * Reads go through the root-contained project reader, so a `.claude` directory
 * outside the attached folder is unreachable from here by construction.
 */
export function useCompatManifest(input: {
  binding: Binding
  enabledSkills: Set<string>
  availableTools: readonly string[]
  /**
   * Agents the user has saved in Jan.
   *
   * Passed in so an imported agent that reuses one of those names is reported
   * as a duplicate rather than quietly shadowed: a repository must not be able
   * to redefine an agent the user configured for themselves.
   */
  savedAgentNames?: readonly string[]
  /**
   * Absolute user-level skill directories Jan has approved.
   *
   * Empty by default. Never taken from the repository: a file in the folder
   * being scanned must not get to choose which of the user's directories Jan
   * reads.
   */
  approvedUserSkillRoots?: readonly string[]
}): {
  manifest: CompatibilityManifest
  rescan: () => void
  /** The MCP definitions as found on disk, for consent to bind against. */
  mcpProbes: readonly McpProbe[]
} {
  const { binding, enabledSkills, availableTools, savedAgentNames } = input
  const approvedUserSkillRoots = input.approvedUserSkillRoots ?? []
  const folder = binding.folder
  const enabled = useClaudeCompat((s) =>
    folder ? Boolean(s.folders[folder]) : false
  )
  const consent = useClaudeCompat((s) =>
    folder ? s.mcpConsent[folder] : undefined
  )
  // Runtime state, not configuration: a server is only reported up because
  // Jan's MCP subsystem said it came up.
  const runtime = useClaudeCompat((s) =>
    folder ? s.mcpRuntime[folder] : undefined
  )
  const [manifest, setManifest] = useState<CompatibilityManifest>(() =>
    emptyManifest(binding)
  )
  const [nonce, setNonce] = useState(0)
  const lastProbes = useRef<readonly McpProbe[]>([])
  const rescan = useCallback(() => setNonce((n) => n + 1), [])

  // Read inside the effect without making them dependencies: a change to the
  // enabled skill set or the advertised tools re-resolves on the next scan
  // rather than restarting one in flight.
  const latest = useRef({
    enabledSkills,
    availableTools,
    approvedUserSkillRoots,
    savedAgentNames,
  })
  latest.current = {
    enabledSkills,
    availableTools,
    approvedUserSkillRoots,
    savedAgentNames,
  }

  /**
   * The last scan's findings, kept so a change to what they are resolved
   * against can be applied without scanning the disk again.
   *
   * Without this, inputs that arrived after the scan were simply ignored: the
   * saved subagents load independently of the scan, and when they landed
   * second an imported agent reusing a saved name was never reported as a
   * duplicate -- it stayed "missing dependency" until something else forced a
   * rescan. The same held for the advertised tool list, which is only known
   * once a run has built it.
   */
  const lastScan = useRef<{
    key: string
    probes: Parameters<typeof resolveCompatibility>[0]
  } | null>(null)

  const resolveFrom = (probes: Parameters<typeof resolveCompatibility>[0]) =>
    resolveCompatibility(probes, {
      binding,
      enabled,
      enabledSkills: latest.current.enabledSkills,
      availableTools: latest.current.availableTools,
      savedAgentNames: latest.current.savedAgentNames ?? [],
      consentedMcp: new Set(consent ?? []),
      initializedMcp: new Set(
        Object.entries(runtime ?? {})
          .filter(([, record]) => record.state === 'active')
          .map(([name]) => name)
      ),
      failedMcp: new Map(
        Object.entries(runtime ?? {})
          .filter(([, record]) => record.state === 'init-failed')
          .map(([name, record]) => [name, record.reason ?? 'did not start'])
      ),
      // What this platform can actually enforce, asked of the backend
      // rather than assumed. A local server is refused wherever nothing
      // would confine it, which is the whole platform story for stdio.
      confinement: { stdio: sandboxEnforces() },
    })

  // Compared by content: the caller builds new arrays and sets every render.
  const inputsKey = JSON.stringify([
    [...enabledSkills].sort(),
    [...availableTools].sort(),
    [...(savedAgentNames ?? [])].sort(),
  ])

  useEffect(() => {
    const scan = lastScan.current
    if (!scan || scan.key !== bindingKey(binding)) return
    setManifest(resolveFrom(scan.probes))
    // Re-resolves when what the findings are judged against changes; the
    // scan itself is the other effect's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey])

  useEffect(() => {
    if (!folder) {
      lastScan.current = null
      setManifest(emptyManifest(binding))
      return
    }
    const startedFor = bindingKey(binding)
    let alive = true

    void (async () => {
      let probes
      try {
        const dataFolder = await getServiceHub().app().getJanDataFolder()
        if (!dataFolder) return
        const io: CompatIO = {
          list: async (rel) =>
            (await projectListDir(dataFolder, folder, rel)).entries,
          read: async (rel) => {
            const file = await projectReadFile(dataFolder, folder, rel, false)
            return {
              content: file.content,
              oversized: file.oversized,
              binary: file.binary,
            }
          },
        }
        /**
         * User-level skill roots, if any are approved.
         *
         * Reads there go through the same contained reader with the root
         * itself as the boundary — so a resource climbing out of a user skill
         * is as unreadable as one climbing out of the repository. The
         * repository cannot add a root: this list comes from Jan, never from
         * a file in the folder being scanned.
         */
        const userRoots: UserSkillRoot[] =
          latest.current.approvedUserSkillRoots.map((root) => ({
            root,
            source: 'configured' as const,
            io: {
              list: async (rel) =>
                (await projectListDir(dataFolder, root, rel)).entries,
              read: async (rel) => {
                const file = await projectReadFile(dataFolder, root, rel, false)
                return {
                  content: file.content,
                  oversized: file.oversized,
                  binary: file.binary,
                }
              },
            },
          }))
        probes = await discoverCompatibility(io, folder, userRoots)
      } catch {
        // A scan that could not run claims nothing rather than reporting an
        // empty repository, which would read as "there is nothing here".
        return
      }
      if (!alive || bindingKey(binding) !== startedFor) return
      // Kept so consent can be given against the definition actually on disk
      // rather than against the manifest's rendering of it.
      lastProbes.current = probes.mcp
      lastScan.current = { key: startedFor, probes }

      setManifest(resolveFrom(probes))
    })()

    return () => {
      alive = false
    }
    // `binding` is compared by key inside, and the rest is read through the
    // ref: depending on those identities would rescan on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, binding.sessionId, enabled, consent, runtime, nonce])

  return { manifest, rescan, mcpProbes: lastProbes.current }
}

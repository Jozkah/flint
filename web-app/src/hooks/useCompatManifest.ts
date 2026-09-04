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
  NO_LOCAL_CONFINEMENT,
  type CompatibilityManifest,
} from '@/lib/claudeCompat'
import {
  discoverCompatibility,
  type CompatIO,
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
}): { manifest: CompatibilityManifest; rescan: () => void } {
  const { binding, enabledSkills, availableTools } = input
  const folder = binding.folder
  const enabled = useClaudeCompat((s) =>
    folder ? Boolean(s.folders[folder]) : false
  )
  const consent = useClaudeCompat((s) => (folder ? s.mcpConsent[folder] : undefined))
  const [manifest, setManifest] = useState<CompatibilityManifest>(() =>
    emptyManifest(binding)
  )
  const [nonce, setNonce] = useState(0)
  const rescan = useCallback(() => setNonce((n) => n + 1), [])

  // Read inside the effect without making them dependencies: a change to the
  // enabled skill set or the advertised tools re-resolves on the next scan
  // rather than restarting one in flight.
  const latest = useRef({ enabledSkills, availableTools })
  latest.current = { enabledSkills, availableTools }

  useEffect(() => {
    if (!folder) {
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
          list: async (rel) => (await projectListDir(dataFolder, folder, rel)).entries,
          read: async (rel) => {
            const file = await projectReadFile(dataFolder, folder, rel, false)
            return {
              content: file.content,
              oversized: file.oversized,
              binary: file.binary,
            }
          },
        }
        probes = await discoverCompatibility(io, folder)
      } catch {
        // A scan that could not run claims nothing rather than reporting an
        // empty repository, which would read as "there is nothing here".
        return
      }
      if (!alive || bindingKey(binding) !== startedFor) return

      setManifest(
        resolveCompatibility(probes, {
          binding,
          enabled,
          enabledSkills: latest.current.enabledSkills,
          availableTools: latest.current.availableTools,
          consentedMcp: new Set(consent ?? []),
          initializedMcp: new Set(),
          // Nothing has been started, so nothing has initialized. A server
          // reaches `active` only once Jan's own MCP subsystem reports it up.
          failedMcp: new Map(),
          confinement: NO_LOCAL_CONFINEMENT,
        })
      )
    })()

    return () => {
      alive = false
    }
    // `binding` is compared by key inside; depending on the object identity
    // would rescan on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, binding.sessionId, enabled, consent, nonce])

  return { manifest, rescan }
}

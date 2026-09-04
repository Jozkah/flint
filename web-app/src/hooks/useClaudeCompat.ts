import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'
import { localStorageKey } from '@/constants/localStorage'

/**
 * Whether a repository's Claude Code configuration is switched on, and what
 * the user has allowed within it.
 *
 * Two different lifetimes, deliberately kept apart.
 *
 * **Compatibility itself persists.** Turning it on grants nothing: no write
 * access, no access-mode change, no running process. It only says "read the
 * configuration that is already in this folder". Making the user re-tick that
 * on every launch would be friction with no safety bought.
 *
 * **MCP consent does not persist.** Allowing a server means allowing a
 * process, and authority that outlives the app session it was granted in is
 * authority nobody is accountable for. After a restart the user is asked
 * again — the same rule direct-edit grants follow.
 */

type CompatState = {
  /** Canonical folder path → switched on. */
  folders: Record<string, boolean>
  /**
   * Folder → MCP server names the user has allowed, this app session only.
   *
   * Kept out of `partialize`, so it is never written to storage and never
   * restored: a consent silently reinstated at launch is a process started by
   * a decision the user made weeks ago and cannot see.
   */
  mcpConsent: Record<string, string[]>
  enabledFor: (folder: string | null | undefined) => boolean
  setEnabled: (folder: string, enabled: boolean) => void
  consentedMcp: (folder: string | null | undefined) => Set<string>
  setMcpConsent: (folder: string, server: string, allowed: boolean) => void
  /** Drop a folder's consent outright. For teardown and for revocation. */
  clearMcpConsent: (folder: string) => void
}

export const useClaudeCompat = create<CompatState>()(
  persist(
    (set, get) => ({
      folders: {},
      mcpConsent: {},

      enabledFor: (folder) => (folder ? Boolean(get().folders[folder]) : false),

      setEnabled: (folder, enabled) =>
        set((s) => ({
          folders: { ...s.folders, [folder]: enabled },
          // Switching compatibility off withdraws what was allowed under it.
          // Leaving consent behind would re-allow every server the moment it
          // was switched back on.
          mcpConsent: enabled
            ? s.mcpConsent
            : { ...s.mcpConsent, [folder]: [] },
        })),

      consentedMcp: (folder) =>
        new Set(folder ? (get().mcpConsent[folder] ?? []) : []),

      setMcpConsent: (folder, server, allowed) =>
        set((s) => {
          const current = new Set(s.mcpConsent[folder] ?? [])
          if (allowed) current.add(server)
          else current.delete(server)
          return { mcpConsent: { ...s.mcpConsent, [folder]: [...current] } }
        }),

      clearMcpConsent: (folder) =>
        set((s) => ({ mcpConsent: { ...s.mcpConsent, [folder]: [] } })),
    }),
    {
      name: localStorageKey.claudeCompat,
      storage: createJSONStorage(() => backendStorage),
      // Async storage requires skipHydration + explicit rehydrate in
      // hydrateBackendStores() once the ServiceHub is ready.
      skipHydration: true,
      // The opt-in, and nothing else. Consent is absent here on purpose.
      partialize: (state) => ({ folders: state.folders }),
    }
  )
)

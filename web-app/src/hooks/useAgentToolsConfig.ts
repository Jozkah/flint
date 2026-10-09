import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type AgentToolsConfigState = {
  agentToolsEnabled: boolean
  setAgentToolsEnabled: (value: boolean) => void
  /**
   * Let a chat hand jobs to subagents (`task`, `await_task`, ...). On by
   * default, and only meaningful while the agent tools are on: a child works
   * with those same tools, gated the same way.
   */
  chatDelegationEnabled: boolean
  setChatDelegationEnabled: (value: boolean) => void
  /**
   * Offer the shell (`bash`) at all. On by default; turning it off withholds
   * the tool from every surface and refuses a call that still arrives, while
   * the file tools keep working.
   */
  shellEnabled: boolean
  setShellEnabled: (value: boolean) => void
  /** Open the sandboxed shell's network namespace. */
  bashNetworkEnabled: boolean
  setBashNetworkEnabled: (value: boolean) => void
  /**
   * Let the assistant read and drive the built-in browser pane
   * (browser_open, browser_snapshot, ...). Off by default: every site still
   * asks the first time, but the tools also cost context in every request.
   */
  browserAgentEnabled: boolean
  setBrowserAgentEnabled: (value: boolean) => void
  /** Clicks, keystrokes and selections one run may make in the browser pane. */
  browserAgentMaxActions: number
  setBrowserAgentMaxActions: (value: number) => void
  /** Draw the assistant's pointer in the browser pane while it works. */
  browserAgentPointer: boolean
  setBrowserAgentPointer: (value: boolean) => void
  /** `system` follows the page's prefers-reduced-motion; `on` never glides or pulses. */
  browserAgentReduceMotion: 'system' | 'on' | 'off'
  setBrowserAgentReduceMotion: (value: 'system' | 'on' | 'off') => void
}

/**
 * Off by default: the toolset gives the model filesystem reach (inside the
 * isolated agent workspace) and a persistent memory, so it is opt-in.
 *
 * `bashNetworkEnabled` is on by default: installing packages or fetching a
 * repository is ordinary agent work, and the sandbox still confines a command
 * to the workspace. Turning it off keeps a command from sending anything off
 * the machine. The project's `agent.toml` and machine policy can still clamp
 * it off in the backend.
 */
export const useAgentToolsConfig = create<AgentToolsConfigState>()(
  persist(
    (set) => ({
      agentToolsEnabled: false,
      setAgentToolsEnabled: (agentToolsEnabled) => set({ agentToolsEnabled }),
      chatDelegationEnabled: true,
      setChatDelegationEnabled: (chatDelegationEnabled) =>
        set({ chatDelegationEnabled }),
      shellEnabled: true,
      setShellEnabled: (shellEnabled) => set({ shellEnabled }),
      bashNetworkEnabled: true,
      setBashNetworkEnabled: (bashNetworkEnabled) => set({ bashNetworkEnabled }),
      browserAgentEnabled: false,
      setBrowserAgentEnabled: (browserAgentEnabled) =>
        set({ browserAgentEnabled }),
      browserAgentPointer: true,
      setBrowserAgentPointer: (browserAgentPointer) =>
        set({ browserAgentPointer }),
      browserAgentReduceMotion: 'system',
      setBrowserAgentReduceMotion: (browserAgentReduceMotion) =>
        set({ browserAgentReduceMotion }),
      browserAgentMaxActions: 40,
      setBrowserAgentMaxActions: (value) =>
        set({
          browserAgentMaxActions: Math.min(
            200,
            Math.max(1, Math.round(Number.isFinite(value) ? value : 40))
          ),
        }),
    }),
    {
      name: localStorageKey.settingAgentTools,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // v1: network became on by default. The old default (off) was the only
      // way a stored `false` could arise for most people, so flip it once;
      // anyone who turns it off again after this keeps their choice.
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<AgentToolsConfigState>
        if (version < 1) {
          return { ...state, bashNetworkEnabled: true }
        }
        return state
      },
    }
  )
)

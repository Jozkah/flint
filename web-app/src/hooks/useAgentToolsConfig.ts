import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type AgentToolsConfigState = {
  agentToolsEnabled: boolean
  setAgentToolsEnabled: (value: boolean) => void
  /** Open the sandboxed shell's network namespace. */
  bashNetworkEnabled: boolean
  setBashNetworkEnabled: (value: boolean) => void
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
      bashNetworkEnabled: true,
      setBashNetworkEnabled: (bashNetworkEnabled) => set({ bashNetworkEnabled }),
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

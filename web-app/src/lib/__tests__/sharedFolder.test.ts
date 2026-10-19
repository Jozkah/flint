import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { sharedFolder, SHARED_FOLDER_UPDATED_EVENT } from '../sharedFolder'
import { sessionMailbox } from '../sessionMailbox'

describe('sharedFolder client', () => {
  beforeEach(() => invoke.mockReset())

  it('names the event the backend emits', () => {
    expect(SHARED_FOLDER_UPDATED_EVENT).toBe('agent-shared-folder-updated')
  })

  it('calls each command with the data folder', async () => {
    invoke.mockResolvedValue(null)
    await sharedFolder.peers('S1')
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|shared_folder_peers',
      { dataFolder: '/mock/jan/data', sessionId: 'S1' }
    )
    await sharedFolder.overview()
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|shared_folder_overview',
      { dataFolder: '/mock/jan/data' }
    )
    await sharedFolder.recentEdits('S1')
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|shared_folder_recent_edits',
      { dataFolder: '/mock/jan/data', sessionId: 'S1', windowSecs: null }
    )
    await sharedFolder.allow('S1', 'edit', 15)
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|shared_folder_allow',
      {
        dataFolder: '/mock/jan/data',
        sessionId: 'S1',
        scope: 'edit',
        minutes: 15,
      }
    )
  })

  it('asks for the default isolation of a folder', async () => {
    invoke.mockResolvedValue({ isolate: true, reason: 'secondSession' })
    const d = await sharedFolder.defaultIsolation({
      folder: '/repo',
      sessionId: 'S2',
      isFork: true,
    })
    expect(d).toEqual({ isolate: true, reason: 'secondSession' })
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|shared_folder_default_isolation',
      {
        dataFolder: '/mock/jan/data',
        folder: '/repo',
        sessionId: 'S2',
        isFork: true,
        userChoseShared: false,
      }
    )
  })

  it('registers how a session works in its folder, only when told', async () => {
    invoke.mockResolvedValue({})
    await sessionMailbox.register({
      sessionId: 'S2',
      displayName: 'T',
      folder: '/repo',
      access: 'managed-worktree',
      isolated: true,
    })
    expect(invoke).toHaveBeenLastCalledWith(
      'plugin:agent-tools|mailbox_session_register',
      {
        dataFolder: '/mock/jan/data',
        sessionId: 'S2',
        displayName: 'T',
        folder: '/repo',
        acceptsMessages: null,
        access: 'managed-worktree',
        isolated: true,
      }
    )
  })
})

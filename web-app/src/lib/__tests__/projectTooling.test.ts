import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { loadProjectTooling } from '../projectTooling'

describe('loadProjectTooling', () => {
  it('returns the facts and the backend’s prompt block for the folder', async () => {
    const call = vi.fn(async () => ({
      facts: [
        {
          kind: 'build-system',
          value: 'Cargo',
          confidence: 'high',
          source: 'Cargo.toml',
          scope: '',
          reason: 'Cargo.toml',
          command: 'cargo build',
        },
      ],
      conflicts: [],
      skipped: [],
      truncated: null,
      prompt: '# Project Tooling\n...',
    }))
    const out = await loadProjectTooling('/repo', call)
    expect(call).toHaveBeenCalledWith('project_tooling', { folder: '/repo' })
    expect(out).toEqual({
      readiness: {
        state: 'ready',
        facts: [expect.objectContaining({ value: 'Cargo' })],
        conflicts: [],
        skipped: [],
        truncated: null,
      },
      prompt: '# Project Tooling\n...',
    })
  })

  it('turns a typed refusal into a failed state, never a throw', async () => {
    const out = await loadProjectTooling('/gone', async () => {
      throw { kind: 'not-a-directory', message: 'x is not a directory' }
    })
    expect(out).toEqual({
      readiness: {
        state: 'failed',
        error: { kind: 'not-a-directory', message: 'x is not a directory' },
      },
      prompt: null,
    })
  })

  it('names an untyped failure as unavailable', async () => {
    const out = await loadProjectTooling('/repo', async () => {
      throw new Error('command project_tooling not found')
    })
    expect(out.readiness).toEqual({
      state: 'failed',
      error: { kind: 'unavailable', message: 'command project_tooling not found' },
    })
    expect(out.prompt).toBeNull()
  })
})

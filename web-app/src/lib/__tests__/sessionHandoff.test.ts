import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  compareFolder,
  describeRestoreItem,
  restoreReport,
  type HandoffInfo,
  type ProviderView,
} from '../sessionHandoff'

const info: HandoffInfo = {
  folder: { name: 'widget', branch: 'main', head: 'abcdef1234567890' },
  model: { provider: 'openrouter', id: 'gpt-x' },
}

const providers = (over: Partial<ProviderView> = {}): ProviderView[] => [
  {
    provider: 'openrouter',
    models: [{ id: 'gpt-x' }],
    usable: true,
    ...over,
  },
]

describe('restoreReport (AH-210)', () => {
  it('always asks for the folder, which only the user can choose', () => {
    expect(restoreReport(info, providers())).toEqual([
      { kind: 'folder', expected: info.folder },
    ])
  })

  it('names a provider that is missing or not usable here', () => {
    expect(restoreReport(info, [])).toContainEqual({
      kind: 'provider',
      provider: 'openrouter',
    })
    expect(restoreReport(info, providers({ usable: false }))).toContainEqual({
      kind: 'provider',
      provider: 'openrouter',
    })
  })

  it('names a model its provider does not offer here', () => {
    expect(restoreReport(info, providers({ models: [] }))).toContainEqual({
      kind: 'model',
      provider: 'openrouter',
      id: 'gpt-x',
    })
  })

  it('has nothing to say about a session with no folder and no model', () => {
    expect(restoreReport({ folder: null, model: null }, [])).toEqual([])
  })

  it('says each item plainly', () => {
    const lines = restoreReport(info, []).map(describeRestoreItem)
    expect(lines[0]).toContain('a folder named widget')
    expect(lines[0]).toContain('branch main at commit abcdef123456')
    expect(lines[1]).toContain('provider openrouter is not set up')
  })
})

describe('compareFolder', () => {
  it('matches the same name, branch and commit', () => {
    expect(compareFolder(info.folder!, { ...info.folder! })).toEqual({
      matches: true,
    })
  })

  it('names every way the attached folder differs', () => {
    const out = compareFolder(info.folder!, {
      name: 'widget',
      branch: 'dev',
      head: '0000000000000000',
    })
    expect(out.matches).toBe(false)
    expect(!out.matches && out.differences).toEqual([
      'it is on branch dev, not main',
      'it is at commit 000000000000, not abcdef123456',
    ])
  })
})

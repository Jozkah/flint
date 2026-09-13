import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The skill list comes from the backend; only the call is replaced.
const listSkills = vi.fn()
vi.mock('@/lib/skillStore', () => ({
  projectScope: (folder: string) => ({ kind: 'project', folder }),
  listSkills: (...a: unknown[]) => listSkills(...a),
  readSkill: vi.fn(),
  writeSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

import {
  effectiveEnabled,
  invalidateSkills,
  storedEnabled,
  useSkills,
  whitelistMatches,
} from '../useSkills'

const deploy = { name: 'deploy', description: 'Ship it' }
const prepare = {
  name: 'release:prepare',
  description: 'Prepare a release',
  plugin: 'release',
}

describe('whitelist matching mirrors the backend', () => {
  const all = ['deploy', 'release:prepare', 'release:changelog']

  it('matches a plugin skill by full name, plain name or plugin id', () => {
    expect(whitelistMatches('release:prepare', 'release:prepare')).toBe(true)
    expect(whitelistMatches('prepare', 'release:prepare')).toBe(true)
    expect(whitelistMatches('release', 'release:prepare')).toBe(true)
    expect(whitelistMatches('release', 'deploy')).toBe(false)
    expect(whitelistMatches('', 'deploy')).toBe(false)
  })

  it('resolves the stored whitelist, plugin entries included', () => {
    expect([...effectiveEnabled([], all)]).toEqual(all)
    expect([...effectiveEnabled(['release'], all)]).toEqual([
      'release:prepare',
      'release:changelog',
    ])
    expect([...effectiveEnabled(['changelog', 'deploy'], all)]).toEqual([
      'deploy',
      'release:changelog',
    ])
    // A removed plugin's entry and the "none" sentinel match nothing.
    expect(effectiveEnabled(['gone:thing', ''], all).size).toBe(0)
  })

  it('writes a toggle back as explicit names', () => {
    const next = effectiveEnabled(['release'], all)
    next.delete('release:changelog')
    expect(storedEnabled(next, all)).toEqual(['release:prepare'])
  })
})

describe('useSkills after a plugin change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_skill_enabled_get' ? [] : undefined
    )
  })

  it('re-fetches when plugins change, and shows where each skill comes from', async () => {
    listSkills.mockResolvedValueOnce([deploy])
    const { result } = renderHook(() => useSkills('/project'))
    await waitFor(() => expect(result.current.skills).toEqual([deploy]))
    expect(listSkills).toHaveBeenCalledWith({ kind: 'project', folder: '/project' })

    // A plugin is installed or enabled: its skill joins the list.
    listSkills.mockResolvedValueOnce([deploy, prepare])
    await act(async () => {
      invalidateSkills()
    })
    await waitFor(() => expect(result.current.skills).toEqual([deploy, prepare]))
    expect(result.current.skills[1].plugin).toBe('release')

    // Disabled or removed: it leaves the list again.
    listSkills.mockResolvedValueOnce([deploy])
    await act(async () => {
      invalidateSkills()
    })
    await waitFor(() => expect(result.current.skills).toEqual([deploy]))
    expect(listSkills).toHaveBeenCalledTimes(3)
  })

  it('refreshes every mounted instance, not just one', async () => {
    listSkills.mockResolvedValue([deploy])
    const a = renderHook(() => useSkills('/project'))
    const b = renderHook(() => useSkills('/project'))
    await waitFor(() => expect(a.result.current.skills).toEqual([deploy]))
    await waitFor(() => expect(b.result.current.skills).toEqual([deploy]))

    listSkills.mockResolvedValue([deploy, prepare])
    await act(async () => {
      invalidateSkills()
    })
    await waitFor(() => expect(a.result.current.skills).toHaveLength(2))
    await waitFor(() => expect(b.result.current.skills).toHaveLength(2))
  })
})

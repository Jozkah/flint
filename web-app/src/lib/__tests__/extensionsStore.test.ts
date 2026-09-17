import { describe, expect, it, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  resolveExtensions,
  getMatrix,
  setMatrix,
  listProjects,
  registerProject,
} from '@/lib/extensionsStore'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

describe('extensionsStore', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('resolveExtensions sends surface only for home/rooms', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await resolveExtensions('rooms')
    expect(mockedInvoke).toHaveBeenCalledWith('agent_resolve_extensions', {
      surface: 'rooms',
    })
  })

  it('resolveExtensions normalizes cowork surface with projectId', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await resolveExtensions({ cowork: 'p1' })
    expect(mockedInvoke).toHaveBeenCalledWith('agent_resolve_extensions', {
      surface: 'cowork',
      projectId: 'p1',
    })
  })

  it('getMatrix calls agent_extensions_matrix_get with no args', async () => {
    mockedInvoke.mockResolvedValueOnce({ skills: {}, plugins: {} })
    await getMatrix()
    expect(mockedInvoke).toHaveBeenCalledWith('agent_extensions_matrix_get', {})
  })

  it('setMatrix normalizes cowork surface and sends id/kind/enabled', async () => {
    mockedInvoke.mockResolvedValueOnce({ skills: {}, plugins: {} })
    await setMatrix('skill', 'caveman', { cowork: 'p1' }, false)
    expect(mockedInvoke).toHaveBeenCalledWith('agent_extensions_matrix_set', {
      kind: 'skill',
      id: 'caveman',
      surface: 'cowork',
      projectId: 'p1',
      enabled: false,
    })
  })

  it('setMatrix sends surface only for home/rooms', async () => {
    mockedInvoke.mockResolvedValueOnce({ skills: {}, plugins: {} })
    await setMatrix('plugin', 'foo', 'home', true)
    expect(mockedInvoke).toHaveBeenCalledWith('agent_extensions_matrix_set', {
      kind: 'plugin',
      id: 'foo',
      surface: 'home',
      enabled: true,
    })
  })

  it('listProjects calls agent_projects_list', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await listProjects()
    expect(mockedInvoke).toHaveBeenCalledWith('agent_projects_list', {})
  })

  it('registerProject calls agent_projects_register with folder', async () => {
    mockedInvoke.mockResolvedValueOnce({ id: '1', folder: '/x', name: 'x' })
    await registerProject('/x')
    expect(mockedInvoke).toHaveBeenCalledWith('agent_projects_register', {
      folder: '/x',
    })
  })
})

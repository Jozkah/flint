import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock-backed: `invoke` stands in for the agent_plugin_* Tauri commands.
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import {
  PluginError,
  cancelPluginInstall,
  checkGitUrl,
  installPlugin,
  listPlugins,
  pluginErrorText,
  setPluginEnabled,
  toPluginError,
} from '../pluginStore'

describe('pluginStore', () => {
  beforeEach(() => invoke.mockReset())

  it('keeps a typed backend error code and message', () => {
    const e = toPluginError({ code: 'git_failed', message: 'git: auth required' })
    expect(e).toBeInstanceOf(PluginError)
    expect(e.code).toBe('git_failed')
    expect(e.message).toBe('git: auth required')
  })

  it('maps unknown codes, bare strings and empty values to "unknown"', () => {
    expect(toPluginError({ code: 'made_up', message: 'x' }).code).toBe('unknown')
    expect(toPluginError('plain failure')).toMatchObject({
      code: 'unknown',
      message: 'plain failure',
    })
    expect(toPluginError(new Error('boom'))).toMatchObject({
      code: 'unknown',
      message: 'boom',
    })
    expect(toPluginError(undefined).message).toBe('Unknown error')
  })

  it('turns an error into per-code actionable text carrying the detail', () => {
    const t = vi.fn((key: string, vars?: Record<string, unknown>) =>
      `${key}|${vars?.detail}`
    )
    expect(
      pluginErrorText(t, { code: 'source_not_found', message: 'folder does not exist: /x' })
    ).toBe('plugins:errors.source_not_found|folder does not exist: /x')
    expect(pluginErrorText(t, 'odd')).toBe('plugins:errors.unknown|odd')
  })

  it('passes the typed source and install id, and rejects with a PluginError', async () => {
    invoke.mockRejectedValueOnce({ code: 'cancelled', message: 'install cancelled' })
    const promise = installPlugin('/project', { kind: 'git', url: 'https://h/r' }, 'id-1')
    await expect(promise).rejects.toBeInstanceOf(PluginError)
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    expect(invoke).toHaveBeenCalledWith('agent_plugin_install', {
      project: '/project',
      source: { kind: 'git', url: 'https://h/r' },
      operationId: 'id-1',
    })
  })

  it('wraps the other commands with their argument names', async () => {
    invoke.mockResolvedValue([])
    await listPlugins('/p')
    expect(invoke).toHaveBeenLastCalledWith('agent_plugin_list', { project: '/p' })
    invoke.mockResolvedValue({ id: 'a', enabled: false })
    await setPluginEnabled('/p', 'a', false)
    expect(invoke).toHaveBeenLastCalledWith('agent_plugin_set_enabled', {
      project: '/p',
      id: 'a',
      enabled: false,
    })
    invoke.mockResolvedValue(true)
    await expect(cancelPluginInstall('id-9')).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('agent_plugin_install_cancel', {
      operationId: 'id-9',
    })
  })

  it('validates git URLs and reports the host they contact', () => {
    expect(checkGitUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(checkGitUrl('https://github.com/acme/tools')).toEqual({
      ok: true,
      host: 'github.com',
    })
    expect(checkGitUrl('git@gitlab.example.org:team/plugin.git')).toEqual({
      ok: true,
      host: 'gitlab.example.org',
    })
    expect(checkGitUrl('ssh://git@host.local/r.git')).toEqual({
      ok: true,
      host: 'host.local',
    })
    for (const bad of [
      'not a url',
      'ftp://host/repo',
      'https://host',
      'https://host/r;rm -rf ~',
      'C:\\plugins\\mine',
    ]) {
      expect(checkGitUrl(bad).ok, bad).toBe(false)
    }
  })
})

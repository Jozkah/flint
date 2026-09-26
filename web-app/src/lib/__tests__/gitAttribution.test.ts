import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  DEFAULT_ATTRIBUTION_SETTINGS,
  attributeGitInput,
  getAttributionSettings,
} from '../gitAttribution'

describe('gitAttribution', () => {
  beforeEach(() => {
    invoke.mockReset()
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('asks the backend to rewrite the parsed call, with the run model', async () => {
    const rewritten = { args: ['commit', '-m', 'Fix\n\nCo-Authored-By: Flint (m) <x>'] }
    invoke.mockResolvedValue(rewritten)
    const out = await attributeGitInput(
      JSON.stringify({ args: ['commit', '-m', 'Fix'] }),
      'm',
      '/repo'
    )
    expect(out).toEqual(rewritten)
    expect(invoke).toHaveBeenCalledWith('attribute_git_call', {
      input: { args: ['commit', '-m', 'Fix'] },
      model: 'm',
      base: '/repo',
    })
  })

  it('leaves the call as written when the backend fails or the input is not an object', async () => {
    invoke.mockRejectedValue(new Error('no'))
    const input = { args: ['commit', '-m', 'Fix'] }
    expect(await attributeGitInput(input, undefined)).toBe(input)
    expect(await attributeGitInput('not json', 'm')).toBe('not json')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('defaults both switches on outside the desktop', async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    expect(await getAttributionSettings()).toEqual(DEFAULT_ATTRIBUTION_SETTINGS)
    expect(DEFAULT_ATTRIBUTION_SETTINGS).toEqual({ commits: true, pullRequests: true })
  })
})

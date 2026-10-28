/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useApiKeyDrafts } from '../useApiKeyDrafts'

const setup = (overrides: Record<string, unknown> = {}) => {
  const updateSettings = vi.fn()
  const deleteProviderKeys = vi.fn()
  const updateProvider = vi.fn()
  const provider: any = {
    provider: 'openai',
    active: false,
    api_key: 'sk-a',
    api_key_fallbacks: [],
    base_url: 'https://api.openai.com/v1',
    models: [],
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-a', type: 'password' },
      },
    ],
    ...overrides,
  }
  const serviceHub: any = {
    providers: () => ({ updateSettings, deleteProviderKeys }),
  }
  const hook = renderHook(() =>
    useApiKeyDrafts({
      provider,
      providerName: 'openai',
      serviceHub,
      updateProvider,
    })
  )
  return { hook, updateSettings, deleteProviderKeys, updateProvider }
}

describe('useApiKeyDrafts', () => {
  it('commits a changed primary key with the fallbacks after it', () => {
    const { hook, updateProvider, updateSettings } = setup()
    act(() => hook.result.current.setApiKeysDraft('sk-new\nsk-spare'))
    act(() => hook.result.current.commitApiKeysDraft())
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const patch = updateProvider.mock.calls[0][1]
    expect(patch.api_key).toBe('sk-new')
    expect(patch.api_key_fallbacks).toEqual(['sk-spare'])
  })

  it('emits nothing when the draft equals what is stored', () => {
    const { hook, updateProvider } = setup()
    act(() => hook.result.current.setApiKeysDraft('sk-a'))
    act(() => hook.result.current.commitApiKeysDraft())
    expect(updateProvider).not.toHaveBeenCalled()
  })

  it('switches a built-in provider on when it gets its first key', () => {
    const { hook, updateProvider } = setup({ api_key: '' })
    act(() => hook.result.current.setApiKeysDraft('sk-first'))
    act(() => hook.result.current.commitApiKeysDraft())
    expect(updateProvider.mock.calls[0][1].active).toBe(true)
  })

  it('purges the stored keys when every line is cleared', () => {
    const { hook, deleteProviderKeys } = setup()
    act(() => hook.result.current.setApiKeysDraft(''))
    act(() => hook.result.current.commitApiKeysDraft())
    expect(deleteProviderKeys).toHaveBeenCalledWith('openai')
  })

  it('edits, adds and removes lines, never removing the primary line', () => {
    const { hook } = setup()
    act(() => hook.result.current.setApiKeysDraft('one\ntwo'))
    act(() => hook.result.current.setKeyAtIndex(1, '  three  '))
    expect(hook.result.current.advancedApiKeyLines).toEqual(['one', 'three'])
    act(() => hook.result.current.addKeyLine())
    expect(hook.result.current.advancedApiKeyLines).toEqual(['one', 'three', ''])
    act(() => hook.result.current.removeKeyLine(0))
    expect(hook.result.current.advancedApiKeyLines).toEqual(['one', 'three', ''])
    act(() => hook.result.current.removeKeyLine(1))
    expect(hook.result.current.advancedApiKeyLines).toEqual(['one', ''])
  })

  it('edits only the primary line through the single-key field', () => {
    const { hook } = setup()
    act(() => hook.result.current.setApiKeysDraft('one\ntwo'))
    act(() => hook.result.current.setPrimaryKeyDraft('uno'))
    expect(hook.result.current.primaryKeyDraft).toBe('uno')
    expect(hook.result.current.advancedApiKeyLines).toEqual(['uno', 'two'])
  })

  it('commits a changed base URL of an editable endpoint', () => {
    const { hook, updateProvider } = setup()
    act(() => hook.result.current.setBaseUrlDraft('  https://proxy.example/v1 '))
    act(() => hook.result.current.commitBaseUrlDraft())
    expect(updateProvider.mock.calls[0][1].base_url).toBe(
      'https://proxy.example/v1'
    )
  })
})

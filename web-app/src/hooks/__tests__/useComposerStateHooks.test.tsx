import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const h = vi.hoisted(() => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  tauri: false,
  provider: {
    provider: 'openai',
    models: [{ id: 'm', capabilities: [] as string[] }],
  },
  updateProvider: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  i18n: { t: (k: string) => k },
}))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => h.tauri }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: unknown) => unknown) =>
    sel({
      getProviderByName: (name: string) =>
        name === 'openai' ? h.provider : undefined,
      updateProvider: h.updateProvider,
    }),
}))

import { useModelCapabilityPrompt } from '../useModelCapabilityPrompt'
import { usePathOffer } from '../usePathOffer'

describe('useModelCapabilityPrompt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks, then enables the capability and continues', async () => {
    const { result } = renderHook(() =>
      useModelCapabilityPrompt({
        selectedModel: { id: 'm' },
        selectedProvider: 'openai',
      })
    )
    const onEnabled = vi.fn()
    act(() => result.current.requestCapabilities(['vision'], onEnabled))
    expect(result.current.capabilityPrompt?.capabilities).toEqual(['vision'])
    act(() => result.current.handleEnableCapabilities())
    expect(h.updateProvider).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({
        models: [
          expect.objectContaining({
            id: 'm',
            capabilities: expect.arrayContaining(['vision']),
          }),
        ],
      })
    )
    expect(onEnabled).toHaveBeenCalledTimes(1)
    expect(result.current.capabilityPrompt).toBeNull()
  })

  it('without a model nothing is asked', () => {
    const { result } = renderHook(() =>
      useModelCapabilityPrompt({ selectedModel: undefined, selectedProvider: 'openai' })
    )
    act(() => result.current.requestCapabilities(['audio'], vi.fn()))
    expect(result.current.capabilityPrompt).toBeNull()
  })

  it('an unknown provider says the model is unavailable and keeps asking', () => {
    const { result } = renderHook(() =>
      useModelCapabilityPrompt({ selectedModel: { id: 'm' }, selectedProvider: 'gone' })
    )
    const onEnabled = vi.fn()
    act(() => result.current.requestCapabilities(['video'], onEnabled))
    act(() => result.current.handleEnableCapabilities())
    expect(h.toast.error).toHaveBeenCalledWith('sweep:chat.modelUnavailable')
    expect(onEnabled).not.toHaveBeenCalled()
    expect(result.current.capabilityPrompt).not.toBeNull()
  })
})

describe('usePathOffer', () => {
  beforeEach(() => vi.clearAllMocks())

  const setup = (initial = { key: 'k1', streaming: false }) => {
    const setPrompt = vi.fn()
    const insertText = vi.fn()
    const attachFiles = vi.fn()
    const latestPromptRef = { current: 'draft ' }
    const richComposerRef = { current: { insertText } as never }
    const hook = renderHook(
      ({ key, streaming }) =>
        usePathOffer({
          attachmentsKey: key,
          isStreaming: streaming,
          richComposerRef,
          latestPromptRef,
          setPrompt,
          attachFiles,
          attachDroppedDocuments: vi.fn(async () => {}),
          focusComposer: vi.fn(),
        }),
      { initialProps: initial }
    )
    return { ...hook, setPrompt, insertText, attachFiles }
  }

  it('declining puts the held-back text into the composer', () => {
    const { result, insertText } = setup()
    act(() =>
      result.current.setPathOffer({ path: '/a', kind: 'file', raw: 'file:///a' })
    )
    act(() => result.current.declinePathOffer())
    expect(insertText).toHaveBeenCalledWith('file:///a')
    expect(result.current.pathOffer).toBeNull()
  })

  it('the offer ends with a switch to another conversation', () => {
    const { result, rerender } = setup()
    act(() => result.current.setPathOffer({ path: '/a', kind: 'file' }))
    rerender({ key: 'k2', streaming: false })
    expect(result.current.pathOffer).toBeNull()
  })

  it('a send that starts streaming declines the offer, keeping its text', () => {
    const { result, rerender, insertText } = setup()
    act(() =>
      result.current.setPathOffer({ path: '/a', kind: 'file', raw: 'x' })
    )
    rerender({ key: 'k1', streaming: true })
    expect(insertText).toHaveBeenCalledWith('x')
    expect(result.current.pathOffer).toBeNull()
  })

  it('a pasted path is only offered in the desktop app', async () => {
    const { result } = setup()
    await act(() => result.current.offerPastedPath('/etc/hosts'))
    expect(result.current.pathOffer).toBeNull()
  })
})

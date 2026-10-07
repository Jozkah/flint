import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'

type VoiceState = {
  status: 'idle' | 'starting' | 'listening' | 'stopping'
  pending: number
  error: null
  needsSetup: boolean
  clearError: () => void
  clearSetup: () => void
}

const voice = vi.hoisted(() => {
  const state = {
    status: 'idle',
    pending: 0,
    error: null,
    needsSetup: false,
    clearError: () => {},
    clearSetup: () => {},
  } as VoiceState
  const listeners = new Set<() => void>()
  return {
    state,
    listeners,
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    cancelDictation: vi.fn(),
  }
})

vi.mock('@/hooks/useVoiceInput', async () => {
  const React = await import('react')
  const useVoiceInput = Object.assign(
    <T,>(selector: (s: VoiceState) => T): T => {
      const [, force] = React.useReducer((n: number) => n + 1, 0)
      React.useEffect(() => {
        voice.listeners.add(force)
        return () => void voice.listeners.delete(force)
      }, [])
      return selector(voice.state)
    },
    { getState: () => voice.state }
  )
  return {
    useVoiceInput,
    startDictation: voice.startDictation,
    stopDictation: voice.stopDictation,
    cancelDictation: voice.cancelDictation,
    voiceInputSupported: () => true,
    voiceLevel: () => 0,
  }
})

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown[] }) => unknown) =>
    sel({
      providers: [
        { provider: 'llamacpp', models: [{ id: 'voice-model-test' }] },
      ],
    }),
}))
vi.mock('@/lib/voice/voiceModel', () => ({
  VOICE_MODEL_ID: 'voice-model-test',
}))
vi.mock('@/containers/VoiceSetupDialog', () => ({
  VoiceSetupDialog: () => null,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k.split('.').pop() }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { VoiceInputButton } from '../VoiceInputButton'

class TestPointerEvent extends MouseEvent {
  pointerId: number
  isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? false
  }
}
vi.stubGlobal('PointerEvent', TestPointerEvent)

const composer = { getValue: () => '', apply: vi.fn(), caret: () => 0 }
const ptr = { pointerId: 1, isPrimary: true, button: 0, clientX: 100 }

const setStatus = (status: VoiceState['status']) =>
  act(() => {
    voice.state.status = status
    voice.listeners.forEach((l) => l())
  })

describe('VoiceInputButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    voice.state.status = 'idle'
    voice.state.pending = 0
    voice.startDictation.mockReset()
    voice.stopDictation.mockReset()
    voice.cancelDictation.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const mount = () => render(<VoiceInputButton composer={composer as never} />)
  const button = () =>
    document.querySelector<HTMLElement>('[data-test-id="voice-input-button"]')!

  it('exposes the same labels and test id', () => {
    mount()
    expect(button()).toHaveAttribute('aria-label', 'Dictate')
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    setStatus('listening')
    expect(button()).toHaveAttribute('aria-label', 'Stop dictating')
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    setStatus('stopping')
    expect(button()).toHaveAttribute('aria-label', 'Working…')
  })

  it('tap starts, second tap stops and keeps the text', () => {
    mount()
    fireEvent.pointerDown(button(), ptr)
    fireEvent.pointerUp(button(), ptr)
    expect(voice.startDictation).toHaveBeenCalledWith(composer)
    setStatus('listening')
    fireEvent.pointerDown(button(), ptr)
    fireEvent.pointerUp(button(), ptr)
    expect(voice.stopDictation).toHaveBeenCalledTimes(1)
    expect(voice.cancelDictation).not.toHaveBeenCalledTimes(2)
  })

  it('hold records while held and stops on release', () => {
    mount()
    fireEvent.pointerDown(button(), ptr)
    setStatus('listening')
    act(() => void vi.advanceTimersByTime(500))
    fireEvent.pointerUp(button(), ptr)
    expect(voice.stopDictation).toHaveBeenCalledTimes(1)
  })

  it('dragging left cancels the dictation', () => {
    mount()
    fireEvent.pointerDown(button(), ptr)
    setStatus('listening')
    fireEvent.pointerMove(button(), { ...ptr, clientX: 20 })
    expect(voice.cancelDictation).toHaveBeenCalled()
    expect(voice.stopDictation).not.toHaveBeenCalled()
  })

  it('Escape cancels while listening', () => {
    mount()
    voice.cancelDictation.mockClear()
    setStatus('listening')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(voice.cancelDictation).toHaveBeenCalledTimes(1)
  })

  it('cancels when the screen is left', () => {
    const { unmount } = mount()
    voice.cancelDictation.mockClear()
    unmount()
    expect(voice.cancelDictation).toHaveBeenCalledTimes(1)
  })
})

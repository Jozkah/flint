import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const h = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn() },
  prepareAudioFiles: vi.fn(),
  prepareVideoFiles: vi.fn(),
  open: vi.fn(),
  tauri: false,
}))

vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  i18n: { t: (k: string) => k },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ dialog: () => ({ open: h.open }) }),
}))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => h.tauri }))
vi.mock('@/lib/attachmentIntake', async (orig) => ({
  ...(await orig<typeof import('@/lib/attachmentIntake')>()),
  prepareAudioFiles: h.prepareAudioFiles,
  prepareVideoFiles: h.prepareVideoFiles,
}))

import { useMediaAttachments } from '../useMediaAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'

const KEY = 'thread-1'
const audio = (name: string) => ({ type: 'audio' as const, name, dataUrl: 'd', base64: 'b' })

describe('useMediaAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.tauri = false
    useChatAttachments.getState().clearAttachments(KEY)
  })

  const setup = () => {
    const setMessage = vi.fn()
    const focusComposer = vi.fn()
    const { result } = renderHook(() =>
      useMediaAttachments({ attachmentsKey: KEY, setMessage, focusComposer })
    )
    return { result, setMessage, focusComposer }
  }

  it('adds new audio, warns about duplicates by name', async () => {
    useChatAttachments.getState().setAttachments(KEY, [audio('a.wav') as never])
    h.prepareAudioFiles.mockResolvedValue({
      prepared: [audio('a.wav'), audio('b.wav')],
      invalid: [],
      oversized: [],
    })
    const { result, setMessage } = setup()
    await act(() => result.current.audio.process([]))
    const names = useChatAttachments
      .getState()
      .getAttachments(KEY)
      .map((a) => a.name)
    expect(names).toEqual(['a.wav', 'b.wav'])
    expect(h.toast.warning).toHaveBeenCalledWith(
      'chat:composer.dupAudio',
      expect.anything()
    )
    expect(setMessage).not.toHaveBeenCalled()
  })

  it('reports rejected video files through setMessage', async () => {
    h.prepareVideoFiles.mockResolvedValue({
      prepared: [],
      invalid: ['x.exe'],
      oversized: [],
    })
    const { result, setMessage } = setup()
    await act(() => result.current.video.process([]))
    expect(setMessage).toHaveBeenCalledTimes(1)
    expect(setMessage.mock.calls[0][0]).toBe('chat:composer.videoInvalid')
  })

  it('outside the desktop app the picker clicks the hidden input', async () => {
    const { result } = setup()
    const input = document.createElement('input')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    const ref = result.current.audio.inputRef as { current: HTMLInputElement }
    ref.current = input
    await act(() => result.current.audio.openPicker())
    expect(click).toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })

  it('in the desktop app a cancelled dialog adds nothing and refocuses', async () => {
    h.tauri = true
    h.open.mockResolvedValue(null)
    const { result, focusComposer } = setup()
    await act(() => result.current.video.openPicker())
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true })
    )
    expect(h.prepareVideoFiles).not.toHaveBeenCalled()
    expect(focusComposer).toHaveBeenCalled()
  })

  it('input change processes the files and refocuses', async () => {
    h.prepareAudioFiles.mockResolvedValue({ prepared: [], invalid: [], oversized: [] })
    const { result, focusComposer } = setup()
    const file = new File(['x'], 'c.wav', { type: 'audio/wav' })
    act(() =>
      result.current.audio.onInputChange({
        target: { files: [file] },
      } as unknown as React.ChangeEvent<HTMLInputElement>)
    )
    expect(h.prepareAudioFiles).toHaveBeenCalledWith([file])
    expect(focusComposer).toHaveBeenCalled()
  })
})

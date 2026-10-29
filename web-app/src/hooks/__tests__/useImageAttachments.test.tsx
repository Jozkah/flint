import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn() },
  prepareImageFiles: vi.fn(),
  ingestImage: vi.fn(),
  checkMmprojExists: vi.fn(),
  open: vi.fn(),
  tauri: false,
}))

vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  i18n: { t: (k: string) => k },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    dialog: () => ({ open: h.open }),
    models: () => ({ checkMmprojExists: h.checkMmprojExists }),
    uploads: () => ({ ingestImage: h.ingestImage }),
  }),
}))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => h.tauri }))
vi.mock('@/lib/imageResize', () => ({
  fitImageFileToLimit: async (f: File) => f,
}))
vi.mock('@/lib/attachmentIntake', async (orig) => ({
  ...(await orig<typeof import('@/lib/attachmentIntake')>()),
  prepareImageFiles: h.prepareImageFiles,
}))

import { useImageAttachments } from '../useImageAttachments'
import { useChatAttachments } from '@/hooks/useChatAttachments'

const KEY = 'thread-1'
const png = (name: string) => new File(['png'], name, { type: 'image/png' })
const prepared = (name: string) => ({
  type: 'image' as const,
  name,
  dataUrl: `data:image/png;base64,${btoa(name)}`,
  mimeType: 'image/png',
  size: 3,
})

function setup(capabilities: string[] = ['vision'], threadId = KEY) {
  const setMessage = vi.fn()
  const focusComposer = vi.fn()
  const enableCapabilities = vi.fn(() => true)
  const { result } = renderHook(() =>
    useImageAttachments({
      attachmentsKey: KEY,
      currentThreadId: threadId,
      selectedModel: { id: 'm', capabilities },
      selectedProvider: 'openai',
      maxFileSizeMB: undefined,
      setMessage,
      focusComposer,
      enableCapabilities,
    })
  )
  return { result, setMessage, focusComposer, enableCapabilities }
}

const names = () =>
  useChatAttachments
    .getState()
    .getAttachments(KEY)
    .map((a) => a.name)

describe('useImageAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.tauri = false
    useChatAttachments.getState().clearAttachments(KEY)
    h.prepareImageFiles.mockImplementation(async (files: File[]) => ({
      prepared: files.map((f) => prepared(f.name)),
      unreadable: [],
    }))
    h.ingestImage.mockResolvedValue({ id: 'up-1' })
  })

  it('attaches an image and ingests it for the thread', async () => {
    const { result, setMessage } = setup()
    await act(() => result.current.processImageFiles([png('a.png')]))
    expect(names()).toEqual(['a.png'])
    expect(setMessage).toHaveBeenCalledWith('')
    await waitFor(() =>
      expect(useChatAttachments.getState().getAttachments(KEY)[0]).toMatchObject(
        { id: 'up-1', processed: true }
      )
    )
    expect(h.ingestImage).toHaveBeenCalledWith(KEY, expect.objectContaining({ name: 'a.png' }))
  })

  it('without a thread the image is attached but not ingested', async () => {
    const { result } = setup(['vision'], '')
    await act(() => result.current.processImageFiles([png('a.png')]))
    expect(names()).toEqual(['a.png'])
    expect(h.ingestImage).not.toHaveBeenCalled()
  })

  it('reads a text file as an inline document, not an image', async () => {
    const { result } = setup()
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await act(() => result.current.processImageFiles([txt]))
    const [doc] = useChatAttachments.getState().getAttachments(KEY)
    expect(doc).toMatchObject({
      type: 'document',
      name: 'notes.txt',
      inlineContent: 'hello',
      injectionMode: 'inline',
    })
    expect(h.ingestImage).not.toHaveBeenCalled()
  })

  it('asks first when the model cannot see, and cancel attaches nothing', async () => {
    const { result } = setup([])
    await act(() => result.current.processImageFiles([png('a.png')]))
    expect(result.current.visionPrompt).toMatchObject({ canEnable: true })
    expect(names()).toEqual([])
    await act(() => result.current.handleVisionChoice('cancel'))
    expect(result.current.visionPrompt).toBeNull()
    expect(names()).toEqual([])
  })

  it('enabling vision turns it on and attaches the held batch', async () => {
    const { result, enableCapabilities } = setup([])
    await act(() => result.current.processImageFiles([png('a.png')]))
    await act(() => result.current.handleVisionChoice('enable'))
    expect(enableCapabilities).toHaveBeenCalledWith(['vision'])
    expect(names()).toEqual(['a.png'])
  })

  it('warns about a duplicate image instead of adding it twice', async () => {
    const { result } = setup()
    await act(() => result.current.processImageFiles([png('a.png')]))
    await act(() => result.current.processImageFiles([png('a.png')]))
    expect(names()).toEqual(['a.png'])
    expect(h.toast.warning).toHaveBeenCalledWith(
      'chat:composer.dupImages',
      expect.anything()
    )
  })

  it('attachFiles processes the files and refocuses', async () => {
    const { result, focusComposer } = setup()
    act(() => result.current.attachFiles([png('b.png')]))
    expect(focusComposer).toHaveBeenCalled()
    await waitFor(() => expect(names()).toEqual(['b.png']))
  })

  it('outside the desktop app the picker clicks the hidden input', async () => {
    const { result } = setup()
    const input = document.createElement('input')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    const ref = result.current.fileInputRef as { current: HTMLInputElement }
    ref.current = input
    await act(() => result.current.openImagePicker())
    expect(click).toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
  })
})

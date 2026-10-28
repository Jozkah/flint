import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatPaneDropZone } from '../ChatPaneDropZone'
import { unsupportedDropFiles } from '@/hooks/useChatPaneDrop'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const file = (name: string, type = '') =>
  new File(['x'], name, { type })

const transfer = (files: File[]) => ({ files, types: ['Files'] })

function setup() {
  const composerDrop = vi.fn()
  const codeDrop = vi.fn()
  render(
    <ChatPaneDropZone>
      <div data-testid="messages">
        <p data-testid="nested">hello</p>
      </div>
      <div
        data-testid="code-drop-zone"
        onDrop={(e) => {
          e.stopPropagation()
          codeDrop(Array.from(e.dataTransfer.files))
        }}
      >
        <span data-testid="code-inner">code</span>
      </div>
      <div
        data-drop-zone="true"
        data-testid="composer"
        onDrop={(e) => {
          e.stopPropagation()
          composerDrop(Array.from(e.dataTransfer.files))
        }}
      />
    </ChatPaneDropZone>
  )
  return { composerDrop, codeDrop }
}

const overlay = () => screen.queryByTestId('chat-pane-drop-overlay')

describe('ChatPaneDropZone', () => {
  beforeEach(() => toastError.mockReset())

  it('attaches a drop outside the composer through the composer', () => {
    const { composerDrop } = setup()
    const f = file('notes.txt', 'text/plain')
    fireEvent.drop(screen.getByTestId('messages'), { dataTransfer: transfer([f]) })
    expect(composerDrop).toHaveBeenCalledTimes(1)
    expect(composerDrop.mock.calls[0][0].map((x: File) => x.name)).toEqual(['notes.txt'])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('leaves a drop on the code panel to the code panel', () => {
    const { composerDrop, codeDrop } = setup()
    fireEvent.drop(screen.getByTestId('code-inner'), {
      dataTransfer: transfer([file('a.ts', 'text/plain')]),
    })
    expect(codeDrop).toHaveBeenCalledTimes(1)
    expect(composerDrop).not.toHaveBeenCalled()
  })

  it('explains an unsupported file type with a toast and attaches the rest', () => {
    const { composerDrop } = setup()
    fireEvent.drop(screen.getByTestId('messages'), {
      dataTransfer: transfer([file('setup.exe', 'application/x-msdownload'), file('a.txt', 'text/plain')]),
    })
    expect(toastError).toHaveBeenCalledWith('common:chatPaneDrop.unsupported')
    expect(composerDrop.mock.calls[0][0].map((x: File) => x.name)).toEqual(['a.txt'])
  })

  it('does not reach the composer when every file is unsupported', () => {
    const { composerDrop } = setup()
    fireEvent.drop(screen.getByTestId('messages'), {
      dataTransfer: transfer([file('setup.exe', 'application/x-msdownload')]),
    })
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(composerDrop).not.toHaveBeenCalled()
  })

  it('shows the overlay while dragging and survives nested dragleave', () => {
    setup()
    const dt = transfer([])
    const messages = screen.getByTestId('messages')
    const nested = screen.getByTestId('nested')
    fireEvent.dragEnter(messages, { dataTransfer: dt })
    expect(overlay()).not.toBeNull()
    // Into a child: enter fires on the child before leave fires on the parent.
    fireEvent.dragEnter(nested, { dataTransfer: dt })
    fireEvent.dragLeave(messages, { dataTransfer: dt })
    expect(overlay()).not.toBeNull()
    fireEvent.dragLeave(nested, { dataTransfer: dt })
    expect(overlay()).toBeNull()
  })

  it('hides the overlay over the code panel and after a drop', () => {
    setup()
    const dt = transfer([])
    fireEvent.dragEnter(screen.getByTestId('code-inner'), { dataTransfer: dt })
    expect(overlay()).toBeNull()
    fireEvent.dragOver(screen.getByTestId('messages'), { dataTransfer: dt })
    expect(overlay()).not.toBeNull()
    fireEvent.drop(screen.getByTestId('messages'), { dataTransfer: transfer([]) })
    expect(overlay()).toBeNull()
  })

  it('ignores drags that carry no files', () => {
    setup()
    fireEvent.dragEnter(screen.getByTestId('messages'), {
      dataTransfer: { files: [], types: ['text/plain'] },
    })
    expect(overlay()).toBeNull()
  })
})

describe('unsupportedDropFiles', () => {
  it('keeps text, images and documents, flags binaries, leaves folders', () => {
    const out = unsupportedDropFiles([
      file('a.png', 'image/png'),
      file('b.pdf', 'application/pdf'),
      file('c.py'),
      file('d.exe', 'application/x-msdownload'),
      new File([], 'folder'),
    ])
    expect(out.map((f) => f.name)).toEqual(['d.exe'])
  })
})

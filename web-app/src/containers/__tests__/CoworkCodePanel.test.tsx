import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

const convertFileSrc = vi.fn((p: string) => `asset://${p}`)
const getJanDataFolder = vi.fn(async () => DATA_FOLDER)
const hub = {
  app: () => ({ getJanDataFolder }),
  core: () => ({ convertFileSrc }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub,
  getServiceHub: () => hub,
}))

// The real highlighter loads every bundled grammar; the viewer only needs to
// have produced *some* markup for these tests.
vi.mock('shiki', () => ({
  codeToHtml: vi.fn(async (c: string) => `<pre>${c}</pre>`),
}))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(),
  projectReadFile: vi.fn(),
}))

import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { CoworkCodePanel } from '../CoworkCodePanel'
import { emptyCodePanelState, type CodePanelState } from '@/lib/coworkCode'

const listDir = vi.mocked(projectListDir)
const readFile = vi.mocked(projectReadFile)

const DATA_FOLDER = '/mock/jan/data'
const ROOT = '/home/dev/project'

const dirEntry = (name: string) => ({ name, relPath: name, isDir: true })
const fileEntry = (name: string) => ({ name, relPath: name, isDir: false })
const listing = (...entries: ReturnType<typeof fileEntry>[]) => ({
  entries,
  truncated: false,
})
const projectFile = (over: Partial<ReturnType<typeof baseFile>> = {}) => ({
  ...baseFile(),
  ...over,
})
const baseFile = () => ({
  relPath: 'app.ts',
  size: 12,
  content: '',
  oversized: false,
  binary: false,
})

/** The panel is controlled; this keeps the state its callbacks produce so a
 * click behaves the way it does in the app. */
function Harness({
  folder = ROOT as string | null,
  initial = emptyCodePanelState(),
  onStateChange,
  onAttach = vi.fn(),
}: {
  folder?: string | null
  initial?: CodePanelState
  onStateChange?: (next: CodePanelState) => void
  onAttach?: () => void
}) {
  const [state, setState] = useState(initial)
  return (
    <CoworkCodePanel
      folder={folder}
      workspacePath={null}
      state={state}
      onStateChange={(next) => {
        onStateChange?.(next)
        setState(next)
      }}
      onAddToChat={vi.fn()}
      onAttach={onAttach}
      onClose={vi.fn()}
    />
  )
}

/** Open `name` from the explorer, re-showing the explorer when a previous
 * open collapsed it. */
const openFromExplorer = async (name: string) => {
  if (!screen.queryByTestId('code-explorer')) {
    await userEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.explorer' })
    )
  }
  await userEvent.click(await screen.findByRole('button', { name }))
}

describe('CoworkCodePanel', () => {
  beforeEach(() => {
    getJanDataFolder.mockResolvedValue(DATA_FOLDER)
    listDir.mockResolvedValue(listing())
    readFile.mockResolvedValue(projectFile())
  })

  it('offers to attach a project instead of an empty tree', async () => {
    const onAttach = vi.fn()
    render(<Harness folder={null} onAttach={onAttach} />)

    const attach = screen.getByRole('button', {
      name: 'common:codePanel.attachProject',
    })
    expect(screen.getByText('common:codePanel.noProject')).toBeInTheDocument()

    await userEvent.click(attach)
    expect(onAttach).toHaveBeenCalledTimes(1)
    expect(listDir).not.toHaveBeenCalled()
  })

  it('shows a loading line until the root listing arrives, then lists it directories-first', async () => {
    let release!: () => void
    listDir.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(listing(dirEntry('src'), fileEntry('app.ts')))
      })
    )
    render(<Harness />)

    expect(screen.getByText('common:codePanel.loading')).toBeInTheDocument()

    release()
    await screen.findByRole('button', { name: 'app.ts' })
    const explorer = screen.getByTestId('code-explorer')
    expect(
      within(explorer)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['src', 'app.ts'])
    expect(listDir).toHaveBeenCalledWith(DATA_FOLDER, ROOT, '')
  })

  it('surfaces a refused listing rather than an empty folder', async () => {
    listDir.mockRejectedValue(new Error('Permission denied (os error 13)'))
    render(<Harness />)

    expect(
      await screen.findByText('Permission denied (os error 13)')
    ).toBeInTheDocument()
    expect(screen.queryByText('common:codePanel.emptyDir')).toBeNull()
  })

  it('shows a permission refusal as its own state, not raw OS text', async () => {
    // The backend marks a denial with `DENIED:` so the panel can say "you may
    // not read this" instead of showing platform-specific errno prose, which
    // reads to a user as a crash.
    listDir.mockRejectedValue(new Error('DENIED: locked'))
    render(<Harness />)

    expect(
      await screen.findByText('common:codePanel.denied')
    ).toBeInTheDocument()
    expect(screen.queryByText(/DENIED/)).toBeNull()
    expect(screen.queryByText('common:codePanel.emptyDir')).toBeNull()
  })

  it('offers a retry on an ordinary listing failure', async () => {
    listDir.mockRejectedValueOnce(new Error('I/O error'))
    render(<Harness />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'common:codePanel.retry' })
    )

    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2))
  })

  it('shows a refused file read as a permission state too', async () => {
    listDir.mockResolvedValue(listing(fileEntry('locked.ts')))
    readFile.mockRejectedValue(new Error('DENIED: locked.ts'))
    render(<Harness />)

    await openFromExplorer('locked.ts')

    expect(
      await screen.findByText('common:codePanel.denied')
    ).toBeInTheDocument()
  })

  it('opens a source file in a tab and reports the new state', async () => {
    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
    readFile.mockResolvedValue(
      projectFile({ content: 'export const answer = 42' })
    )
    const onStateChange = vi.fn()
    render(<Harness onStateChange={onStateChange} />)

    await openFromExplorer('app.ts')

    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ openPaths: ['app.ts'], activePath: 'app.ts' })
    )
    expect(await screen.findByTestId('code-viewer-body')).toHaveTextContent(
      'export const answer = 42'
    )
    expect(readFile).toHaveBeenCalledWith(DATA_FOLDER, ROOT, 'app.ts', false)
  })

  it('focuses the existing tab when the same file is opened again', async () => {
    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
    const onStateChange = vi.fn()
    render(<Harness onStateChange={onStateChange} />)

    await openFromExplorer('app.ts')
    await openFromExplorer('app.ts')

    expect(screen.getAllByRole('tab')).toHaveLength(1)
    const last = onStateChange.mock.lastCall?.[0] as CodePanelState
    expect(last.openPaths).toEqual(['app.ts'])
  })

  it('drops a closed tab from the reported state', async () => {
    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
    const onStateChange = vi.fn()
    render(<Harness onStateChange={onStateChange} />)

    await openFromExplorer('app.ts')
    await userEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.closeTab#app.ts' })
    )

    const last = onStateChange.mock.lastCall?.[0] as CodePanelState
    expect(last.openPaths).toEqual([])
    expect(last.activePath).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('declines to render a file too large for the viewer', async () => {
    listDir.mockResolvedValue(listing(fileEntry('huge.ts')))
    readFile.mockResolvedValue(
      projectFile({ relPath: 'huge.ts', size: 2 * 1024 * 1024, oversized: true })
    )
    render(<Harness />)

    await openFromExplorer('huge.ts')

    expect(
      await screen.findByText('common:codePanel.tooLarge#2.0 MB')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('code-viewer-body')).toBeNull()
  })

  it('says a binary file cannot be displayed', async () => {
    listDir.mockResolvedValue(listing(fileEntry('blob.json')))
    readFile.mockResolvedValue(
      projectFile({ relPath: 'blob.json', binary: true })
    )
    render(<Harness />)

    await openFromExplorer('blob.json')

    expect(
      await screen.findByText('common:codePanel.binary')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('code-viewer-body')).toBeNull()
  })

  // The backend refuses credentials by default; the user can still insist, and
  // only then does the read carry the override.
  it('holds back a sensitive file until the user opens it anyway', async () => {
    listDir.mockResolvedValue(listing(fileEntry('secrets.json')))
    readFile.mockImplementation(
      async (_data, _root, rel, allowSensitive?: boolean) => {
        if (!allowSensitive) throw new Error(`SENSITIVE: ${rel}`)
        return projectFile({ relPath: rel, content: '{"token":"hunter2"}' })
      }
    )
    render(<Harness />)

    await openFromExplorer('secrets.json')

    expect(
      await screen.findByText('common:codePanel.sensitive')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('code-viewer-body')).toBeNull()

    await userEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.openAnyway' })
    )

    expect(readFile).toHaveBeenLastCalledWith(
      DATA_FOLDER,
      ROOT,
      'secrets.json',
      true
    )
    expect(await screen.findByTestId('code-viewer-body')).toHaveTextContent(
      'hunter2'
    )
  })

  it('reports a failed read and offers to close the dead tab', async () => {
    listDir.mockResolvedValue(listing(fileEntry('gone.ts')))
    readFile.mockRejectedValue(
      new Error('No such file or directory (os error 2)')
    )
    const onStateChange = vi.fn()
    render(<Harness onStateChange={onStateChange} />)

    await openFromExplorer('gone.ts')

    expect(
      await screen.findByText('No such file or directory (os error 2)')
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.closeMissing' })
    )

    const last = onStateChange.mock.lastCall?.[0] as CodePanelState
    expect(last.openPaths).toEqual([])
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import {
  emptyCodePanelState,
  openTab,
  projectKeyOf,
  projectTab,
  tabId,
  type CodePanelState,
} from '@/lib/coworkCode'
import type { CoworkTurn } from '@/types/coworkSession'

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
  turns,
  onStateChange,
  onAttach = vi.fn(),
}: {
  folder?: string | null
  initial?: CodePanelState
  turns?: CoworkTurn[]
  onStateChange?: (next: CodePanelState) => void
  onAttach?: () => void
}) {
  const [state, setState] = useState(initial)
  return (
    <CoworkCodePanel
      folder={folder}
      workspacePath={null}
      state={state}
      turns={turns}
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

    const opened = onStateChange.mock.lastCall?.[0] as CodePanelState
    expect(opened.tabs.map((t) => t.path)).toEqual(['app.ts'])
    expect(opened.activeTabId).toBe(tabId(projectTab('app.ts', projectKeyOf(ROOT)!)))
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
    expect(last.tabs.map((t) => t.path)).toEqual(['app.ts'])
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
    expect(last.tabs).toEqual([])
    expect(last.activeTabId).toBeNull()
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
    expect(last.tabs).toEqual([])
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})

describe('CoworkCodePanel — an open file the agent rewrites', () => {
  const wrote = (path: string): CoworkTurn => ({
    role: 'tool',
    content: '',
    name: 'write',
    callId: `w-${path}`,
    args: { path },
    result: `Created ${path} (12 bytes)`,
    status: 'done',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
  })

  it('says nothing while the file is untouched', async () => {
    readFile.mockResolvedValue(projectFile({ content: 'first' }))
    render(<Harness turns={[]} />)
    await openFromExplorer('app.ts')

    expect((await screen.findAllByText('first')).length).toBeGreaterThan(0)
    expect(
      screen.queryByText('common:codePanel.stale')
    ).not.toBeInTheDocument()
  })

  it('marks the tab stale, and reload replaces the content', async () => {
    readFile.mockResolvedValue(projectFile({ content: 'first' }))
    const { rerender } = render(<Harness turns={[]} initial={openTab(emptyCodePanelState(), projectTab('app.ts', projectKeyOf(ROOT)!))} />)

    expect((await screen.findAllByText('first')).length).toBeGreaterThan(0)

    // The agent writes the file that is open.
    readFile.mockResolvedValue(projectFile({ content: 'second' }))
    rerender(
      <Harness
        turns={[wrote('app.ts')]}
        initial={openTab(emptyCodePanelState(), projectTab('app.ts', projectKeyOf(ROOT)!))}
      />
    )

    // Announced, not swapped: the old bytes are still on screen.
    expect(await screen.findByText('common:codePanel.stale')).toBeInTheDocument()
    expect(screen.getAllByText('first').length).toBeGreaterThan(0)

    await userEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.reload' })
    )

    expect((await screen.findAllByText('second')).length).toBeGreaterThan(0)
    await waitFor(() =>
      expect(
        screen.queryByText('common:codePanel.stale')
      ).not.toBeInTheDocument()
    )
  })

  it('ignores writes to other files', async () => {
    readFile.mockResolvedValue(projectFile({ content: 'first' }))
    render(
      <Harness
        turns={[wrote('elsewhere.ts')]}
        initial={openTab(emptyCodePanelState(), projectTab('app.ts', projectKeyOf(ROOT)!))}
      />
    )

    expect((await screen.findAllByText('first')).length).toBeGreaterThan(0)
    expect(
      screen.queryByText('common:codePanel.stale')
    ).not.toBeInTheDocument()
  })
})


describe('CoworkCodePanel — project detach and switching', () => {
  const OTHER = '/home/dev/other-project'
  // `mockReturnValueOnce` queues survive `clearAllMocks`, so a value queued by
  // one case can be handed to the next. Reset the implementations outright.
  afterEach(() => {
    listDir.mockReset()
    readFile.mockReset()
  })
  const tabIn = (root: string, path = 'app.ts') =>
    projectTab(path, projectKeyOf(root)!)
  const stateWith = (root: string, path = 'app.ts'): CodePanelState =>
    openTab(emptyCodePanelState(), tabIn(root, path))

  beforeEach(() => {
    vi.clearAllMocks()
    getJanDataFolder.mockResolvedValue(DATA_FOLDER)
    listDir.mockResolvedValue(listing(fileEntry('app.ts')))
    readFile.mockResolvedValue(projectFile({ content: 'from A' }))
  })

  it('does not leave a tab spinning forever when the project is detached', async () => {
    // Regression: the reset effect emptied the file cache, the active-tab
    // effect re-fired, set {status:'loading'} and then returned early on
    // !folder — so the tab showed a spinner nothing would ever resolve.
    const { rerender } = render(<Harness initial={stateWith(ROOT)} />)
    expect((await screen.findAllByText('from A')).length).toBeGreaterThan(0)

    rerender(<Harness folder={null} initial={stateWith(ROOT)} />)

    expect(
      await screen.findByText('common:codePanel.detached')
    ).toBeInTheDocument()
    expect(screen.queryByText('common:codePanel.loading')).toBeNull()
  })

  it('ignores a read that resolves after the project was detached', async () => {
    let release!: (v: ReturnType<typeof projectFile>) => void
    readFile.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const { rerender } = render(<Harness initial={stateWith(ROOT)} />)
    // The read must actually be in flight before detaching, or the pending
    // promise is never the one under test.
    await waitFor(() =>
      expect(readFile).toHaveBeenCalledWith(DATA_FOLDER, ROOT, 'app.ts', false)
    )

    rerender(<Harness folder={null} initial={stateWith(ROOT)} />)
    release(projectFile({ content: 'stale bytes from A' }))

    expect(
      await screen.findByText('common:codePanel.detached')
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText('stale bytes from A')).toBeNull()
    )
  })

  it('never resolves project A’s path against project B', async () => {
    const onStateChange = vi.fn()
    const { rerender } = render(
      <Harness initial={stateWith(ROOT)} onStateChange={onStateChange} />
    )
    expect((await screen.findAllByText('from A')).length).toBeGreaterThan(0)

    // Switching projects: the store prunes A's tabs, so the panel is given a
    // state that contains none of them.
    readFile.mockResolvedValue(projectFile({ content: 'from B' }))
    rerender(<Harness folder={OTHER} initial={emptyCodePanelState()} />)

    await waitFor(() =>
      expect(listDir).toHaveBeenCalledWith(DATA_FOLDER, OTHER, '')
    )
    // A's bytes are gone, and no read was ever issued for A's path against B.
    await waitFor(() => expect(screen.queryByText('from A')).toBeNull())
    for (const call of readFile.mock.calls) {
      if (call[1] === OTHER) expect(call[2]).not.toBe('app.ts')
    }
  })

  it('drops a listing that arrives from the previous project', async () => {
    let releaseA!: (v: ReturnType<typeof listing>) => void
    listDir.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseA = resolve
      })
    )
    const { rerender } = render(<Harness initial={emptyCodePanelState()} />)
    // Wait for A's listing to actually be in flight. The roots resolve
    // asynchronously, so rerendering before this would hand the pending
    // promise to B's request instead and prove nothing.
    await waitFor(() =>
      expect(listDir).toHaveBeenCalledWith(DATA_FOLDER, ROOT, '')
    )

    listDir.mockResolvedValue(listing(fileEntry('only-in-b.ts')))
    rerender(<Harness folder={OTHER} initial={emptyCodePanelState()} />)
    await waitFor(() =>
      expect(listDir).toHaveBeenCalledWith(DATA_FOLDER, OTHER, '')
    )
    // Only now does A's listing land, naming a file that exists only in A.
    releaseA(listing(fileEntry('only-in-a.ts')))

    expect(
      await screen.findByRole('button', { name: 'only-in-b.ts' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'only-in-a.ts' })).toBeNull()
    )
  })

  it('keeps a workspace tab across a project switch', async () => {
    // A sandbox file belongs to the session, not the project, so switching
    // projects must not close it.
    const sandboxState = openTab(emptyCodePanelState(), {
      path: 'out.ts',
      origin: { kind: 'sandbox' },
    })
    render(<Harness folder={OTHER} initial={sandboxState} />)
    expect(await screen.findAllByRole('tab')).toHaveLength(1)
  })
})

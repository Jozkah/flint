import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))

const convertFileSrc = vi.fn((p: string) => `asset://${p}`)
const getJanDataFolder = vi.fn(async () => DATA_FOLDER)
const invoke = vi.fn(async () => {})
const hub = {
  app: () => ({ getJanDataFolder }),
  core: () => ({ convertFileSrc, invoke }),
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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(),
  projectReadFile: vi.fn(),
}))

import {
  projectListDir,
  projectReadFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { toast } from 'sonner'
import { CoworkCodePanel } from '../CoworkCodePanel'
import {
  emptyCodePanelState,
  openTab,
  externalTab,
  projectKeyOf,
  projectTab,
  sandboxTab,
  tabId,
  type CodePanelState,
} from '@/lib/coworkCode'
import type { CoworkTurn } from '@/types/coworkSession'

const listDir = vi.mocked(projectListDir)
const readFile = vi.mocked(projectReadFile)

// Sandbox and artifact tabs stream off disk through the asset protocol, the
// way the preview pane reads them, so those reads go through `fetch`.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const textResponse = (content: string) =>
  ({
    ok: true,
    headers: { get: () => String(content.length) },
    text: async () => content,
  }) as unknown as Response

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
  workspacePath = null,
  sessionKey = 'session-a',
  onStateChange,
  onAttach = vi.fn(),
}: {
  folder?: string | null
  initial?: CodePanelState
  turns?: CoworkTurn[]
  workspacePath?: string | null
  sessionKey?: string | null
  onStateChange?: (next: CodePanelState) => void
  onAttach?: () => void
}) {
  const [state, setState] = useState(initial)
  // The route keeps one panel mounted and hands it the new session's stored
  // state, so a session switch re-seeds rather than remounts. Reproduce that:
  // remounting would hide the very races these tests exist to catch.
  const lastSession = useRef(sessionKey)
  if (lastSession.current !== sessionKey) {
    lastSession.current = sessionKey
    setState(initial)
  }
  return (
    <CoworkCodePanel
      folder={folder}
      workspacePath={workspacePath}
      sessionKey={sessionKey}
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

  it('shows the head of an oversized project file instead of an empty notice', async () => {
    listDir.mockResolvedValue(listing(fileEntry('big.txt')))
    readFile.mockResolvedValue(
      projectFile({
        size: 3_600_000,
        oversized: true,
        preview: 'first line of the big file\n',
      })
    )
    render(<Harness />)
    await openFromExplorer('big.txt')

    expect(await screen.findByTestId('code-oversized-preview')).toHaveTextContent(
      'first line of the big file'
    )
    expect(
      screen.getByText('common:codePanel.openExternallyPreview')
    ).toBeInTheDocument()
  })

  it('does not claim a preview is shown when the oversized file has none', async () => {
    listDir.mockResolvedValue(listing(fileEntry('big.bin')))
    readFile.mockResolvedValue(projectFile({ size: 9_000_000, oversized: true }))
    render(<Harness />)
    await openFromExplorer('big.bin')

    expect(
      await screen.findByText('common:codePanel.openExternally')
    ).toBeInTheDocument()
    expect(screen.queryByText('common:codePanel.openExternallyPreview')).toBeNull()
    expect(screen.queryByTestId('code-oversized-preview')).toBeNull()
  })

  it('opens a non-source file from the tree and says it is binary, with an open-externally action', async () => {
    listDir.mockResolvedValue(listing(fileEntry('data.bin')))
    readFile.mockResolvedValue(projectFile({ binary: true, size: 4 }))
    invoke.mockClear()
    render(<Harness />)

    const row = await screen.findByRole('button', { name: 'data.bin' })
    expect(row).not.toBeDisabled()
    await userEvent.click(row)

    expect(await screen.findByTestId('code-binary-notice')).toHaveTextContent(
      'common:codePanel.binary'
    )
    await userEvent.click(screen.getByTestId('code-open-external'))
    expect(invoke).toHaveBeenCalledWith('open_session_path', {
      roots: [ROOT],
      path: `${ROOT}/data.bin`,
      mode: 'open',
    })
  })

  it('reports a failed read and offers to close the dead tab', async () => {
    listDir.mockResolvedValue(listing(fileEntry('gone.ts')))
    readFile.mockRejectedValue(
      new Error('No such file or directory (os error 2)')
    )
    const onStateChange = vi.fn()
    render(<Harness onStateChange={onStateChange} />)

    await openFromExplorer('gone.ts')

    // A friendly sentence, not the OS error; the technical text is kept in a
    // tooltip.
    const missing = await screen.findByTestId('code-missing-notice')
    expect(missing).toHaveTextContent('common:codePanel.fileMissing#gone.ts')
    expect(missing).toHaveAttribute(
      'title',
      'No such file or directory (os error 2)'
    )
    expect(screen.queryByText(/os error 2/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'common:codePanel.retry' })
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


describe('CoworkCodePanel — session isolation', () => {
  const WS_A = '/data/agent-workspace/sessions/session-a'
  const WS_B = '/data/agent-workspace/sessions/session-b'
  const SAME_PATH = 'notes.ts'

  /** A promise whose resolution this test controls. */
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  const sandboxState = (sessionKey: string) =>
    openTab(emptyCodePanelState(), sandboxTab(SAME_PATH, sessionKey))

  beforeEach(() => {
    vi.clearAllMocks()
    getJanDataFolder.mockResolvedValue(DATA_FOLDER)
    listDir.mockResolvedValue(listing())
  })
  afterEach(() => {
    listDir.mockReset()
    readFile.mockReset()
    fetchMock.mockReset()
  })

  it('drops a sandbox read from session A that resolves after switching to B', async () => {
    // Sandbox files are read through the asset protocol, not the project
    // commands, so this path had no generation guard at all.
    const a = deferred<Response>()
    fetchMock.mockReturnValueOnce(a.promise as unknown as Promise<Response>)

    const { rerender } = render(
      <Harness
        folder={null}
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // Switch to session B, whose own sandbox read resolves first.
    fetchMock.mockResolvedValue(textResponse('bytes from B'))
    rerender(
      <Harness
        folder={null}
        workspacePath={WS_B}
        sessionKey="session-b"
        initial={sandboxState('session-b')}
      />
    )
    expect((await screen.findAllByText('bytes from B')).length).toBeGreaterThan(0)

    // A's read lands late and must be discarded. Drain it first: asserting
    // before the response has been read through would pass on any build.
    a.resolve(textResponse('bytes from A'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText('bytes from A')).toBeNull()
    expect((await screen.findAllByText('bytes from B')).length).toBeGreaterThan(
      0
    )
  })

  it('keeps the same relative sandbox path distinct between sessions', () => {
    // Both sessions have `notes.ts` in their own workspace; sharing a cache
    // key would show one session's bytes in the other.
    expect(tabId(sandboxTab(SAME_PATH, 'session-a'))).not.toBe(
      tabId(sandboxTab(SAME_PATH, 'session-b'))
    )
  })

  it('does not read a sandbox tab against another session’s workspace', async () => {
    // Session B is active, but a tab belonging to A is somehow present: it must
    // not be read, because its path is relative to A's directory.
    render(
      <Harness
        folder={null}
        workspacePath={WS_B}
        sessionKey="session-b"
        initial={sandboxState('session-a')}
      />
    )
    await waitFor(() =>
      expect(screen.getByText('common:codePanel.detached')).toBeInTheDocument()
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads nothing while the workspace lookup for this session is pending', async () => {
    // The route clears workspacePath on a session change; until the new one
    // resolves there is no root, and nothing may be read against the old one.
    render(
      <Harness
        folder={null}
        workspacePath={null}
        sessionKey="session-b"
        initial={sandboxState('session-b')}
      />
    )
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
    expect(screen.queryByText('common:codePanel.detached')).toBeNull()
  })

  it('says a missing sandbox file is missing instead of a bare 404', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, headers: { get: () => '0' } })
    render(
      <Harness
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    expect(
      (await screen.findAllByText(/common:codePanel\.fileMissing/)).length
    ).toBeGreaterThan(0)
  })

  it('refuses a binary sandbox file', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => '3' },
      text: async () => 'ab c',
    })
    render(
      <Harness
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    // The panel re-reads once the data folder resolves, which swaps the
    // notice's node; assert on what is on screen when it settles.
    await waitFor(() =>
      expect(screen.getByText('common:codePanel.binary')).toBeInTheDocument()
    )
  })

  it('shows a too-large sandbox file as a notice, not content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => String(50 * 1024 * 1024) },
      text: async () => 'never read',
    })
    render(
      <Harness
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    await waitFor(() =>
      expect(
        screen.queryAllByText('common:codePanel.openExternally').length
      ).toBeGreaterThan(0)
    )
    expect(screen.queryByText('never read')).toBeNull()
  })

  it('keeps this session’s sandbox tabs when the project changes', async () => {
    // A project switch inside one session must not disturb session-owned tabs.
    fetchMock.mockResolvedValue(textResponse('workspace bytes'))
    const { rerender } = render(
      <Harness
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    expect(
      (await screen.findAllByText('workspace bytes')).length
    ).toBeGreaterThan(0)

    rerender(
      <Harness
        folder="/home/dev/other-project"
        workspacePath={WS_A}
        sessionKey="session-a"
        initial={sandboxState('session-a')}
      />
    )
    expect(await screen.findAllByRole('tab')).toHaveLength(1)
    expect(
      (await screen.findAllByText('workspace bytes')).length
    ).toBeGreaterThan(0)
  })
})

describe('CoworkCodePanel — external files', () => {
  const SESSION_A = 'session-a'
  const SESSION_B = 'session-b'
  const WS_A = '/data/agent-workspace/sessions/session-a'

  /**
   * A file the way the browser hands one over: bytes plus a name, with the
   * snapshot semantics that matter here. `size` is overridable so the
   * oversize path can be exercised without allocating a megabyte.
   */
  const pickedFile = (
    name: string,
    content: string | Uint8Array,
    over: { size?: number; unreadable?: boolean } = {}
  ) => {
    const file = new File([content as BlobPart], name)
    if (over.size !== undefined) {
      Object.defineProperty(file, 'size', { value: over.size })
    }
    if (over.unreadable) {
      // What a browser does when the file moved or permission was revoked
      // between selection and read.
      Object.defineProperty(file, 'text', {
        value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
      })
    }
    return file
  }

  const pick = async (...files: File[]) =>
    userEvent.upload(screen.getByTestId('code-file-picker'), files)

  const externalState = (name: string, sessionKey: string) =>
    openTab(emptyCodePanelState(), externalTab(name, sessionKey))

  const errorKeys = () =>
    vi.mocked(toast.error).mock.calls.map((c) => String(c[0]))

  beforeEach(() => {
    vi.clearAllMocks()
    getJanDataFolder.mockResolvedValue(DATA_FOLDER)
    listDir.mockResolvedValue(listing())
    readFile.mockResolvedValue(projectFile())
  })
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('opens a picked file as its own tab and shows its bytes', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    await pick(pickedFile('notes.ts', 'export const a = 1'))

    expect(await screen.findByTestId('code-viewer-body')).toHaveTextContent(
      'export const a = 1'
    )
  })

  it('opens every file of a multi-file selection as its own tab', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    await pick(
      pickedFile('a.ts', 'const a = 1'),
      pickedFile('b.ts', 'const b = 2'),
      pickedFile('c.ts', 'const c = 3')
    )

    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3))
    const names = screen.getAllByRole('tab').map((t) => t.textContent ?? '')
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      expect(names.some((n) => n.includes(name))).toBe(true)
    }
  })

  it('refuses a credentials file without opening a tab', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    await pick(pickedFile('.env', 'TOKEN=hunter2'))

    expect(errorKeys().join()).toContain('codePanel.sensitiveRefused')
    expect(screen.queryByTestId('code-viewer-body')).not.toBeInTheDocument()
    expect(screen.queryByText('TOKEN=hunter2')).not.toBeInTheDocument()
  })

  it('refuses a binary renamed to a text extension', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await pick(pickedFile('image.ts', png))

    expect(errorKeys().join()).toContain('codePanel.binaryRefused')
    expect(screen.queryByTestId('code-viewer-body')).not.toBeInTheDocument()
  })

  it('refuses a file too large to open, before reading it', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    await pick(pickedFile('big.ts', 'x', { size: 4 * 1024 * 1024 }))

    expect(errorKeys().join()).toContain('codePanel.tooLargeToOpen')
    expect(screen.queryByTestId('code-viewer-body')).not.toBeInTheDocument()
  })

  it('reports a file that cannot be read and opens no tab', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    await pick(pickedFile('gone.ts', 'never read', { unreadable: true }))

    expect(errorKeys().join()).toContain('codePanel.unreadable')
    expect(screen.queryByTestId('code-viewer-body')).not.toBeInTheDocument()
  })

  it('offers re-selection rather than a reload it cannot perform', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)
    await pick(pickedFile('notes.ts', 'first'))
    await screen.findByTestId('code-viewer-body')

    // The banner offers "Choose again". It must not offer "Reload": the
    // handle is a snapshot and cannot produce newer bytes.
    expect(
      screen.getByRole('button', { name: 'common:codePanel.chooseAgainAction' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'common:codePanel.reload' })
    ).not.toBeInTheDocument()
  })

  it('replaces the content when the same name is chosen again', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)
    await pick(pickedFile('notes.ts', 'first'))
    expect(await screen.findByTestId('code-viewer-body')).toHaveTextContent(
      'first'
    )

    // The same name selected from somewhere else: one tab, new bytes.
    await pick(pickedFile('notes.ts', 'second'))

    await waitFor(() =>
      expect(screen.getByTestId('code-viewer-body')).toHaveTextContent('second')
    )
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('keeps the old content when the replacement is sensitive', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)
    await pick(pickedFile('notes.ts', 'safe content'))
    await screen.findByTestId('code-viewer-body')

    await pick(pickedFile('.env', 'TOKEN=hunter2'))

    expect(errorKeys().join()).toContain('codePanel.sensitiveRefused')
    expect(screen.getByTestId('code-viewer-body')).toHaveTextContent(
      'safe content'
    )
    expect(screen.queryByText('TOKEN=hunter2')).not.toBeInTheDocument()
  })

  it('keeps the old content when the replacement turns binary', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)
    await pick(pickedFile('notes.ts', 'safe content'))
    await screen.findByTestId('code-viewer-body')

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
    await pick(pickedFile('notes.ts', png))

    expect(errorKeys().join()).toContain('codePanel.binaryRefused')
    expect(screen.getByTestId('code-viewer-body')).toHaveTextContent(
      'safe content'
    )
  })

  it('does not read an external tab against the workspace after a restart', async () => {
    // Tab metadata is persisted; the handle is memory only. Nothing may be
    // read here — resolving the bare name against the session workspace
    // would open a different file that happens to share it.
    render(
      <Harness
        sessionKey={SESSION_A}
        workspacePath={WS_A}
        initial={externalState('notes.ts', SESSION_A)}
      />
    )

    // `findByText` returns the node that is actually mounted; asserting
    // attachment separately races the re-render that resolving the roots
    // causes, and tests the harness rather than the panel.
    expect(
      await screen.findByText('common:codePanel.externalGone')
    ).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'common:codePanel.chooseAgainAction' })
    ).toBeInTheDocument()
  })

  it('never shows one session’s picked file under another', async () => {
    const { rerender } = render(
      <Harness sessionKey={SESSION_A} workspacePath={WS_A} />
    )
    await pick(pickedFile('notes.ts', 'session A bytes'))
    await screen.findByTestId('code-viewer-body')

    // Switching sessions re-seeds the panel with B's stored state, which
    // happens to carry a tab for the same file name stamped to A.
    rerender(
      <Harness
        sessionKey={SESSION_B}
        workspacePath="/data/agent-workspace/sessions/session-b"
        initial={externalState('notes.ts', SESSION_A)}
      />
    )

    await waitFor(() =>
      expect(screen.queryByText('session A bytes')).not.toBeInTheDocument()
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives the same file name a different tab in each session', () => {
    expect(tabId(externalTab('notes.ts', SESSION_A))).not.toBe(
      tabId(externalTab('notes.ts', SESSION_B))
    )
  })

  it('settles on the last selection when two reads resolve out of order', async () => {
    render(<Harness sessionKey={SESSION_A} workspacePath={WS_A} />)

    // The first selection's read finishes after the second's.
    let releaseFirst!: (value: string) => void
    const slow = new File(['ignored'], 'notes.ts')
    Object.defineProperty(slow, 'text', {
      value: () => new Promise<string>((r) => (releaseFirst = r)),
    })

    await pick(slow)
    await pick(pickedFile('notes.ts', 'second'))
    await waitFor(() =>
      expect(screen.getByTestId('code-viewer-body')).toHaveTextContent('second')
    )

    await act(async () => {
      releaseFirst('first')
    })

    // The stale read must not overwrite the newer content.
    expect(screen.getByTestId('code-viewer-body')).toHaveTextContent('second')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })
})

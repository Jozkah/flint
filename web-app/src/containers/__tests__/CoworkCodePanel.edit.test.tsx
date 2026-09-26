import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
vi.mock('shiki', () => ({
  codeToHtml: vi.fn(async (c: string) => `<pre>${c}</pre>`),
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectListDir: vi.fn(async () => ({ entries: [], truncated: false })),
  projectReadFile: vi.fn(),
}))
// CodeMirror needs layout jsdom does not have; the panel's contract with the
// editor is value in, text out and Ctrl+S, which a textarea stands in for.
vi.mock('@/components/CodeEditor', () => ({
  default: ({
    value,
    onChange,
    onSave,
    ariaLabel,
  }: {
    value: string
    onChange: (t: string) => void
    onSave: () => void
    ariaLabel: string
  }) => (
    <textarea
      aria-label={`editor ${ariaLabel}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 's' && e.ctrlKey) onSave()
      }}
    />
  ),
}))

import { projectReadFile } from '@janhq/tauri-plugin-agent-tools-api'
import { CoworkCodePanel } from '../CoworkCodePanel'
import {
  emptyCodePanelState,
  openTab,
  projectKeyOf,
  projectTab,
  sandboxTab,
  tabId,
  type CodePanelState,
} from '@/lib/coworkCode'
import type { EditAccess } from '@/lib/coworkCodeEdit'
import type { SaveUserEdit } from '@/lib/coworkCodeSave'
import { useCodeBuffers, useCoworkUserEdits } from '@/hooks/useCoworkUserEdits'

const readFile = vi.mocked(projectReadFile)
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const DATA_FOLDER = '/mock/jan/data'
const ROOT = '/home/dev/project'
const SESSION = 'session-a'
const KEY = projectKeyOf(ROOT) as string

const fileOf = (content: string) => ({
  relPath: 'app.ts',
  size: content.length,
  content,
  oversized: false,
  binary: false,
})

function Harness({
  initial,
  access,
  saveFile,
  workspacePath = '/ws/session-a',
}: {
  initial: CodePanelState
  access: EditAccess | null
  saveFile: SaveUserEdit
  workspacePath?: string
}) {
  const [state, setState] = useState(initial)
  return (
    <CoworkCodePanel
      folder={ROOT}
      workspacePath={workspacePath}
      sessionKey={SESSION}
      state={state}
      onStateChange={setState}
      onAddToChat={vi.fn()}
      onAttach={vi.fn()}
      onClose={vi.fn()}
      editAccess={access}
      readRoot={ROOT}
      saveFile={saveFile}
    />
  )
}

const withTab = (tab = projectTab('app.ts', KEY)) =>
  openTab(emptyCodePanelState(), tab)

const repository: EditAccess = { destination: 'repository', writeGrant: 'grant-1' }
const reviewOnly: EditAccess = { destination: 'sandbox', writeGrant: null }

beforeEach(() => {
  readFile.mockReset()
  fetchMock.mockReset()
  useCodeBuffers.setState({ bySession: {} })
  useCoworkUserEdits.setState({ bySession: {} })
})

/**
 * The editor once the panel has settled: the data folder resolves after the
 * first render and re-reads the open file, which remounts the editor.
 */
async function settled(label: string) {
  await screen.findByLabelText(label)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return screen.findByLabelText(label)
}
const editor = () => settled('editor app.ts')

describe('editing in the Code panel', () => {
  it('saves to the real file with the grant when the session edits the folder', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    const saveFile = vi.fn<SaveUserEdit>(async () => ({ ok: true, diff: '- one\n+ two' }))
    render(<Harness initial={withTab()} access={repository} saveFile={saveFile} />)

    const box = await editor()
    expect(screen.getByTestId('code-edit-badge')).toHaveTextContent(
      'common:codePanel.editing'
    )
    fireEvent.change(box, { target: { value: 'two' } })
    // Dirty: the tab shows the unsaved dot.
    expect(screen.getByTestId('tab-dirty')).toBeInTheDocument()

    fireEvent.keyDown(box, { key: 's', ctrlKey: true })
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    expect(saveFile.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION,
      content: 'two',
      target: { kind: 'real', path: `${ROOT}/app.ts`, grant: 'grant-1' },
      readRoot: ROOT,
    })
    await waitFor(() => expect(screen.queryByTestId('tab-dirty')).toBeNull())
    // Recorded as the user's edit, pending for the agent's next turn.
    const edits = useCoworkUserEdits.getState().bySession[SESSION]
    expect(edits.edits).toHaveLength(1)
    expect(edits.pending[0]).toMatchObject({ path: 'app.ts', where: 'real' })
  })

  it('saves Review only edits to the sandbox copy and says so', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    const saveFile = vi.fn<SaveUserEdit>(async () => ({ ok: true }))
    render(<Harness initial={withTab()} access={reviewOnly} saveFile={saveFile} />)

    const box = await editor()
    expect(screen.getByTestId('code-edit-badge')).toHaveTextContent(
      'common:codePanel.editingSandbox'
    )
    fireEvent.change(box, { target: { value: 'two' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.save' }))
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    expect(saveFile.mock.calls[0][0].target).toEqual({
      kind: 'sandbox',
      path: 'app.ts',
    })
  })

  it('keeps a real-tree mode read-only, with the reason, when no grant backs it', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    render(
      <Harness
        initial={withTab()}
        access={{ destination: 'repository', writeGrant: null }}
        saveFile={vi.fn()}
      />
    )
    const badge = await screen.findByTestId('code-readonly-badge')
    expect(badge).toHaveAttribute(
      'title',
      'common:codePanel.readOnlyReason.no-grant'
    )
    expect(screen.queryByLabelText('editor app.ts')).toBeNull()
  })

  it('discards edits back to what was read', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    render(<Harness initial={withTab()} access={repository} saveFile={vi.fn()} />)
    const box = await editor()
    fireEvent.change(box, { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.discard' }))
    expect(await editor()).toHaveValue('one')
    expect(screen.queryByTestId('tab-dirty')).toBeNull()
  })

  it('asks before closing a dirty tab', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    render(<Harness initial={withTab()} access={repository} saveFile={vi.fn()} />)
    const box = await editor()
    fireEvent.change(box, { target: { value: 'changed' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.closeTabUnsaved#app.ts' })
    )
    // Still open, with the question asked.
    expect(screen.getByTestId('code-unsaved-close')).toBeInTheDocument()
    expect(screen.getByRole('tab')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.cancel' }))
    expect(screen.queryByTestId('code-unsaved-close')).toBeNull()
    expect(screen.getByRole('tab')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.closeTabUnsaved#app.ts' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.discardAndClose' })
    )
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('raises a conflict when the file changed on disk under unsaved edits', async () => {
    readFile.mockResolvedValueOnce(fileOf('one'))
    const saveFile = vi.fn<SaveUserEdit>(async () => ({ ok: true }))
    render(<Harness initial={withTab()} access={repository} saveFile={saveFile} />)
    const box = await editor()
    fireEvent.change(box, { target: { value: 'mine' } })

    // Someone else saved the file meanwhile.
    readFile.mockResolvedValue(fileOf('theirs'))
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.save' }))
    expect(await screen.findByTestId('code-conflict')).toBeInTheDocument()
    expect(saveFile).not.toHaveBeenCalled()

    // Reload takes the disk version and drops the edits.
    fireEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.conflictReload' })
    )
    expect(await editor()).toHaveValue('theirs')
    expect(screen.queryByTestId('code-conflict')).toBeNull()
  })

  it('overwrites on request after a conflict', async () => {
    readFile.mockResolvedValueOnce(fileOf('one'))
    const saveFile = vi.fn<SaveUserEdit>(async () => ({ ok: true }))
    render(<Harness initial={withTab()} access={repository} saveFile={saveFile} />)
    const box = await editor()
    fireEvent.change(box, { target: { value: 'mine' } })
    readFile.mockResolvedValue(fileOf('theirs'))
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.save' }))
    await screen.findByTestId('code-conflict')
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'common:codePanel.conflictOverwrite' })
      )
    })
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    expect(saveFile.mock.calls[0][0].content).toBe('mine')
  })

  it('shows a save failure from the backend gate', async () => {
    readFile.mockResolvedValue(fileOf('one'))
    const saveFile = vi.fn<SaveUserEdit>(async () => ({
      ok: false,
      error: 'path is outside every allowed root',
    }))
    render(<Harness initial={withTab()} access={repository} saveFile={saveFile} />)
    const box = await editor()
    fireEvent.change(box, { target: { value: 'two' } })
    fireEvent.click(screen.getByRole('button', { name: 'common:codePanel.save' }))
    expect(
      await screen.findByText(
        'common:codePanel.saveFailed#path is outside every allowed root'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('tab-dirty')).toBeInTheDocument()
  })

  it('edits a sandbox file in the sandbox in every mode', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => '3' },
      text: async () => 'out',
    })
    const saveFile = vi.fn<SaveUserEdit>(async () => ({ ok: true }))
    const tab = sandboxTab('out.ts', SESSION)
    render(
      <Harness
        initial={openTab(emptyCodePanelState(), tab)}
        access={repository}
        saveFile={saveFile}
      />
    )
    const box = await settled('editor out.ts')
    expect(screen.getByTestId('code-edit-badge')).toHaveTextContent(
      'common:codePanel.editing'
    )
    fireEvent.change(box, { target: { value: 'new' } })
    // Saving re-reads the file first; the stub serves the same bytes.
    await act(async () => {
      fireEvent.keyDown(box, { key: 's', ctrlKey: true })
    })
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    expect(saveFile.mock.calls[0][0].target).toEqual({
      kind: 'sandbox',
      path: 'out.ts',
    })
    expect(tabId(tab)).toContain('sandbox')
  })
})

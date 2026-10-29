import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))
vi.mock('@/containers/CodeGitOverlays', () => ({
  CodeOverlayMenu: () => null,
  HunkPopover: ({
    title,
    actions,
    note,
  }: {
    title?: string
    actions?: { label: string; onSelect: () => void; testId: string }[]
    note?: React.ReactNode
  }) => (
    <div>
      <span>{title}</span>
      {actions?.map((a) => (
        <button key={a.testId} data-testid={a.testId} onClick={a.onSelect}>
          {a.label}
        </button>
      ))}
      <div data-testid="note">{note}</div>
    </div>
  ),
}))

import { CodeFileTree } from '../CodeFileTree'
import { CodeTabStrip } from '../CodeTabStrip'
import { CodeFileNotice } from '../CodeFileNotice'
import {
  ConflictBanner,
  StaleFileBanner,
  UnsavedCloseBanner,
} from '../CodePanelBanners'
import { CodeEditToolbar } from '../CodeEditToolbar'
import { SandboxPeekPopover } from '../SandboxPeekPopover'
import {
  emptyCodePanelState,
  openTab,
  projectTab,
  tabId,
} from '@/lib/coworkCode'
import type { DirState } from '@/lib/coworkCodeRead'
import type { ChangeHunk } from '@/lib/codeGutter'

const entry = (relPath: string, isDir = false) =>
  ({ name: relPath.split('/').pop(), relPath, isDir }) as never

describe('CodeFileTree', () => {
  const dirs = new Map<string, DirState>([
    ['', { status: 'ready', entries: [entry('src', true), entry('a.ts')], truncated: true }],
    ['src', { status: 'error', message: 'boom' }],
  ])
  const props = {
    rel: '',
    depth: 0,
    dirs,
    expandedDirs: ['src'],
    activeTabId: tabId(projectTab('a.ts', 'k')),
    projectKey: 'k',
    onToggleDir: vi.fn(),
    onOpenFile: vi.fn(),
    onRetry: vi.fn(),
  }

  it('renders folders, files, nested errors and the truncation note', () => {
    render(<CodeFileTree {...props} />)
    expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'a.ts' })).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByText('common:codePanel.truncated')).toBeInTheDocument()
  })

  it('routes toggles, opens and retries', () => {
    render(<CodeFileTree {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }))
    fireEvent.click(screen.getByText('common:codePanel.retry'))
    expect(props.onToggleDir).toHaveBeenCalledWith('src')
    expect(props.onOpenFile).toHaveBeenCalledWith('a.ts')
    expect(props.onRetry).toHaveBeenCalledWith('src')
  })

  it('shows loading for an unlisted folder', () => {
    render(<CodeFileTree {...props} dirs={new Map()} />)
    expect(screen.getByText('common:codePanel.loading')).toBeInTheDocument()
  })
})

describe('CodeTabStrip', () => {
  const a = projectTab('a.ts', 'k')
  const b = projectTab('b.ts', 'k')
  const state = openTab(openTab(emptyCodePanelState(), a), b)

  it('marks dirty tabs and closes through requestClose', () => {
    const requestClose = vi.fn()
    render(
      <CodeTabStrip
        state={state}
        buffers={{ [tabId(a)]: { base: 'x', text: 'y' } }}
        explorerOpen={false}
        onToggleExplorer={vi.fn()}
        onStateChange={vi.fn()}
        requestClose={requestClose}
      />
    )
    expect(screen.getAllByTestId('tab-dirty')).toHaveLength(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'common:codePanel.closeAll' })
    )
    expect(requestClose).toHaveBeenCalledWith(
      [tabId(a), tabId(b)],
      expect.objectContaining({ tabs: [] })
    )
  })

  it('arrow keys move focus between tabs', () => {
    const onStateChange = vi.fn()
    render(
      <CodeTabStrip
        state={state}
        buffers={{}}
        explorerOpen
        onToggleExplorer={vi.fn()}
        onStateChange={onStateChange}
        requestClose={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'ArrowLeft' })
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ activeTabId: tabId(a) })
    )
  })
})

describe('CodeFileNotice', () => {
  const handlers = () => ({
    onReload: vi.fn(),
    onCloseTab: vi.fn(),
    onAttach: vi.fn(),
    onChooseAgain: vi.fn(),
    onOpenExternally: vi.fn(),
  })

  it('offers Open anyway for a sensitive file', () => {
    const h = handlers()
    render(<CodeFileNotice file={{ status: 'sensitive' }} path="p" {...h} />)
    fireEvent.click(screen.getByText('common:codePanel.openAnyway'))
    expect(h.onReload).toHaveBeenCalledWith(true)
  })

  it('missing: retry and close', () => {
    const h = handlers()
    render(
      <CodeFileNotice file={{ status: 'missing', detail: 'gone' }} path="p.ts" {...h} />
    )
    expect(screen.getByTestId('code-missing-notice')).toHaveTextContent(
      'common:codePanel.fileMissing#p.ts'
    )
    fireEvent.click(screen.getByText('common:codePanel.retry'))
    fireEvent.click(screen.getByText('common:codePanel.closeMissing'))
    expect(h.onReload).toHaveBeenCalledWith()
    expect(h.onCloseTab).toHaveBeenCalled()
  })

  it('oversized shows size, preview and open externally', () => {
    const h = handlers()
    render(
      <CodeFileNotice
        file={{ status: 'oversized', size: 3 * 1024 * 1024, preview: 'head' }}
        path="p"
        {...h}
      />
    )
    expect(screen.getByText('common:codePanel.tooLarge#3.0 MB')).toBeInTheDocument()
    expect(screen.getByTestId('code-oversized-preview')).toHaveTextContent('head')
    fireEvent.click(screen.getByTestId('code-open-external'))
    expect(h.onOpenExternally).toHaveBeenCalled()
  })

  it('detached offers attach; external-gone offers choose again', () => {
    const h = handlers()
    const { rerender } = render(
      <CodeFileNotice file={{ status: 'detached' }} path="p" {...h} />
    )
    fireEvent.click(screen.getByText('common:codePanel.attachProject'))
    rerender(<CodeFileNotice file={{ status: 'external-gone' }} path="p" {...h} />)
    fireEvent.click(screen.getByText('common:codePanel.chooseAgainAction'))
    expect(h.onAttach).toHaveBeenCalled()
    expect(h.onChooseAgain).toHaveBeenCalled()
  })

  it('loading and error states', () => {
    const h = handlers()
    const { rerender } = render(<CodeFileNotice file={undefined} path="p" {...h} />)
    expect(screen.getByText('common:codePanel.loading')).toBeInTheDocument()
    rerender(<CodeFileNotice file={{ status: 'error', message: 'bad' }} path="p" {...h} />)
    expect(screen.getByText('bad')).toBeInTheDocument()
  })
})

describe('banners', () => {
  it('unsaved close: names one tab, counts many, save only when allowed', () => {
    const onChoose = vi.fn()
    const { rerender } = render(
      <UnsavedCloseBanner count={1} name="a.ts" canSave onChoose={onChoose} />
    )
    expect(screen.getByText('common:codePanel.unsavedOne#a.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common:codePanel.save'))
    expect(onChoose).toHaveBeenCalledWith('save')
    rerender(
      <UnsavedCloseBanner count={2} name="x" canSave={false} onChoose={onChoose} />
    )
    expect(screen.getByText('common:codePanel.unsavedMany#2')).toBeInTheDocument()
    expect(screen.queryByText('common:codePanel.save')).toBeNull()
  })

  it('conflict choices and stale reload', () => {
    const onResolve = vi.fn()
    const onReload = vi.fn()
    render(
      <>
        <ConflictBanner onResolve={onResolve} />
        <StaleFileBanner onReload={onReload} />
      </>
    )
    fireEvent.click(screen.getByText('common:codePanel.conflictKeep'))
    fireEvent.click(screen.getByText('common:codePanel.reload'))
    expect(onResolve).toHaveBeenCalledWith('keep')
    expect(onReload).toHaveBeenCalled()
  })
})

describe('CodeEditToolbar', () => {
  it('disables save and discard while clean, enables when dirty', () => {
    const props = {
      path: 'src/a.ts',
      savesToSandbox: true,
      saving: false,
      wordWrap: false,
      onToggleWrap: vi.fn(),
      showAgentCopy: false,
      onOpenAgentCopy: vi.fn(),
      onDiscard: vi.fn(),
      onSave: vi.fn(),
    }
    const { rerender } = render(<CodeEditToolbar {...props} dirty={false} />)
    expect(screen.getByTestId('code-edit-badge')).toHaveTextContent(
      'common:codePanel.editingSandbox'
    )
    expect(screen.getByText('common:codePanel.save')).toBeDisabled()
    rerender(<CodeEditToolbar {...props} dirty />)
    fireEvent.click(screen.getByText('common:codePanel.save'))
    expect(props.onSave).toHaveBeenCalled()
    expect(screen.queryByTestId('open-sandbox-copy')).toBeNull()
  })
})

describe('SandboxPeekPopover', () => {
  const hunk = { start: 3, kind: 'modified' } as unknown as ChangeHunk

  it('hides apply actions without handlers', () => {
    render(
      <SandboxPeekPopover
        hunk={hunk}
        path="a.ts"
        note={null}
        onOpenCopy={vi.fn()}
        onNote={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByTestId('peek-apply-hunk')).toBeNull()
    expect(screen.queryByTestId('peek-apply-whole')).toBeNull()
    expect(screen.getByTestId('peek-open-sandbox-copy')).toBeInTheDocument()
  })

  it('apply whole asks first, then applies and closes', () => {
    const onApplyWhole = vi.fn()
    const onClose = vi.fn()
    const onNote = vi.fn()
    const { rerender } = render(
      <SandboxPeekPopover
        hunk={hunk}
        path="a.ts"
        note={null}
        onOpenCopy={vi.fn()}
        onApplyWhole={onApplyWhole}
        onNote={onNote}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByTestId('peek-apply-whole'))
    expect(onNote).toHaveBeenCalledWith('confirm-whole')
    rerender(
      <SandboxPeekPopover
        hunk={hunk}
        path="a.ts"
        note="confirm-whole"
        onOpenCopy={vi.fn()}
        onApplyWhole={onApplyWhole}
        onNote={onNote}
        onClose={onClose}
      />
    )
    fireEvent.click(screen.getByTestId('peek-apply-whole-confirm'))
    expect(onApplyWhole).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('renders conflict and error notes', () => {
    const p = {
      hunk,
      path: 'a.ts',
      onOpenCopy: vi.fn(),
      onNote: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<SandboxPeekPopover {...p} note="conflict" />)
    expect(screen.getByTestId('note')).toHaveTextContent('common:codePanel.hunkConflict')
    rerender(<SandboxPeekPopover {...p} note={{ error: 'x' }} />)
    expect(screen.getByTestId('note')).toHaveTextContent('common:changes.applyFailed#x')
  })
})

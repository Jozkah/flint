import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TurnChangeCard } from '../TurnChangeCard'
import type { RoomTurnChanges } from '@/lib/rooms/types'

// Shiki's grammars are not loaded under jsdom; the rows render plain first anyway.
vi.mock('shiki', () => ({ codeToTokens: vi.fn(async () => ({ tokens: [] })) }))

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key)

const changes: RoomTurnChanges = {
  files: [{ path: 'b.ts', additions: 1, deletions: 0 }],
  workspace: 'C:/ws/p-a',
  cumulative: [
    { path: 'a.ts', additions: 3, deletions: 1 },
    { path: 'b.ts', additions: 1, deletions: 0 },
  ],
}
const actions = {
  patch: vi.fn(async () => ''),
  discard: vi.fn(async () => {}),
  apply: vi.fn(async () => 1),
  preview: vi.fn(async () => ({ patch: '', target: 'C:/p', clean: true, files: [], dirty: [] })),
  undo: vi.fn(async () => {}),
}

const open = () => fireEvent.click(screen.getAllByRole('button')[0])

describe('TurnChangeCard', () => {
  it('shows a Windows workspace path with one kind of separator', () => {
    render(
      <TurnChangeCard
        changes={{ ...changes, workspace: String.raw`C:\Users\x\flint/rooms/r1/p-a` }}
        actions={actions}
        t={t}
      />
    )
    open()
    const chip = screen.getByTestId('change-workspace')
    // A copyable chip: the full path is its tooltip and its accessible name.
    expect(chip).toHaveAttribute('title', String.raw`C:\Users\x\flint\rooms\r1\p-a`)
    expect(chip.getAttribute('aria-label')).toContain(
      JSON.stringify({ path: String.raw`C:\Users\x\flint\rooms\r1\p-a` })
    )
  })

  it('shows the workspace path without a trailing separator', () => {
    render(
      <TurnChangeCard changes={{ ...changes, workspace: 'C:\\ws\\296db525\\' }} actions={actions} t={t} />
    )
    open()
    expect(screen.getByTestId('change-workspace')).toHaveAttribute('title', String.raw`C:\ws\296db525`)
  })

  it('says Apply also takes earlier unapplied changes from the workspace', () => {
    render(<TurnChangeCard changes={changes} actions={actions} t={t} />)
    expect(screen.getByTestId('turn-changes-earlier').textContent).toBe(
      'rooms:changes.applyIncludesEarlier:{"count":1}'
    )
  })

  it('after applying some files the card still offers Apply for the rest, with Undo', async () => {
    const apply = vi.fn(async () => 1)
    const onDecision = vi.fn()
    const preview = vi.fn(async () => ({
      patch:
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n' +
        'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n',
      target: 'C:/p',
      clean: true,
      files: [],
      dirty: [],
    }))
    render(
      <TurnChangeCard changes={changes} actions={{ ...actions, apply, preview }} onDecision={onDecision} t={t} />
    )
    fireEvent.click(screen.getByTestId('turn-changes-apply'))
    await waitFor(() => expect(screen.getByTestId('apply-preflight').dataset.state).toBe('clean'))
    // Untick b.ts, apply a.ts only.
    fireEvent.click(screen.getByLabelText('rooms:apply.include:{"path":"b.ts"}'))
    fireEvent.click(screen.getByTestId('apply-confirm'))
    await waitFor(() => expect(apply).toHaveBeenCalledWith(['a.ts']))
    await waitFor(() => expect(screen.getByTestId('turn-changes-status').textContent).toContain('rooms:changes.partial'))
    expect(screen.getByTestId('turn-changes-apply')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'rooms:apply.undo' })).toBeTruthy()
    expect(onDecision).not.toHaveBeenCalledWith('applied')
  })

  it('drops git plumbing from an excerpt and keeps the hunk header as a row', () => {
    const excerpt =
      'diff --git a/README.md b/README.md\nindex e794c94..52c450e 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,5 @@\n # Calc\n+Tiny\n'
    render(
      <TurnChangeCard
        changes={{ files: [{ path: 'docs/README.md', additions: 1, deletions: 0, excerpt }] }}
        t={t}
      />
    )
    open()
    const diff = screen.getByTestId('change-excerpt')
    expect(diff.textContent).not.toContain('diff --git')
    expect(diff.textContent).not.toContain('+++')
    expect(diff.textContent).toContain('@@ -1,3 +1,5 @@')
    // The added line carries its new line number, the context line its own.
    expect(diff.querySelector('[data-kind="add"]')?.textContent).toContain('2')
    // The directory is shown apart from the file name.
    expect(screen.getByText('docs/')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
  })

  it('opens every excerpt for two files and none beyond that', () => {
    const file = (n: number) => ({ path: `f${n}.ts`, additions: 1, deletions: 0, excerpt: `+line ${n}` })
    const { unmount } = render(<TurnChangeCard changes={{ files: [file(1), file(2)] }} t={t} />)
    open()
    expect(screen.getAllByTestId('change-excerpt')).toHaveLength(2)
    unmount()
    render(<TurnChangeCard changes={{ files: [file(1), file(2), file(3)] }} t={t} />)
    open()
    expect(screen.queryByTestId('change-excerpt')).toBeNull()
    fireEvent.click(screen.getByText('f3.ts'))
    expect(screen.getAllByTestId('change-excerpt')).toHaveLength(1)
  })

  it('shows Not applied for an isolated change nobody decided on, and Undo once applied', async () => {
    const undo = vi.fn(async () => {})
    const { unmount } = render(<TurnChangeCard changes={changes} actions={actions} t={t} />)
    expect(screen.getByTestId('turn-changes-status').textContent).toContain('rooms:changes.state.idle')
    unmount()
    render(<TurnChangeCard changes={changes} actions={{ ...actions, undo }} decision="applied" t={t} />)
    expect(screen.getByText('rooms:changes.state.applied')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'rooms:apply.undo' }))
    expect(undo).toHaveBeenCalled()
  })

  it('shows a saved decision after a reload and hides Keep', () => {
    render(<TurnChangeCard changes={changes} actions={actions} decision="kept" t={t} />)
    expect(screen.getByText('rooms:changes.state.kept')).toBeTruthy()
    open()
    expect(screen.queryByText('rooms:changes.keep')).toBeNull()
  })

  it('saves Keep through onDecision', () => {
    const onDecision = vi.fn()
    render(<TurnChangeCard changes={changes} actions={actions} onDecision={onDecision} t={t} />)
    open()
    fireEvent.click(screen.getByText('rooms:changes.keep'))
    expect(onDecision).toHaveBeenCalledWith('kept')
  })

  it('a discarded change shows no actions after a reload', () => {
    render(<TurnChangeCard changes={changes} actions={actions} decision="discarded" t={t} />)
    open()
    expect(screen.queryByText('rooms:changes.apply')).toBeNull()
    expect(screen.queryByText('rooms:changes.discard')).toBeNull()
  })

  it('shows this turn by default and the cumulative change on the toggle', () => {
    render(<TurnChangeCard changes={changes} actions={actions} t={t} />)
    open()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeTruthy()
    // A segmented toggle sized to its short labels; the full meaning is its name.
    expect(screen.getByTestId('change-scope')).toHaveAttribute('aria-label', 'rooms:changes.scope')
    fireEvent.click(screen.getByRole('button', { name: 'rooms:changes.scopeAll' }))
    expect(screen.getByText('rooms:changes.scopeAllShort')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('Open diff draws the Apply review gutter diff and closes with Close', async () => {
    const patch = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n x\n+y\n'
    render(<TurnChangeCard changes={changes} actions={{ ...actions, patch: vi.fn(async () => patch) }} t={t} />)
    open()
    fireEvent.click(screen.getByText('rooms:changes.openDiff'))
    expect(await screen.findByTestId('workspace-diff')).toBeTruthy()
    expect(screen.getByTestId('apply-file-diff')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'common:close' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'rooms:controls.cancel' })).toBeNull()
  })
})

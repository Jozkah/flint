import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApplyReviewDialog } from '../ApplyReviewDialog'
import type { ApplyPreview } from '@/lib/rooms/applyReview'

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key)

const A = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n one\n+two\n'
const B = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n'
const BIN = 'diff --git a/i.png b/i.png\nnew file mode 100644\nGIT binary patch\nliteral 1\nIcmZo*00001\n\n'

const preview = (over: Partial<ApplyPreview> = {}): ApplyPreview => ({
  patch: A + B + BIN,
  target: 'C:/Users/me/projects/acme',
  clean: true,
  files: [],
  dirty: [],
  ...over,
})

function setup(p: ApplyPreview | Promise<ApplyPreview>) {
  const onApply = vi.fn(async () => {})
  const onOpenChange = vi.fn()
  render(
    <ApplyReviewDialog
      open
      onOpenChange={onOpenChange}
      load={() => Promise.resolve(p)}
      onApply={onApply}
      source={{ name: 'Sonnet', round: 2 }}
      t={t}
    />
  )
  return { onApply, onOpenChange }
}

const confirm = () => screen.getByTestId('apply-confirm') as HTMLButtonElement

describe('ApplyReviewDialog', () => {
  it('runs the dry run on open and disables Apply until it answers', async () => {
    let resolve!: (p: ApplyPreview) => void
    setup(new Promise<ApplyPreview>((r) => (resolve = r)))
    expect(screen.getByTestId('apply-preflight').dataset.state).toBe('checking')
    expect(confirm().disabled).toBe(true)
    resolve(preview())
    await waitFor(() => expect(screen.getByTestId('apply-preflight').dataset.state).toBe('clean'))
    expect(confirm().disabled).toBe(false)
  })

  it('shows the summary, the source, statuses and the binary file without content', async () => {
    setup(preview())
    await screen.findByTestId('apply-summary')
    expect(screen.getByTestId('apply-summary').textContent).toContain('rooms:apply.files:{"count":3}')
    expect(screen.getByText('rooms:apply.source:{"name":"Sonnet","round":2}')).toBeTruthy()
    expect(screen.getAllByTestId('apply-file')).toHaveLength(3)
    expect(screen.getByText('rooms:apply.status.added')).toBeTruthy()
    expect(screen.getByText('rooms:apply.binary')).toBeTruthy()
    // Real diff rows, coloured by kind.
    expect(document.querySelectorAll('[data-kind="add"]').length).toBe(2)
  })

  it('lands focus on Cancel, not Apply', async () => {
    setup(preview())
    await screen.findByTestId('apply-summary')
    expect(document.activeElement?.textContent).toBe('rooms:controls.cancel')
  })

  it('lists conflicts per file and keeps Apply off until they are left out', async () => {
    const { onApply } = setup(
      preview({ clean: false, files: [{ path: 'b.ts', ok: false, reason: 'error: patch failed: b.ts:1' }, { path: 'a.ts', ok: true }, { path: 'i.png', ok: true }] })
    )
    await waitFor(() => expect(screen.getByTestId('apply-preflight').dataset.state).toBe('conflict'))
    expect(screen.getByText(/error: patch failed: b.ts:1/)).toBeTruthy()
    expect(confirm().disabled).toBe(true)
    expect(screen.getByText('rooms:apply.blockedConflict')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('rooms:apply.include:{"path":"b.ts"}'))
    expect(confirm().disabled).toBe(false)
    expect(confirm().textContent).toContain('rooms:apply.confirm:{"count":2}')
    fireEvent.click(confirm())
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(['a.ts', 'i.png']))
  })

  it('leaves out every conflicting file in one click', async () => {
    const { onApply } = setup(
      preview({ clean: false, files: [{ path: 'b.ts', ok: false, reason: 'error: patch failed: b.ts:1' }, { path: 'a.ts', ok: true }, { path: 'i.png', ok: true }] })
    )
    await waitFor(() => expect(screen.getByTestId('apply-preflight').dataset.state).toBe('conflict'))
    fireEvent.click(screen.getByTestId('apply-leave-out'))
    expect(screen.getByTestId('apply-preflight').dataset.state).toBe('clean')
    expect((screen.getByLabelText('rooms:apply.include:{"path":"b.ts"}') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(confirm())
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(['a.ts', 'i.png']))
  })

  it('applies everything when every file is selected', async () => {
    const { onApply, onOpenChange } = setup(preview())
    await waitFor(() => expect(confirm().disabled).toBe(false))
    fireEvent.click(confirm())
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(undefined))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('warns about uncommitted edits to the selected files', async () => {
    setup(preview({ dirty: ['a.ts'] }))
    const warn = await screen.findByTestId('apply-dirty')
    expect(warn.textContent).toContain('a.ts')
    fireEvent.click(screen.getByLabelText('rooms:apply.include:{"path":"a.ts"}'))
    expect(screen.queryByTestId('apply-dirty')).toBeNull()
  })

  it('caps a long file and shows more on request', async () => {
    const body = Array.from({ length: 1000 }, (_, i) => `+l${i}`).join('\n')
    setup(preview({ patch: `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,1000 @@\n${body}\n` }))
    await screen.findByTestId('apply-summary')
    // The first file opens; the hunk header takes one of the 400 rows.
    expect(document.querySelectorAll('[data-kind="add"]').length).toBe(399)
    fireEvent.click(screen.getByText(/rooms:apply.showMore/))
    expect(document.querySelectorAll('[data-kind="add"]').length).toBe(799)
  })
})

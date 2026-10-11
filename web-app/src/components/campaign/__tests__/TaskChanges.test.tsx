import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { TaskChanges } from '../TaskChanges'
import type { TaskDiff } from '@/lib/campaignApi'

const patch = (n: number) =>
  `@@ -1,1 +1,${n} @@\n` +
  Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')

const diff = (over: Partial<TaskDiff> = {}): TaskDiff => ({
  files: [
    {
      path: 'src/a.txt',
      status: 'added',
      added: 2,
      removed: 0,
      binary: false,
      patch: patch(2),
      truncated: false,
    },
    {
      path: 'src/b.ts',
      status: 'modified',
      added: 40,
      removed: 7,
      binary: false,
      patch: patch(120),
      truncated: false,
    },
    {
      path: 'img.png',
      status: 'added',
      added: 0,
      removed: 0,
      binary: true,
      patch: null,
      truncated: false,
    },
  ],
  added: 42,
  removed: 7,
  truncated: false,
  uncommitted: false,
  ...over,
})

describe('TaskChanges', () => {
  it('shows a totals line and one row per file with its kind and counts', async () => {
    render(<TaskChanges load={() => Promise.resolve(diff())} recordedFiles={[]} />)
    const totals = await screen.findByTestId('changes-totals')
    expect(totals).toHaveTextContent('3 files')
    expect(totals).toHaveTextContent('+42 −7')
    const row = screen.getByTestId('changes-file-src/b.ts')
    expect(row).toHaveTextContent('Edited')
    expect(row).toHaveTextContent('+40 −7')
    expect(screen.getByTestId('changes-file-src/a.txt')).toHaveTextContent('New')
    expect(screen.getByTestId('changes-file-img.png')).toHaveTextContent('binary')
  })

  it('expands a file to its diff and offers more for a long one', async () => {
    render(<TaskChanges load={() => Promise.resolve(diff())} recordedFiles={[]} />)
    const row = await screen.findByTestId('changes-file-src/b.ts')
    fireEvent.click(row.querySelector('button')!)
    const more = await screen.findByRole('button', { name: /Show \d+ more lines/ })
    expect(more).toBeInTheDocument()
    fireEvent.click(more)
    expect(screen.queryByRole('button', { name: /more lines/ })).toBeNull()
  })

  it('falls back to the recorded file names when git cannot answer', async () => {
    render(
      <TaskChanges
        load={() => Promise.reject(new Error('worktree gone'))}
        recordedFiles={['src/a.txt']}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('changes-totals')).toHaveTextContent('1 file')
    )
    expect(screen.getByTestId('changes-totals')).not.toHaveTextContent('+')
    expect(screen.getByText(/Only the file names are known/)).toBeInTheDocument()
  })

  it('says so when nothing changed or nothing can be read', async () => {
    const { unmount } = render(
      <TaskChanges
        load={() => Promise.resolve(diff({ files: [] }))}
        recordedFiles={[]}
      />
    )
    expect(await screen.findByTestId('changes-empty')).toHaveTextContent(
      'has not changed any files'
    )
    unmount()
    render(
      <TaskChanges load={() => Promise.reject(new Error('x'))} recordedFiles={[]} />
    )
    expect(await screen.findByTestId('changes-empty')).toHaveTextContent(
      'could not be read'
    )
  })
})

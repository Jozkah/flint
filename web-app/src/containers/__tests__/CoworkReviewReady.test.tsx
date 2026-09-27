import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { CoworkReviewReady } from '../CoworkReviewReady'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import type { SandboxApplyActions } from '../CoworkApplyAllDialog'

const plan = (path: string) => ({
  source: path,
  folder: '/proj',
  destination: path,
  remapped: false,
})

const bar = (over: Partial<Parameters<typeof CoworkReviewReady>[0]> = {}) => (
  <CoworkReviewReady
    fileCount={2}
    additions={5}
    deletions={1}
    onReview={vi.fn()}
    sessionId="s1"
    {...over}
  />
)

beforeEach(() => {
  useCoworkDisplay.setState({
    showFilesReadyBar: true,
    hiddenReadyBars: {},
    reviewOnlyFinish: 'keep',
    showPromptSnapshot: false,
  })
  toast.success.mockClear()
})

describe('files-ready bar', () => {
  it('hides with its × until the changes differ', async () => {
    const user = userEvent.setup()
    const { rerender } = render(bar())
    await user.click(screen.getByTestId('cowork-review-ready-hide'))
    expect(screen.queryByTestId('cowork-review-ready')).toBeNull()
    rerender(bar())
    expect(screen.queryByTestId('cowork-review-ready')).toBeNull()
    // New changes bring it back.
    rerender(bar({ fileCount: 3, additions: 9 }))
    expect(screen.getByTestId('cowork-review-ready')).toBeInTheDocument()
  })

  it('stays hidden everywhere when the setting is off', () => {
    useCoworkDisplay.setState({ showFilesReadyBar: false })
    render(bar())
    expect(screen.queryByTestId('cowork-review-ready')).toBeNull()
  })

  it('defaults: bar on, runs kept in the sandbox, model-received row off', () => {
    const initial = useCoworkDisplay.getInitialState()
    expect(initial.showFilesReadyBar).toBe(true)
    expect(initial.reviewOnlyFinish).toBe('keep')
    expect(initial.showPromptSnapshot).toBe(false)
    act(() => useCoworkDisplay.getState().setShowPromptSnapshot(true))
    expect(useCoworkDisplay.getState().showPromptSnapshot).toBe(true)
  })
})

describe('when a Review only run finishes', () => {
  const actions = (): SandboxApplyActions => ({
    planFor: plan,
    probe: vi.fn(async (p: string) => (p === 'mine.md' ? 'differs' : 'new') as 'new' | 'differs'),
    apply: vi.fn(async () => 'created' as const),
  })
  const finish = (a: SandboxApplyActions) => {
    const props = { sandboxPaths: ['new.md', 'mine.md'], applyActions: a }
    const { rerender } = render(bar({ running: true, ...props }))
    rerender(bar({ running: false, ...props }))
  }

  it('keeps everything in the sandbox by default', async () => {
    const a = actions()
    finish(a)
    await new Promise((r) => setTimeout(r, 0))
    expect(a.probe).not.toHaveBeenCalled()
    expect(screen.queryByTestId('cowork-apply-all-dialog')).toBeNull()
  })

  it('asks with the Apply all confirmation', async () => {
    useCoworkDisplay.setState({ reviewOnlyFinish: 'ask' })
    const a = actions()
    finish(a)
    expect(await screen.findByTestId('cowork-apply-all-dialog')).toBeInTheDocument()
    expect(a.apply).not.toHaveBeenCalled()
  })

  it('applies new files on its own and asks about the conflict', async () => {
    useCoworkDisplay.setState({ reviewOnlyFinish: 'auto' })
    const a = actions()
    finish(a)
    await waitFor(() => expect(a.apply).toHaveBeenCalledWith('new.md', false))
    expect(a.apply).not.toHaveBeenCalledWith('mine.md', expect.anything())
    expect(await screen.findByTestId('cowork-apply-all-dialog')).toHaveTextContent('mine.md')
    expect(toast.success).toHaveBeenCalled()
  })
})

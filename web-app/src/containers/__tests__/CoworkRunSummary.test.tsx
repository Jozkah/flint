import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkRunSummary } from '../CoworkRunSummary'
import type { CompletionSummary } from '@/lib/coworkOrigins'
import {
  deriveRunOutcome,
  type RunOutcomeInput,
} from '@/lib/coworkRunOutcome'
import type { CoworkTurn } from '@/types/coworkSession'

const empty: CompletionSummary = {
  janWrites: [],
  janWritesOverExisting: [],
  preExisting: [],
  observed: [],
  unknown: [],
  baseline: 'clean',
  tree: null,
}

const show = (over: Partial<CompletionSummary> = {}) =>
  render(<CoworkRunSummary summary={{ ...empty, ...over }} />)

const region = () => screen.getByTestId('cowork-run-summary')

describe('the run summary the application writes', () => {
  it('says what Jan changed, and where', () => {
    show({
      janWrites: [
        { destination: 'repository', paths: ['src/a.ts'] },
        { destination: 'sandbox', paths: ['notes.md'] },
      ],
    })

    expect(region()).toHaveTextContent(
      'common:coworkOrigins.janWrites.repository'
    )
    expect(region()).toHaveTextContent('src/a.ts')
    expect(region()).toHaveTextContent('common:coworkOrigins.janWrites.sandbox')
    expect(region()).toHaveTextContent('notes.md')
  })

  it('opens the file name itself in the result list', async () => {
    const onOpenPath = vi.fn()
    render(<CoworkRunSummary
      summary={{ ...empty, janWrites: [{ destination: 'repository', paths: ['print_checklist.html'] }] }}
      onOpenPath={onOpenPath}
      canOpenPath={() => true}
    />)
    await userEvent.click(screen.getByRole('button', { name: 'print_checklist.html' }))
    expect(onOpenPath).toHaveBeenCalledWith('print_checklist.html')
  })

  // The distinction the whole ledger exists to preserve.
  // Only the session's own writes are listed. Files that were already
  // changed, or changed by something else, are not its work.
  it('lists only what the session wrote', () => {
    show({
      janWrites: [{ destination: 'repository', paths: ['mine.ts'] }],
      observed: ['built.js'],
      preExisting: ['theirs.ts'],
      unknown: ['nowhere.ts'],
    })

    expect(region()).toHaveTextContent('mine.ts')
    expect(region()).not.toHaveTextContent('theirs.ts')
    expect(region()).not.toHaveTextContent('built.js')
    expect(region()).not.toHaveTextContent('nowhere.ts')
    expect(region()).not.toHaveTextContent('common:coworkOrigins.preExisting')
  })

  it('says nothing changed when only other files did', () => {
    show({ preExisting: ['theirs.ts'], observed: ['built.js'] })

    expect(region()).toHaveTextContent('common:coworkOrigins.nothing')
  })

  it('lists a long set of writes a few at a time', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    show({ janWrites: [{ destination: 'repository', paths }] })

    expect(region()).toHaveTextContent('f9.ts')
    expect(region()).not.toHaveTextContent('f10.ts')
    expect(region()).toHaveTextContent('common:coworkOrigins.showAll')
  })

  it('reports both facts about a write over existing changes', () => {
    show({
      janWrites: [{ destination: 'repository', paths: ['a.ts'] }],
      janWritesOverExisting: ['a.ts'],
    })

    expect(region()).toHaveTextContent('common:coworkOrigins.overExisting')
  })

  // A run that changed nothing says so, rather than showing an empty frame the
  // reader has to interpret.
  it('says plainly when nothing was changed', () => {
    show()

    expect(region()).toHaveTextContent('common:coworkOrigins.nothing')
  })

  it.each([
    'clean',
    'dirty',
    'non-git',
    'git-unavailable',
    'incomplete',
    'none',
  ] as const)('names the %s starting state it compared against', (baseline) => {
    show({ baseline })

    expect(region()).toHaveTextContent(`common:coworkOrigins.baseline.${baseline}`)
  })

  // Session b6343e27 had no folder attached, and read "No starting state was
  // recorded", which sounded like Flint failed to record one for a repo.
  it('says a run with no starting state had no folder attached', async () => {
    const en = (await import('@/locales/en/common.json')).default as {
      coworkOrigins: { baseline: { none: string } }
    }
    expect(en.coworkOrigins.baseline.none).toMatch(/No folder was attached/)
  })

  // Its own labelled region, not a paragraph inside the assistant's message:
  // the reader has to be able to tell which of the two wrote it.
  it('stands apart from the model’s prose as its own region', () => {
    show({ janWrites: [{ destination: 'repository', paths: ['a.ts'] }] })
    const section = screen.getByRole('region', {
      name: 'common:coworkOrigins.title',
    })

    expect(section).toBe(region())
    expect(within(section).getByText('common:coworkOrigins.subtitle')).toBeInTheDocument()
  })

  it('opens closed, so it does not reopen in full under every message', () => {
    show()
    const disclosure = region().querySelector('details')
    expect(disclosure).not.toBeNull()
    expect(disclosure).not.toHaveAttribute('open')
    // The heading still names it while collapsed, so it can be found.
    expect(region()).toHaveTextContent('common:coworkOrigins.title')
  })

  it('is a quiet line after a clean finish, with what it did in numbers', () => {
    show({ janWrites: [{ destination: 'repository', paths: ['a.ts', 'b.ts'] }] })
    expect(region()).toHaveAttribute('data-quiet')
    expect(screen.getByTestId('cowork-run-counts')).toHaveTextContent(
      'common:coworkOrigins.files'
    )
  })
})

// ---------------------------------------------------------------------------
// The outcome, for every way a run can end
// ---------------------------------------------------------------------------

const user: CoworkTurn = { role: 'user', content: 'do it' }
const bash = (command: string, result: string): CoworkTurn => ({
  role: 'tool',
  content: '',
  name: 'bash',
  callId: command,
  args: { command },
  result,
  status: 'done',
  toolState: 'succeeded',
})

const base = (over: Partial<RunOutcomeInput> = {}): RunOutcomeInput => ({
  running: false,
  stoppedBy: 'done',
  turns: [user],
  summary: empty,
  destination: 'repository',
  tree: '/repo',
  sessionId: 's1',
  runId: 's1',
  finishedAt: 1,
  checkpoints: [],
  handlers: { openResult: true, reviewChanges: true, continue: true, retry: true },
  ...over,
})

const handlers = () => ({
  onOpenPath: vi.fn(),
  onReviewChanges: vi.fn(),
  onContinue: vi.fn(),
  onRetry: vi.fn(),
  onRestore: vi.fn(),
})

describe('the outcome of a run', () => {
  it.each([
    ['completed', base({ summary: { ...empty, janWrites: [{ destination: 'repository', paths: ['a.ts'] }] } })],
    ['failed', base({ stoppedBy: 'error' })],
    ['cancelled', base({ stoppedBy: 'aborted' })],
    [
      'partial',
      base({
        stoppedBy: 'aborted',
        summary: { ...empty, janWrites: [{ destination: 'repository', paths: ['a.ts'] }] },
      }),
    ],
  ] as const)('shows %s with the status the derivation gives', (status, inputs) => {
    // One derivation, one status: the badge and the region's own status are
    // read from the same object every other surface reads.
    const outcome = deriveRunOutcome(inputs)
    render(<CoworkRunSummary outcome={outcome} {...handlers()} />)

    expect(outcome.status).toBe(status)
    expect(region()).toHaveAttribute('data-status', status)
    expect(screen.getByTestId('cowork-run-status')).toHaveTextContent(
      `results:status.${status}`
    )
    expect(region()).toHaveAttribute('data-session-id', 's1')
  })

  it('opens on its own for a run that did not finish', () => {
    render(
      <CoworkRunSummary outcome={deriveRunOutcome(base({ stoppedBy: 'loop' }))} />
    )
    expect(region().querySelector('details')).toHaveAttribute('open')
  })

  it('says the work a stopped run did was kept', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            stoppedBy: 'aborted',
            summary: { ...empty, janWrites: [{ destination: 'repository', paths: ['a.ts'] }] },
          })
        )}
      />
    )
    expect(region()).toHaveTextContent('results:headline.partial')
    expect(region()).toHaveTextContent('results:kept')
    expect(region()).toHaveTextContent('results:unresolved.stop.aborted')
  })

  it('says explicitly when no checks were run', () => {
    render(<CoworkRunSummary outcome={deriveRunOutcome(base())} />)
    expect(screen.getByTestId('cowork-run-checks')).toHaveTextContent(
      'results:checks.none'
    )
  })

  it('lists observed checks with their verdict and exit code', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            turns: [user, bash('npm test', '[exit 0]'), bash('cargo build', 'error\n[exit 101]')],
          })
        )}
      />
    )
    const checks = screen.getByTestId('cowork-run-checks')
    expect(checks).toHaveTextContent('results:checks.outcome.passed')
    expect(checks).toHaveTextContent('npm test')
    expect(checks).toHaveTextContent('results:checks.outcome.failed')
    expect(checks).toHaveTextContent('cargo build')
    expect(checks).not.toHaveTextContent('results:checks.none')
    // A failed check is reported in the Checks section and the headline; the
    // Unresolved section does not repeat it.
    expect(region()).toHaveTextContent('results:headline.completedChecksFailed')
    expect(region()).not.toHaveTextContent('results:unresolved.checkFailed')
    // Summarised from the record: one of two passed, the other failed with
    // its exit code. Nothing claims the whole set passed.
    const summary = screen.getByTestId('cowork-verification-summary')
    expect(summary).toHaveTextContent('results:checks.summary.somePassed')
    expect(summary).toHaveTextContent('results:checks.summary.failedWithCode')
    expect(summary).not.toHaveTextContent('results:checks.summary.allTestsPassed')
  })

  it('says automated tests passed, and that nothing looked at the result', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({ turns: [user, bash('npm test', '[exit 0]'), bash('ls', '[exit 0]')] })
        )}
      />
    )
    const summary = screen.getByTestId('cowork-verification-summary')
    expect(summary).toHaveTextContent('results:checks.summary.allTestsPassed')
    expect(summary).toHaveTextContent('results:checks.summary.visualNotChecked')
    expect(region()).not.toHaveTextContent('passNotProof')
    // The ordinary command is counted apart from the checks.
    expect(screen.getByTestId('cowork-other-commands')).toHaveTextContent(
      'results:checks.otherCommands'
    )
  })

  it('leaves out the visual sentence when an end-to-end run was recorded', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            turns: [
              user,
              bash('npm test', '[exit 0]'),
              bash('npx playwright test', '[exit 0]'),
            ],
          })
        )}
      />
    )
    const summary = screen.getByTestId('cowork-verification-summary')
    expect(summary).toHaveTextContent('results:checks.summary.allTestsPassed')
    expect(summary).not.toHaveTextContent(
      'results:checks.summary.visualNotChecked'
    )
  })

  it('never labels a cancelled check as passed, even with exit 0 in its output', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            turns: [user, { ...bash('npm test', '[exit 0]'), toolState: 'cancelled' }],
          })
        )}
      />
    )
    const checks = screen.getByTestId('cowork-run-checks')
    expect(checks).toHaveTextContent('results:checks.outcome.didNotFinish')
    expect(checks).not.toHaveTextContent('results:checks.outcome.passed')
    const summary = screen.getByTestId('cowork-verification-summary')
    expect(summary).toHaveTextContent('results:checks.summary.didNotFinish')
    expect(summary).not.toHaveTextContent('results:checks.summary.visualNotChecked')
  })

  it('shows what the assistant said about checks as unverified, not as a check', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({ turns: [user, { role: 'assistant', content: 'All tests pass.' }] })
        )}
      />
    )
    const checks = screen.getByTestId('cowork-run-checks')
    expect(checks).toHaveTextContent('results:checks.none')
    expect(checks).toHaveTextContent('results:checks.claimsTitle')
    expect(checks).toHaveTextContent('All tests pass.')
    expect(checks).not.toHaveTextContent('results:checks.outcome.passed')
  })

  it('wires next steps to the handlers it was given', async () => {
    const h = handlers()
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            stoppedBy: 'error',
            summary: { ...empty, janWrites: [{ destination: 'repository', paths: ['src/a.ts'] }] },
          })
        )}
        canOpenPath={() => true}
        {...h}
      />
    )

    const next = screen.getByRole('button', { name: 'results:actions.reviewChanges' })
    await userEvent.click(next)
    expect(h.onReviewChanges).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'results:actions.retry' }))
    expect(h.onRetry).toHaveBeenCalled()
    // Retry explains what it does and does not do.
    expect(region()).toHaveTextContent('results:actions.retryNote')

    await userEvent.click(screen.getByRole('button', { name: 'results:actions.continue' }))
    expect(h.onContinue).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'results:actions.openResult' }))
    expect(h.onOpenPath).toHaveBeenCalledWith('src/a.ts')

    // No managed checkpoint, so no restore.
    expect(screen.queryByRole('button', { name: 'results:actions.restore' })).toBeNull()
  })

  it('offers restore only when the outcome does, and never retry for a plain stop', async () => {
    const h = handlers()
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            stoppedBy: 'aborted',
            destination: 'managed',
            tree: '/wt',
            summary: { ...empty, janWrites: [{ destination: 'managed', paths: ['a.ts'] }] },
            checkpoints: [{ root: '/wt', destination: 'managed' }],
          })
        )}
        {...h}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'results:actions.restore' }))
    expect(h.onRestore).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'results:actions.retry' })).toBeNull()
    expect(region()).not.toHaveTextContent('results:actions.retryNote')
  })

  it('leaves out actions it has no handler for', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(base({ stoppedBy: 'error' }))}
      />
    )
    expect(within(region()).queryAllByRole('button')).toEqual([])
  })
})

describe('a change the read-only turn never offered', () => {
  it('says the turn was read-only rather than "Not allowed"', () => {
    render(
      <CoworkRunSummary
        outcome={deriveRunOutcome(
          base({
            turns: [
              user,
              {
                role: 'tool',
                content: '',
                name: 'write',
                callId: 'w1',
                args: { path: 'inventory.py' },
                status: 'done',
                isError: true,
                result: "Model tried to call unavailable tool 'write'.",
              },
            ],
          })
        )}
        {...handlers()}
      />
    )
    expect(region()).toHaveTextContent('results:unresolved.refusedReadOnly')
    expect(region()).not.toHaveTextContent('results:unresolved.refused ')
  })
})

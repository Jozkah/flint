import { describe, expect, it } from 'vitest'
import {
  checkVerdict,
  classifyCommand,
  continueRequest,
  claimsFromText,
  deriveRunOutcome,
  isVisualCheck,
  lastRunTurns,
  shouldShowRunOutcome,
  summarizeVerification,
  verifiedChecks,
  type RunOutcomeInput,
} from '../coworkRunOutcome'
import type { CompletionSummary } from '../coworkOrigins'
import type { CoworkTurn } from '@/types/coworkSession'

const summary = (over: Partial<CompletionSummary> = {}): CompletionSummary => ({
  janWrites: [],
  janWritesOverExisting: [],
  preExisting: [],
  observed: [],
  unknown: [],
  baseline: 'clean',
  tree: null,
  ...over,
})

const user = (content = 'do it'): CoworkTurn => ({ role: 'user', content })
const assistant = (content: string): CoworkTurn => ({
  role: 'assistant',
  content,
})
const bash = (
  command: string,
  over: Partial<CoworkTurn> = {}
): CoworkTurn => ({
  role: 'tool',
  content: '',
  name: 'bash',
  callId: `call-${command}`,
  args: { command },
  status: 'done',
  toolState: 'succeeded',
  ...over,
})
const write = (path: string, over: Partial<CoworkTurn> = {}): CoworkTurn => ({
  role: 'tool',
  content: '',
  name: 'write',
  callId: `write-${path}`,
  args: { path },
  status: 'done',
  toolState: 'succeeded',
  ...over,
})

const input = (over: Partial<RunOutcomeInput> = {}): RunOutcomeInput => ({
  running: false,
  stoppedBy: 'done',
  turns: [],
  summary: summary(),
  destination: 'repository',
  tree: '/repo',
  sessionId: 'session-1',
  runId: 'session-1',
  finishedAt: 42,
  checkpoints: [],
  handlers: {
    openResult: true,
    reviewChanges: true,
    continue: true,
    retry: true,
  },
  ...over,
})

describe('classifying commands as checks', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run test:unit', 'test'],
    ['yarn test --watch=false', 'test'],
    ['npx vitest run src/lib', 'test'],
    ['cd web-app && npx vitest run', 'test'],
    ['CI=1 jest --ci', 'test'],
    ['python -m pytest -q', 'test'],
    ['uv run pytest', 'test'],
    ['cargo test -p app', 'test'],
    ['go test ./...', 'test'],
    ['dotnet test', 'test'],
    ['mvn -q test', 'test'],
    ['./gradlew test', 'test'],
    ['bundle exec rspec', 'test'],
    ['npm run build', 'build'],
    ['cargo build -j 4', 'build'],
    ['go build ./...', 'build'],
    ['tsc -b', 'build'],
    ['npx tsc --noEmit', 'lint'],
    ['cargo clippy', 'lint'],
    ['pnpm lint', 'lint'],
    ['ruff check .', 'lint'],
    ['npm run check', 'command'],
  ] as const)('%s is a %s', (command, kind) => {
    expect(classifyCommand(command)).toBe(kind)
  })

  it.each(['ls -la', 'cat package.json', 'git status', 'echo test passed', 'npm install'])(
    '%s is not a check',
    (command) => {
      expect(classifyCommand(command)).toBeNull()
    }
  )

  it('reads a build followed by tests as the tests', () => {
    expect(classifyCommand('npm run build && npm test')).toBe('test')
  })
})

describe('the last run', () => {
  it('starts at the last user request, not at a steered message', () => {
    const turns: CoworkTurn[] = [
      user('first'),
      bash('npm test'),
      user('second'),
      bash('cargo test'),
      { role: 'user', content: 'also this', steered: true },
      bash('go test ./...'),
    ]
    expect(lastRunTurns(turns)).toHaveLength(3)
    expect(
      lastRunTurns(turns)
        .filter((t) => t.role === 'tool')
        .map((t) => (t.args as { command: string }).command)
    ).toEqual(['cargo test', 'go test ./...'])
  })
})

describe('deriving a run outcome', () => {
  it('completed, with a passing test observed from its exit status', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          write('src/a.ts'),
          bash('npm test', { result: 'ok\n[exit 0]' }),
          assistant('Done.'),
        ],
        summary: summary({
          janWrites: [{ destination: 'repository', paths: ['src/a.ts'] }],
        }),
      })
    )

    expect(outcome.status).toBe('completed')
    expect(outcome.headline).toBe('completed-with-changes')
    expect(outcome.checks).toEqual([
      expect.objectContaining({
        kind: 'test',
        command: 'npm test',
        outcome: 'passed',
        evidence: 'observed',
        exitCode: 0,
      }),
    ])
    expect(outcome.unresolved).toEqual([])
    expect(outcome.resultLocation).toEqual({
      destination: 'repository',
      treeKind: 'user-checkout',
      tree: '/repo',
      paths: ['src/a.ts'],
    })
    expect(outcome.source).toEqual({
      sessionId: 'session-1',
      runId: 'session-1',
      finishedAt: 42,
    })
  })

  it('reports a failed test as observed and unresolved', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          bash('cargo test', {
            result: 'test result: FAILED\n[exit 101]',
            toolState: 'succeeded',
          }),
        ],
      })
    )

    // A failed check is not a completed request: partly done.
    expect(outcome.status).toBe('partial')
    expect(outcome.headline).toBe('completed-checks-failed')
    expect(outcome.checks[0]).toMatchObject({
      outcome: 'failed',
      exitCode: 101,
    })
    expect(outcome.unresolved).toContainEqual({
      kind: 'check-failed',
      command: 'cargo test',
      exitCode: 101,
    })
  })

  it('prefers the recorded exit code over the output text', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [user(), bash('go test ./...', { exitCode: 1, result: '[exit 0]' })],
      })
    )
    expect(outcome.checks[0].outcome).toBe('failed')
  })

  it('a refused check was not run; one with no exit status is unknown', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          bash('npm test', { toolState: 'refused', isError: true }),
          bash('pytest', { toolState: 'failed', isError: true, result: 'sandbox refused' }),
        ],
      })
    )
    expect(outcome.checks.map((c) => c.outcome)).toEqual(['not-run', 'unknown'])
    expect(verifiedChecks(outcome)).toEqual([])
    expect(outcome.unresolved).toContainEqual({
      kind: 'refused',
      tool: 'bash',
      target: 'npm test',
    })
  })

  it('a cancelled run that already wrote files is partial, and keeps them', () => {
    const outcome = deriveRunOutcome(
      input({
        stoppedBy: 'aborted',
        turns: [
          user(),
          write('src/a.ts'),
          write('src/b.ts', { toolState: 'cancelled', status: 'done' }),
        ],
        summary: summary({
          janWrites: [{ destination: 'repository', paths: ['src/a.ts'] }],
        }),
      })
    )

    expect(outcome.status).toBe('partial')
    expect(outcome.headline).toBe('partial')
    expect(outcome.resultLocation.paths).toEqual(['src/a.ts'])
    expect(outcome.unresolved).toEqual([
      { kind: 'stop', reason: 'aborted' },
      { kind: 'cancelled', tool: 'write', target: 'src/b.ts' },
    ])
  })

  it('a cancelled run that did nothing is cancelled; a failed one is failed', () => {
    expect(
      deriveRunOutcome(input({ stoppedBy: 'aborted', turns: [user()] })).status
    ).toBe('cancelled')
    const failed = deriveRunOutcome(
      input({
        stoppedBy: 'error',
        errorText: 'model unreachable',
        turns: [user()],
      })
    )
    expect(failed.status).toBe('failed')
    expect(failed.unresolved[0]).toEqual({
      kind: 'stop',
      reason: 'error',
      message: 'model unreachable',
    })
  })

  it('a failed run after a completed tool step is partial', () => {
    const outcome = deriveRunOutcome(
      input({
        stoppedBy: 'deadline',
        turns: [user(), { role: 'tool', content: '', name: 'read', args: { path: 'a' }, toolState: 'succeeded' }],
      })
    )
    expect(outcome.status).toBe('partial')
  })

  it('never treats what the assistant said as a check that ran', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [user(), assistant('I fixed the bug. All tests pass now.')],
      })
    )

    expect(outcome.checks).toEqual([])
    expect(verifiedChecks(outcome)).toEqual([])
    expect(outcome.claims).toEqual([
      {
        kind: 'test',
        text: 'All tests pass now.',
        evidence: 'assistant-text',
        verified: false,
      },
    ])
    // Still worth showing, so the unverified claim is not the last word.
    expect(shouldShowRunOutcome(outcome)).toBe(true)
  })

  it('has no checks at all when none ran, so the surface can say so', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [user(), bash('ls -la', { result: '[exit 0]' }), assistant('Here you go.')],
      })
    )
    expect(outcome.checks).toEqual([])
    expect(outcome.claims).toEqual([])
  })

  it('offers restore only with a managed checkpoint for this tree', () => {
    const managed = input({
      destination: 'managed',
      tree: '/wt/s1',
      summary: summary({
        janWrites: [{ destination: 'managed', paths: ['a.ts'] }],
      }),
    })

    expect(deriveRunOutcome(managed).nextActions).not.toContain('restore')
    expect(
      deriveRunOutcome({
        ...managed,
        checkpoints: [{ root: '/wt/other', destination: 'managed' }],
      }).nextActions
    ).not.toContain('restore')
    expect(
      deriveRunOutcome({
        ...managed,
        checkpoints: [{ root: '/wt/s1', destination: 'managed' }],
      }).nextActions
    ).toContain('restore')
    // The user's own checkout never gets a restore, whatever is recorded.
    expect(
      deriveRunOutcome(
        input({
          destination: 'repository',
          tree: '/repo',
          checkpoints: [{ root: '/repo', destination: 'user-checkout' }],
        })
      ).nextActions
    ).not.toContain('restore')
  })

  it('offers retry only for stops whose notice supports it', () => {
    const actions = (stoppedBy: RunOutcomeInput['stoppedBy']) =>
      deriveRunOutcome(input({ stoppedBy, turns: [user()] })).nextActions
    for (const stop of ['error', 'deadline', 'timeout', 'loop'] as const)
      expect(actions(stop)).toContain('retry')
    for (const stop of ['aborted', 'steps', 'tokens', 'done', null] as const)
      expect(actions(stop)).not.toContain('retry')
  })

  it('offers only actions whose handlers exist', () => {
    const outcome = deriveRunOutcome(
      input({
        summary: summary({
          janWrites: [{ destination: 'repository', paths: ['a.ts'] }],
        }),
        handlers: {
          openResult: false,
          reviewChanges: false,
          continue: false,
          retry: false,
        },
      })
    )
    expect(outcome.nextActions).toEqual([])
  })

  it('reports nothing actionable while the run is going', () => {
    const outcome = deriveRunOutcome(
      input({ running: true, stoppedBy: 'error', turns: [user(), bash('npm test', { toolState: 'running', status: 'running' })] })
    )
    expect(outcome.status).toBe('running')
    expect(outcome.stopReason).toBeNull()
    expect(outcome.nextActions).toEqual([])
    expect(outcome.unresolved).toEqual([])
    expect(outcome.checks[0].outcome).toBe('unknown')
    expect(shouldShowRunOutcome(outcome)).toBe(false)
  })

  it('marks calls left waiting when the run ended as interrupted', () => {
    const outcome = deriveRunOutcome(
      input({
        stoppedBy: 'aborted',
        turns: [user(), write('a.ts', { toolState: 'awaiting-permission', status: 'running' })],
      })
    )
    expect(outcome.unresolved).toContainEqual({
      kind: 'interrupted',
      tool: 'write',
      target: 'a.ts',
    })
  })

  it('does not know about changes when no ledger was recorded', () => {
    const outcome = deriveRunOutcome(input({ summary: null }))
    expect(outcome.changes.known).toBe(false)
    expect(outcome.resultLocation.paths).toEqual([])
  })

  it('hides a plain answer that changed and checked nothing', () => {
    expect(shouldShowRunOutcome(deriveRunOutcome(input({ turns: [user(), assistant('Hi.')] })))).toBe(false)
  })

  it('gives the same outcome for the same inputs', () => {
    const one = input({
      stoppedBy: 'loop',
      turns: [user(), write('a.ts'), bash('npm test', { result: '[exit 1]' })],
      summary: summary({ janWrites: [{ destination: 'repository', paths: ['a.ts'] }] }),
    })
    expect(deriveRunOutcome(one)).toEqual(deriveRunOutcome(structuredClone(one)))
  })
})

describe('commands versus verification checks', () => {
  it('records every command but counts only verification commands as checks', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          bash('ls -la', { exitCode: 0 }),
          bash('npx vitest run', { exitCode: 0 }),
        ],
      })
    )
    expect(outcome.commands.map((c) => [c.command, c.verification])).toEqual([
      ['ls -la', null],
      ['npx vitest run', 'test'],
    ])
    expect(outcome.checks).toHaveLength(1)
  })

  it('separates attempted, completed and succeeded', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          bash('npm test', { permission: 'denied', toolState: 'refused' }),
          bash('cargo test', { toolState: 'timed-out', exitCode: undefined }),
          bash('pytest', { toolState: 'failed', exitCode: 1 }),
        ],
      })
    )
    const [refused, timedOut, failed] = outcome.checks
    expect(refused).toMatchObject({ attempted: false, completion: 'not-started', outcome: 'not-run' })
    expect(timedOut).toMatchObject({ attempted: true, completion: 'timed-out' })
    expect(timedOut.outcome).not.toBe('passed')
    expect(failed).toMatchObject({ attempted: true, completion: 'completed', outcome: 'failed', exitCode: 1 })
  })

  it('marks a command still running when the run ended as interrupted, never passed', () => {
    const outcome = deriveRunOutcome(
      input({
        stoppedBy: 'aborted',
        turns: [user(), bash('go test ./...', { toolState: 'running', status: 'running' })],
      })
    )
    expect(outcome.checks[0]).toMatchObject({ completion: 'interrupted', outcome: 'unknown' })
  })

  it('states what an exit status does not cover', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          bash('npm run build && npx vitest run src/a.test.ts', {
            exitCode: 0,
            result: 'ok\n[output truncated]\n[exit 0]',
          }),
        ],
      })
    )
    const check = outcome.checks[0]
    expect(check.outcome).toBe('passed')
    expect(check.limitations).toEqual(
      expect.arrayContaining(['exit-status-only', 'compound-command', 'subset-selected'])
    )
  })

  it('reports a missing exit status as a limitation rather than a pass', () => {
    const outcome = deriveRunOutcome(
      input({ turns: [user(), bash('pytest', { toolState: 'succeeded' })] })
    )
    expect(outcome.checks[0].outcome).toBe('unknown')
    expect(outcome.checks[0].limitations).toContain('no-exit-status')
  })
})

describe('summarising verification from recorded results', () => {
  const summarize = (turns: CoworkTurn[], over: Partial<RunOutcomeInput> = {}) =>
    summarizeVerification(deriveRunOutcome(input({ turns: [user(), ...turns], ...over })))

  it('says tests passed only when every check completed with exit 0', () => {
    const s = summarize([
      bash('npx vitest run', { exitCode: 0 }),
      bash('npm run build', { exitCode: 0 }),
    ])
    expect(s).toMatchObject({ total: 2, passed: 2, allPassed: true, testsPassed: true, failures: [] })
  })

  it('does not call a build or lint pass a test pass', () => {
    const s = summarize([bash('npm run lint', { exitCode: 0 })])
    expect(s).toMatchObject({ allPassed: true, testsPassed: false })
  })

  it('reports each failure with the exit code it recorded', () => {
    const s = summarize([
      bash('npm test', { exitCode: 0 }),
      bash('cargo test', { toolState: 'failed', exitCode: 101 }),
    ])
    expect(s).toMatchObject({ passed: 1, failed: 1, allPassed: false })
    expect(s.failures).toEqual([{ command: 'cargo test', exitCode: 101 }])
  })

  it.each([
    ['cancelled', { toolState: 'cancelled', exitCode: 0 }],
    ['timed out', { toolState: 'timed-out', exitCode: 0 }],
  ] as const)('counts a %s check as did not finish, never passed', (_, over) => {
    const outcome = deriveRunOutcome(input({ turns: [user(), bash('npm test', over)] }))
    expect(checkVerdict(outcome.checks[0])).toBe('did-not-finish')
    const s = summarizeVerification(outcome)
    expect(s).toMatchObject({ passed: 0, didNotFinish: 1, allPassed: false, visualNotChecked: false })
  })

  it.each([
    ['cancelled', { toolState: 'cancelled', exitCode: 0 }],
    ['cancelled', { toolState: 'cancelled', exitCode: 1 }],
    ['timed-out', { toolState: 'timed-out', exitCode: 0 }],
    ['timed-out', { toolState: 'timed-out', exitCode: 137 }],
  ] as const)('gives a %s check with an exit code no pass/fail outcome (%o)', (_, over) => {
    const outcome = deriveRunOutcome(input({ turns: [user(), bash('npm test', over)] }))
    expect(outcome.checks[0].outcome).toBe('unknown')
    expect(checkVerdict(outcome.checks[0])).toBe('did-not-finish')
    expect(outcome.unresolved.some((u) => u.kind === 'check-failed')).toBe(false)
  })

  it('counts a check left running when the run ended as did not finish', () => {
    const s = summarize(
      [bash('go test ./...', { toolState: 'running', status: 'running' })],
      { stoppedBy: 'aborted' }
    )
    expect(s).toMatchObject({ didNotFinish: 1, passed: 0 })
  })

  it('counts a check still going while the run is live as running', () => {
    const s = summarize(
      [bash('go test ./...', { toolState: 'running', status: 'running' })],
      { running: true }
    )
    expect(s).toMatchObject({ running: 1, passed: 0, allPassed: false })
  })

  it('counts a refused check as not run', () => {
    const s = summarize([bash('npm test', { permission: 'denied', toolState: 'refused' })])
    expect(s).toMatchObject({ notRun: 1, passed: 0, allPassed: false })
  })

  it('counts a check with no exit status as unknown, not passed', () => {
    const s = summarize([bash('pytest', { toolState: 'succeeded' })])
    expect(s).toMatchObject({ unknown: 1, passed: 0, allPassed: false, visualNotChecked: false })
  })

  it('counts ordinary commands apart from checks', () => {
    const s = summarize([
      bash('ls -la', { exitCode: 0 }),
      bash('cat package.json', { exitCode: 0 }),
      bash('npm test', { exitCode: 0 }),
    ])
    expect(s).toMatchObject({ total: 1, passed: 1, otherCommands: 2 })
  })

  it('says visual behaviour was not checked when only unit checks passed', () => {
    expect(summarize([bash('npm test', { exitCode: 0 })]).visualNotChecked).toBe(true)
  })

  it('omits the visual sentence when an end-to-end run was recorded', () => {
    expect(
      summarize([
        bash('npm test', { exitCode: 0 }),
        bash('npx playwright test', { exitCode: 0 }),
      ]).visualNotChecked
    ).toBe(false)
    // A recorded failure is still a check that looked.
    expect(
      summarize([
        bash('npm test', { exitCode: 0 }),
        bash('npm run test:e2e', { toolState: 'failed', exitCode: 1 }),
      ]).visualNotChecked
    ).toBe(false)
  })

  it('omits the visual sentence when a screenshot was taken', () => {
    const screenshot: CoworkTurn = {
      role: 'tool',
      content: '',
      name: 'screenshot',
      callId: 'shot',
      args: { path: 'index.html' },
      status: 'done',
      toolState: 'succeeded',
    }
    expect(
      summarize([bash('npm test', { exitCode: 0 }), screenshot]).visualNotChecked
    ).toBe(false)
  })

  it('keeps the visual sentence when the end-to-end run did not finish', () => {
    expect(
      summarize([
        bash('npm test', { exitCode: 0 }),
        bash('npx cypress run', { toolState: 'cancelled', exitCode: 0 }),
      ]).visualNotChecked
    ).toBe(true)
  })

  it('has nothing to summarise when no checks ran', () => {
    expect(summarize([bash('ls', { exitCode: 0 })])).toMatchObject({
      total: 0,
      allPassed: false,
      visualNotChecked: false,
      otherCommands: 1,
    })
  })

  it.each([
    ['npx playwright test', true],
    ['cd web && CI=1 pnpm exec playwright test --project chromium', true],
    ['npm run test:e2e', true],
    ['yarn e2e', true],
    ['npx cypress run', true],
    ['npx vitest run', false],
    ['npm test', false],
    ['echo playwright test', false],
  ])('%s is a visual check: %s', (command, expected) => {
    expect(isVisualCheck(command)).toBe(expected)
  })
})

describe('claims in the assistant’s text', () => {
  it('ignores hedged, negated and instructional sentences', () => {
    expect(
      claimsFromText(
        'The tests should pass now. The build did not succeed. Run the tests to check they pass. If the lint is clean, merge.'
      )
    ).toEqual([])
  })

  it('finds build and lint claims too', () => {
    expect(
      claimsFromText('The build succeeded.\nType-checking is clean.').map((c) => c.kind)
    ).toEqual(['build', 'lint'])
  })
})

describe('a normal finish that left the request undone', () => {
  it('is partly done when a requested write was refused', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          {
            role: 'tool',
            content: '',
            name: 'write',
            callId: 'w1',
            args: { path: 'out/report.md' },
            status: 'done',
            isError: true,
            result: 'The call to `write` was not run: tool not offered.',
          },
          assistant('Done.'),
        ],
      })
    )
    expect(outcome.status).toBe('partial')
    expect(outcome.headline).toBe('finished-incomplete')
  })

  it('is partly done while the plan has open items', () => {
    const outcome = deriveRunOutcome(
      input({ turns: [user(), assistant('Done.')], openTodos: 2 })
    )
    expect(outcome.status).toBe('partial')
    expect(outcome.headline).toBe('finished-incomplete')
  })

  it('is partly done when the sandbox could not run a command', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [
          user(),
          {
            role: 'tool',
            content: '',
            name: 'bash',
            callId: 'b1',
            args: { command: 'python examples\\basic.py' },
            status: 'done',
            isError: true,
            result:
              "python : The term 'python' is not recognized\n[exit 1]\n" +
              '[sandbox: `python` is not available in this sandbox. Do not retry.]',
          },
          assistant('Not run: no Python in the sandbox.'),
        ],
      })
    )
    expect(outcome.status).toBe('partial')
    expect(outcome.headline).toBe('finished-incomplete')
  })

  it('is still completed when nothing was left undone', () => {
    const outcome = deriveRunOutcome(
      input({ turns: [user(), assistant('Done.')], openTodos: 0 })
    )
    expect(outcome.status).toBe('completed')
  })
})

/**
 * Session f49a386a: a turn ran read-only, so `write` and `edit` were never
 * offered. The card said "Not allowed", which read like a denied approval when
 * the remedy was a mode change.
 */
describe('a change tool withheld by a read-only turn', () => {
  const withheld = (name: string): CoworkTurn => ({
    role: 'tool',
    content: '',
    name,
    callId: `${name}-1`,
    args: { path: 'inventory.py' },
    status: 'done',
    isError: true,
    result: `The call to \`${name}\` was not run: Model tried to call unavailable tool '${name}'. Available tools: read, ls.`,
  })

  it('is reported as refused because the turn was read-only', () => {
    const outcome = deriveRunOutcome(
      input({ turns: [user(), withheld('write'), withheld('edit'), assistant('Blocked.')] })
    )
    expect(outcome.unresolved).toEqual([
      { kind: 'refused', tool: 'write', target: 'inventory.py', readOnly: true },
      { kind: 'refused', tool: 'edit', target: 'inventory.py', readOnly: true },
    ])
    expect(outcome.status).toBe('partial')
  })

  it('leaves a gate refusal as a plain refusal', () => {
    const outcome = deriveRunOutcome(
      input({
        turns: [user(), write('a.txt', { permission: 'denied', toolState: 'refused' })],
      })
    )
    expect(outcome.unresolved).toEqual([
      { kind: 'refused', tool: 'write', target: 'a.txt' },
    ])
  })
})

describe('the request Continue sends', () => {
  it('names each unresolved step so the next run retries it', () => {
    const text = continueRequest([
      { kind: 'refused', tool: 'write', target: 'inventory.py', readOnly: true },
      { kind: 'failed', tool: 'bash', target: 'pytest' },
      { kind: 'check-failed', command: 'npm test', exitCode: 1 },
    ])
    expect(text).toMatch(/^Continue with the previous request\./)
    expect(text).toContain('- write inventory.py (not offered: the last turn was read-only)')
    expect(text).toContain('- bash pytest (failed)')
    expect(text).toContain('- check did not pass: npm test')
  })

  it('just continues when nothing was left open', () => {
    expect(continueRequest([])).toBe('Continue.')
  })
})

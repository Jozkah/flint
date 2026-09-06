import { describe, it, expect } from 'vitest'
import {
  accessibleLabel,
  activityCounts,
  appendActivityEvent,
  appendActivityEvents,
  cancelInFlight,
  clampText,
  copyTextFor,
  emptyActivityLog,
  eventsForCall,
  filterActivity,
  hasExpandableDetail,
  MAX_EVENTS_PER_SESSION,
  MAX_STORED_OUTPUT,
  navigationTarget,
  patchActivityEvent,
  type IncomingActivityEvent,
} from '../activityEvents'

const SESSION = 'session-a'

function event(
  over: Partial<IncomingActivityEvent> & Pick<IncomingActivityEvent, 'id' | 'at'>
): IncomingActivityEvent {
  return {
    sessionId: SESSION,
    kind: 'command',
    status: 'ok',
    title: 'Ran a command',
    detail: { kind: 'command', command: { command: 'ls' } },
    ...over,
  }
}

describe('ordering', () => {
  it('keeps events in the order they happened, not the order they arrived', () => {
    let log = emptyActivityLog(SESSION)
    log = appendActivityEvents(log, [
      event({ id: 'c', at: 300 }),
      event({ id: 'a', at: 100 }),
      event({ id: 'b', at: 200 }),
    ])
    expect(log.events.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('places a late event where it happened rather than at the end', () => {
    let log = emptyActivityLog(SESSION)
    log = appendActivityEvents(log, [
      event({ id: 'first', at: 100 }),
      event({ id: 'third', at: 300 }),
    ])
    log = appendActivityEvent(log, event({ id: 'second', at: 200 }))
    expect(log.events.map((e) => e.id)).toEqual(['first', 'second', 'third'])
  })

  it('breaks a tie in time by sequence, so concurrent agents stay stable', () => {
    let log = emptyActivityLog(SESSION)
    log = appendActivityEvents(log, [
      event({ id: 'parent', at: 500, agentId: 'parent' }),
      event({ id: 'child', at: 500, agentId: 'scout' }),
      event({ id: 'other', at: 500, agentId: 'builder' }),
    ])
    expect(log.events.map((e) => e.id)).toEqual(['parent', 'child', 'other'])
    expect(log.events.map((e) => e.seq)).toEqual([1, 2, 3])
  })
})

describe('identity', () => {
  it('treats a repeated id as an update, not a duplicate row', () => {
    let log = emptyActivityLog(SESSION)
    log = appendActivityEvent(
      log,
      event({
        id: 'cmd-1',
        at: 100,
        status: 'pending',
        detail: { kind: 'command', command: { command: 'cargo test', cwd: '/repo' } },
      })
    )
    log = appendActivityEvent(
      log,
      event({
        id: 'cmd-1',
        at: 999,
        status: 'ok',
        detail: {
          kind: 'command',
          command: { command: 'cargo test', exitCode: 0, durationMs: 4200 },
        },
      })
    )
    expect(log.events).toHaveLength(1)
    const [only] = log.events
    expect(only.status).toBe('ok')
    expect(only.at).toBe(100)
    // The update carried no cwd; the field it did not mention must survive.
    expect(only.detail).toMatchObject({
      kind: 'command',
      command: { cwd: '/repo', exitCode: 0, durationMs: 4200 },
    })
  })

  it('survives a replayed stream without doubling the timeline', () => {
    const batch = [
      event({ id: 'a', at: 1 }),
      event({ id: 'b', at: 2 }),
      event({ id: 'c', at: 3 }),
    ]
    let log = appendActivityEvents(emptyActivityLog(SESSION), batch)
    log = appendActivityEvents(log, batch)
    expect(log.events.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('will not let an update move a row it did not create', () => {
    let log = appendActivityEvent(emptyActivityLog(SESSION), event({ id: 'x', at: 100 }))
    log = appendActivityEvent(log, event({ id: 'y', at: 200 }))
    log = appendActivityEvent(log, event({ id: 'x', at: 999, title: 'moved?' }))
    expect(log.events.map((e) => e.id)).toEqual(['x', 'y'])
    expect(log.events[0].at).toBe(100)
  })
})

describe('session isolation', () => {
  it('rejects an event addressed to another session', () => {
    const log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({ id: 'foreign', at: 1, sessionId: 'session-b' })
    )
    expect(log.events).toEqual([])
  })

  it('keeps two sessions' + ' logs entirely separate', () => {
    const a = appendActivityEvent(emptyActivityLog('a'), {
      ...event({ id: '1', at: 1 }),
      sessionId: 'a',
    })
    const b = appendActivityEvent(emptyActivityLog('b'), {
      ...event({ id: '1', at: 1 }),
      sessionId: 'b',
    })
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(1)
    expect(a.events[0].sessionId).toBe('a')
    expect(b.events[0].sessionId).toBe('b')
  })
})

describe('patching', () => {
  it('updates a known event in place', () => {
    let log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({ id: 'cmd', at: 1, status: 'pending' })
    )
    log = patchActivityEvent(log, 'cmd', {
      status: 'error',
      detail: { kind: 'command', command: { command: 'ls', exitCode: 2 } },
    })
    expect(log.events[0].status).toBe('error')
    expect(log.events[0].detail).toMatchObject({ command: { exitCode: 2 } })
  })

  it('does not resurrect an event the cap already dropped', () => {
    const log = emptyActivityLog(SESSION)
    expect(patchActivityEvent(log, 'gone', { status: 'ok' })).toBe(log)
  })
})

describe('cancellation', () => {
  it('marks every in-flight row cancelled and records the stop', () => {
    let log = appendActivityEvents(emptyActivityLog(SESSION), [
      event({ id: 'done', at: 1, status: 'ok' }),
      event({ id: 'running-1', at: 2, status: 'pending' }),
      event({ id: 'running-2', at: 3, status: 'pending' }),
    ])
    log = cancelInFlight(log, 4, 'user pressed stop')

    const byId = Object.fromEntries(log.events.map((e) => [e.id, e]))
    expect(byId['done'].status).toBe('ok')
    expect(byId['running-1'].status).toBe('cancelled')
    expect(byId['running-2'].status).toBe('cancelled')

    const cancel = log.events.at(-1)!
    expect(cancel.kind).toBe('cancelled')
    expect(cancel.detail).toMatchObject({ outcome: { reason: 'user pressed stop' } })
  })

  it('records the stop even when nothing was in flight', () => {
    const log = cancelInFlight(emptyActivityLog(SESSION), 10)
    expect(log.events.map((e) => e.kind)).toEqual(['cancelled'])
  })
})

describe('redaction', () => {
  it('never stores a credential from a command or its output', () => {
    const log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'leak',
        at: 1,
        title: 'Running curl -H "Authorization: Bearer abcdefghijklmnopqrst"',
        detail: {
          kind: 'command',
          command: {
            command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrst" https://api.example.com',
            stdout: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
            stderr: 'token=ghp_1234567890abcdefghijklmnopqrstuvwx',
          },
        },
      })
    )
    const serialized = JSON.stringify(log)
    expect(serialized).not.toContain('abcdefghijklmnopqrst')
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(serialized).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwx')
    expect(serialized).toContain('[redacted:')
    // And the parts that make the row useful are still there.
    expect(serialized).toContain('https://api.example.com')
  })

  it('redacts a diff before it is stored', () => {
    const log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'write',
        at: 1,
        kind: 'file.created',
        title: 'Created deploy.env',
        detail: {
          kind: 'change',
          change: {
            path: 'deploy.env',
            diff: '+API_KEY=aabbccddeeff00112233',
            added: 1,
            removed: 0,
          },
        },
      })
    )
    expect(JSON.stringify(log)).not.toContain('aabbccddeeff00112233')
  })

  it('leaves text with nothing secret in it untouched', () => {
    const log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'clean',
        at: 1,
        detail: {
          kind: 'command',
          command: { command: 'cargo test -p jan-agent-harness', stdout: '75 passed' },
        },
      })
    )
    expect(log.events[0].detail).toMatchObject({
      command: { command: 'cargo test -p jan-agent-harness', stdout: '75 passed' },
    })
  })
})

describe('truncation', () => {
  it('keeps the tail of long output, because the failure is at the end', () => {
    const long = 'progress\n'.repeat(1000) + 'error: the real problem'
    const log = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'noisy',
        at: 1,
        detail: { kind: 'command', command: { command: 'make', stdout: long } },
      })
    )
    const stored = log.events[0].detail as { command: { stdout: string; outputTruncated: boolean } }
    expect(stored.command.stdout.length).toBeLessThanOrEqual(MAX_STORED_OUTPUT)
    expect(stored.command.stdout).toContain('error: the real problem')
    expect(stored.command.outputTruncated).toBe(true)
  })

  it('reports untruncated output as untruncated', () => {
    expect(clampText('short')).toEqual({ text: 'short', truncated: false })
    expect(clampText(undefined)).toEqual({ text: undefined, truncated: false })
  })

  it('drops the oldest events past the cap and says how many', () => {
    let log = emptyActivityLog(SESSION)
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 10; i += 1) {
      log = appendActivityEvent(log, event({ id: `e${i}`, at: i + 1 }))
    }
    expect(log.events).toHaveLength(MAX_EVENTS_PER_SESSION)
    expect(log.dropped).toBe(10)
    expect(log.events[0].id).toBe('e10')
  })
})

describe('filtering and search', () => {
  const log = appendActivityEvents(emptyActivityLog(SESSION), [
    event({
      id: 'read',
      at: 1,
      kind: 'file.read',
      title: 'Read Cargo.toml',
      detail: { kind: 'read', read: { path: 'src-tauri/Cargo.toml', fromLine: 1, toLine: 40 } },
    }),
    event({
      id: 'edit',
      at: 2,
      kind: 'file.edited',
      title: 'Edited main.rs',
      detail: { kind: 'change', change: { path: 'src/main.rs', added: 3, removed: 1 } },
    }),
    event({
      id: 'test',
      at: 3,
      kind: 'verification',
      status: 'error',
      title: 'Tests failed',
      callId: 'call-9',
      detail: {
        kind: 'verification',
        verification: { tool: 'test', command: 'cargo test', failed: 2, passed: 70 },
      },
    }),
    event({
      id: 'perm',
      at: 4,
      kind: 'permission.decided',
      title: 'Permission granted',
      detail: {
        kind: 'permission',
        permission: {
          requestId: 'r1',
          tool: 'bash',
          promptKind: 'exec',
          decision: 'allow_once',
          decidedBy: 'user',
        },
      },
    }),
  ])

  it('selects a whole family with a dotted prefix', () => {
    expect(filterActivity(log, { kinds: ['file.'] }).map((e) => e.id)).toEqual([
      'read',
      'edit',
    ])
  })

  it('selects exact kinds too', () => {
    expect(filterActivity(log, { kinds: ['verification'] }).map((e) => e.id)).toEqual([
      'test',
    ])
  })

  it('filters by status', () => {
    expect(filterActivity(log, { statuses: ['error'] }).map((e) => e.id)).toEqual(['test'])
  })

  it('searches the detail, not only the title', () => {
    // The title says "Read Cargo.toml"; the path is only in the detail.
    expect(filterActivity(log, { query: 'src-tauri' }).map((e) => e.id)).toEqual(['read'])
    expect(filterActivity(log, { query: 'allow_once' }).map((e) => e.id)).toEqual(['perm'])
  })

  it('is case-insensitive and matches numbers in the detail', () => {
    expect(filterActivity(log, { query: 'MAIN.RS' }).map((e) => e.id)).toEqual(['edit'])
    expect(filterActivity(log, { query: '70' }).map((e) => e.id)).toEqual(['test'])
  })

  it('combines filters rather than widening them', () => {
    expect(
      filterActivity(log, { kinds: ['file.'], statuses: ['error'] })
    ).toEqual([])
  })

  it('groups the events of one tool call', () => {
    expect(eventsForCall(log, 'call-9').map((e) => e.id)).toEqual(['test'])
  })

  it('counts by status without omitting a bucket', () => {
    expect(activityCounts(log)).toEqual({
      pending: 0,
      ok: 3,
      error: 1,
      cancelled: 0,
      total: 4,
    })
  })
})

describe('navigation and expansion', () => {
  it('opens a read at the line it started from', () => {
    const [read] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'r',
        at: 1,
        kind: 'file.read',
        detail: { kind: 'read', read: { path: 'a/b.ts', fromLine: 42, toLine: 60 } },
      })
    ).events
    expect(navigationTarget(read)).toEqual({ path: 'a/b.ts', line: 42 })
  })

  it('opens a change at its file', () => {
    const [change] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'c',
        at: 1,
        kind: 'file.edited',
        detail: { kind: 'change', change: { path: 'a/b.ts', diff: '+x' } },
      })
    ).events
    expect(navigationTarget(change)).toEqual({ path: 'a/b.ts' })
  })

  it('offers no target for an event with no location', () => {
    const [git] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'g',
        at: 1,
        kind: 'git',
        detail: { kind: 'git', git: { operation: 'commit', sha: 'abc1234' } },
      })
    ).events
    expect(navigationTarget(git)).toBeNull()
  })

  it('does not offer a chevron for a row with nothing behind it', () => {
    const withDiff = event({
      id: 'd',
      at: 1,
      kind: 'file.edited',
      detail: { kind: 'change', change: { path: 'a', diff: '+x' } },
    })
    const withoutDiff = event({
      id: 'n',
      at: 2,
      kind: 'file.edited',
      detail: { kind: 'change', change: { path: 'a' } },
    })
    const log = appendActivityEvents(emptyActivityLog(SESSION), [withDiff, withoutDiff])
    expect(hasExpandableDetail(log.events[0])).toBe(true)
    expect(hasExpandableDetail(log.events[1])).toBe(false)
  })
})

describe('copying', () => {
  it('copies the record, redacted, with what a reader needs to act on it', () => {
    const [cmd] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'c',
        at: 1,
        status: 'error',
        title: 'Ran cargo test',
        detail: {
          kind: 'command',
          command: {
            command: 'cargo test --token abcdef1234567890',
            cwd: '/repo',
            exitCode: 101,
            durationMs: 1200,
            stderr: 'error: test failed',
          },
        },
      })
    ).events
    const text = copyTextFor(cmd)
    expect(text).toContain('cwd: /repo')
    expect(text).toContain('exit: 101')
    expect(text).toContain('took: 1200ms')
    expect(text).toContain('error: test failed')
    expect(text).not.toContain('abcdef1234567890')
  })

  it('copies a change with its counts and its diff', () => {
    const [change] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'm',
        at: 1,
        kind: 'file.moved',
        title: 'Moved a file',
        detail: {
          kind: 'change',
          change: { path: 'b.ts', fromPath: 'a.ts', added: 2, removed: 1, diff: '+two' },
        },
      })
    ).events
    const text = copyTextFor(change)
    expect(text).toContain('a.ts -> b.ts')
    expect(text).toContain('+2 -1')
    expect(text).toContain('+two')
  })
})

describe('accessibility', () => {
  it('announces the status and the outcome, not just the title', () => {
    const log = appendActivityEvents(emptyActivityLog(SESSION), [
      event({
        id: 'cmd',
        at: 1,
        status: 'error',
        title: 'Ran cargo build',
        detail: { kind: 'command', command: { command: 'cargo build', exitCode: 101 } },
      }),
      event({
        id: 'test',
        at: 2,
        kind: 'verification',
        status: 'error',
        title: 'Ran the test suite',
        detail: {
          kind: 'verification',
          verification: { tool: 'test', command: 'vitest', failed: 2, passed: 45 },
        },
      }),
      event({
        id: 'edit',
        at: 3,
        kind: 'file.edited',
        title: 'Edited main.rs',
        detail: { kind: 'change', change: { path: 'main.rs', added: 12, removed: 3 } },
      }),
      event({ id: 'run', at: 4, status: 'pending', title: 'Running a command' }),
    ])
    const labels = log.events.map(accessibleLabel)
    expect(labels[0]).toBe('Ran cargo build, failed, exit code 101')
    expect(labels[1]).toBe('Ran the test suite, failed, 2 failed, 45 passed')
    expect(labels[2]).toBe('Edited main.rs, succeeded, 12 lines added, 3 removed')
    expect(labels[3]).toBe('Running a command, in progress')
  })

  it('says a permission decision in words', () => {
    const [perm] = appendActivityEvent(
      emptyActivityLog(SESSION),
      event({
        id: 'p',
        at: 1,
        kind: 'permission.decided',
        title: 'Permission for bash',
        detail: {
          kind: 'permission',
          permission: {
            requestId: 'r',
            tool: 'bash',
            promptKind: 'destructive_git',
            decision: 'deny',
          },
        },
      })
    ).events
    expect(accessibleLabel(perm)).toContain('decision deny')
  })
})

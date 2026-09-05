import { describe, expect, it, beforeEach } from 'vitest'
import {
  authorityMayChange,
  useCoworkActiveWork,
  type WorkAuthority,
  type WorkKind,
} from '@/hooks/useCoworkActiveWork'

const SESSION = 'session-a'
const OTHER = 'session-b'

const sandbox: WorkAuthority = {
  folder: '/home/dev/obs-forwarder',
  access: 'review-only',
  destination: 'sandbox',
}

const editing: WorkAuthority = {
  folder: '/home/dev/obs-forwarder',
  access: 'edit-folder',
  destination: 'repository',
}

const store = () => useCoworkActiveWork.getState()

const start = (
  kind: WorkKind,
  over: Partial<{ sessionId: string; authority: WorkAuthority }> = {}
) =>
  store().acquire({
    sessionId: over.sessionId ?? SESSION,
    kind,
    authority: over.authority ?? sandbox,
  })

beforeEach(() => useCoworkActiveWork.setState({ items: {} }))

describe('what holds authority in place', () => {
  // Each of these can still write. None of them may have the folder or the
  // access mode changed underneath it.
  it.each([
    'run',
    'subagent',
    'shell',
    'job',
    'authorizing',
    'revoking',
  ] as const)('blocks a change while a %s is active', (kind) => {
    const done = start(kind)

    expect(authorityMayChange(SESSION)).toBe(false)
    expect(store().blockingKind(SESSION)).toBe(kind)

    done()
    expect(authorityMayChange(SESSION)).toBe(true)
  })

  it('stays blocked until the last overlapping item finishes', () => {
    const run = start('run')
    const shell = start('shell')
    const job = start('job')

    run()
    expect(authorityMayChange(SESSION)).toBe(false)
    shell()
    expect(authorityMayChange(SESSION)).toBe(false)
    job()
    expect(authorityMayChange(SESSION)).toBe(true)
  })

  // A person can stop a run; a revocation finishes on its own. Name the one
  // they can act on.
  it('explains the kind the user can do something about first', () => {
    start('revoking')
    start('run')

    expect(store().blockingKind(SESSION)).toBe('run')
  })

  it('never blocks a session on another session’s work', () => {
    start('run', { sessionId: OTHER })

    expect(authorityMayChange(SESSION)).toBe(true)
    expect(authorityMayChange(OTHER)).toBe(false)
  })

  it('is unblocked when there is no session at all', () => {
    expect(authorityMayChange(null)).toBe(true)
    expect(store().blockingKind(undefined)).toBeNull()
  })
})

describe('ending work exactly once', () => {
  it('is harmless to end twice', () => {
    const done = start('run')

    done()
    done()

    expect(authorityMayChange(SESSION)).toBe(true)
    expect(store().activeFor(SESSION)).toHaveLength(0)
  })

  // The failure this prevents: a late completion event from a finished shell
  // clearing the busy state of the run that is still going.
  it('cannot end another operation’s work', () => {
    const first = start('shell')
    first()
    start('run')

    // The stale handle fires again, long after its own item is gone.
    first()

    expect(authorityMayChange(SESSION)).toBe(false)
    expect(store().blockingKind(SESSION)).toBe('run')
  })

  it('ignores a release for an id that was never registered', () => {
    start('run')

    store().release('work-does-not-exist')

    expect(store().blockingKind(SESSION)).toBe('run')
  })

  // Whatever ends a run — success, refusal, a thrown error, cancellation — the
  // release is the same call in a `finally`, so this is the property that
  // matters: no path leaves it held.
  it('releases when the work threw rather than returned', () => {
    const done = start('run')
    try {
      throw new Error('spawn failed')
    } catch {
      done()
    }

    expect(authorityMayChange(SESSION)).toBe(true)
  })
})

describe('the authority an operation began with', () => {
  // A background job keeps writing where it was authorized to write. A later
  // preference change must not move or widen it.
  it('is kept even after the session’s preference changes', () => {
    start('job', { authority: editing })

    // The user switches back to review only; the job is still running.
    const [job] = store().activeFor(SESSION)

    expect(job.authority).toEqual(editing)
    expect(authorityMayChange(SESSION)).toBe(false)
  })

  it('is recorded per item, so overlapping work does not share one', () => {
    start('run', { authority: editing })
    start('job', { authority: sandbox })

    expect(
      store()
        .activeFor(SESSION)
        .map((one) => one.authority.destination)
        .sort()
    ).toEqual(['repository', 'sandbox'])
  })

  it('carries no grant id or secret', () => {
    start('run', { authority: editing })

    const serialized = JSON.stringify(store().activeFor(SESSION))
    expect(serialized).not.toMatch(/grant/i)
  })
})

describe('tearing a session down', () => {
  it('drops only that session’s work', () => {
    start('run')
    start('run', { sessionId: OTHER })

    store().clearSession(SESSION)

    expect(store().activeFor(SESSION)).toHaveLength(0)
    expect(store().activeFor(OTHER)).toHaveLength(1)
  })

  it('is harmless when the session had nothing running', () => {
    start('run', { sessionId: OTHER })

    store().clearSession(SESSION)

    expect(store().activeFor(OTHER)).toHaveLength(1)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { authorizeDirectEdit, type AuthorizeDeps } from '@/lib/coworkDirectEdit'

const SESSION = 'session-a'
const FOLDER = '/home/dev/obs-forwarder'
const SIBLING = '/home/dev/note-py'
const DATA = '/jan/data'

/** A promise this test decides when to settle. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const deps = (over: Partial<AuthorizeDeps> = {}): AuthorizeDeps => ({
  binding: { sessionId: SESSION, folder: FOLDER },
  dataFolder: DATA,
  authorize: vi.fn(async () => ({ ok: true })),
  revokeSession: vi.fn(async () => true),
  currentBinding: () => ({ sessionId: SESSION, folder: FOLDER }),
  setAccess: vi.fn(),
  ...over,
})

describe('turning direct editing on', () => {
  it('asks the backend before the session says anything about itself', async () => {
    const order: string[] = []
    const d = deps({
      authorize: vi.fn(async () => {
        order.push('authorize')
        return { ok: true }
      }),
      setAccess: vi.fn(() => order.push('setAccess')),
    })

    expect(await authorizeDirectEdit(d)).toBe('granted')
    expect(order).toEqual(['authorize', 'setAccess'])
  })

  it('changes nothing when the backend refuses', async () => {
    const d = deps({ authorize: vi.fn(async () => ({ ok: false })) })

    expect(await authorizeDirectEdit(d)).toBe('refused')
    expect(d.setAccess).not.toHaveBeenCalled()
  })

  it.each([
    ['no session', { sessionId: null, folder: FOLDER }],
    ['no folder', { sessionId: SESSION, folder: null }],
  ])('asks for nothing with %s', async (_name, binding) => {
    const d = deps({ binding })

    expect(await authorizeDirectEdit(d)).toBe('refused')
    expect(d.authorize).not.toHaveBeenCalled()
  })

  it('asks for nothing without a data folder', async () => {
    const d = deps({ dataFolder: null })

    expect(await authorizeDirectEdit(d)).toBe('refused')
    expect(d.authorize).not.toHaveBeenCalled()
  })
})

/**
 * The reply outliving the question.
 *
 * Each of these holds the backend's answer until after the user has moved on,
 * which is the only way the race is visible. A grant that arrives for a
 * binding nobody is on is live authority with no one accountable for it, so it
 * goes straight back and the preference is never set.
 */
describe('a grant that arrives too late', () => {
  const stale = async (movedTo: {
    sessionId: string | null
    folder: string | null
  }) => {
    const gate = deferred<{ ok: boolean }>()
    let live = { sessionId: SESSION as string | null, folder: FOLDER as string | null }
    const d = deps({
      authorize: vi.fn(() => gate.promise),
      currentBinding: () => live,
    })

    const pending = authorizeDirectEdit(d)
    // The user moves on, then the backend answers.
    live = movedTo
    gate.resolve({ ok: true })
    return { result: await pending, d }
  }

  it('is handed back when the folder changed', async () => {
    const { result, d } = await stale({ sessionId: SESSION, folder: SIBLING })

    expect(result).toBe('stale')
    expect(d.revokeSession).toHaveBeenCalledWith(SESSION)
    expect(d.setAccess).not.toHaveBeenCalled()
  })

  it('is handed back when the session changed', async () => {
    const { result, d } = await stale({
      sessionId: 'session-b',
      folder: FOLDER,
    })

    expect(result).toBe('stale')
    expect(d.revokeSession).toHaveBeenCalledWith(SESSION)
    expect(d.setAccess).not.toHaveBeenCalled()
  })

  // Cancelling and detaching land here too: the binding the answer was for is
  // simply not the one in front of the user any more.
  it('is handed back when the folder was detached', async () => {
    const { result, d } = await stale({ sessionId: SESSION, folder: null })

    expect(result).toBe('stale')
    expect(d.setAccess).not.toHaveBeenCalled()
  })

  it('is still not used when handing it back fails', async () => {
    const gate = deferred<{ ok: boolean }>()
    let live = { sessionId: SESSION as string | null, folder: FOLDER as string | null }
    const d = deps({
      authorize: vi.fn(() => gate.promise),
      currentBinding: () => live,
      revokeSession: vi.fn(async () => false),
    })

    const pending = authorizeDirectEdit(d)
    live = { sessionId: SESSION, folder: SIBLING }
    gate.resolve({ ok: true })

    expect(await pending).toBe('stale')
    // Reported as failed to the caller, and still never acted on here.
    expect(d.setAccess).not.toHaveBeenCalled()
  })

  it('is kept when the user never moved', async () => {
    const gate = deferred<{ ok: boolean }>()
    const d = deps({ authorize: vi.fn(() => gate.promise) })

    const pending = authorizeDirectEdit(d)
    gate.resolve({ ok: true })

    expect(await pending).toBe('granted')
    expect(d.setAccess).toHaveBeenCalledWith(SESSION)
    expect(d.revokeSession).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const bindings = vi.hoisted(() => ({
  directEditCapability: vi.fn(),
  directEditAuthorize: vi.fn(),
  directEditRevoke: vi.fn(),
  directEditRevokeSession: vi.fn(),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => bindings)

import { useDirectEditGrants } from '../useDirectEditGrants'
import { effectiveAccess, type AccessCapability } from '@/lib/coworkAccess'

const store = () => useDirectEditGrants.getState()
const SESSION = 'session-a'
const FOLDER = '/home/dev/obs-forwarder'
const DATA = '/jan/data'

const CAN: AccessCapability = { managedWorktree: false, directEdit: true }
const CANNOT: AccessCapability = { managedWorktree: false, directEdit: false }

beforeEach(() => {
  vi.clearAllMocks()
  useDirectEditGrants.setState({
    capability: { known: false, reason: 'loading' },
    bySession: {},
    generation: 0,
  })
  bindings.directEditCapability.mockResolvedValue(true)
  bindings.directEditAuthorize.mockResolvedValue('grant-1')
  bindings.directEditRevoke.mockResolvedValue(true)
  bindings.directEditRevokeSession.mockResolvedValue(1)
})

describe('asking the backend what it can enforce', () => {
  it('takes the answer from the backend rather than deciding here', async () => {
    bindings.directEditCapability.mockResolvedValue(false)

    await store().refreshCapability()

    expect(store().capability).toEqual({ known: true, directEdit: false })
  })

  // An unanswered question is not a yes.
  it('treats a failed query as unknown, not as permission', async () => {
    bindings.directEditCapability.mockRejectedValue(new Error('no backend'))

    await store().refreshCapability()

    expect(store().capability).toMatchObject({ known: false, reason: 'failed' })
  })

  it('starts out unknown before anything is asked', () => {
    expect(store().capability).toEqual({ known: false, reason: 'loading' })
  })
})

describe('holding a grant', () => {
  // The backend's authority lives in its process. If this survived a reload,
  // a restored session would claim editability nothing could honour.
  it('is not persisted', () => {
    expect(
      (useDirectEditGrants as unknown as { persist?: unknown }).persist
    ).toBeUndefined()
  })

  it('keeps a grant under the session it was issued to', async () => {
    const outcome = await store().authorize(SESSION, FOLDER, DATA)

    expect(outcome).toEqual({
      ok: true,
      grant: { sessionId: SESSION, folder: FOLDER, grantId: 'grant-1' },
    })
    expect(store().grantFor(SESSION)?.grantId).toBe('grant-1')
  })

  it('never hands one session’s grant to another', async () => {
    await store().authorize(SESSION, FOLDER, DATA)

    expect(store().grantFor('session-b')).toBeUndefined()
    expect(store().grantFor(null)).toBeUndefined()
  })

  it('reports a refused authorization rather than inventing one', async () => {
    bindings.directEditAuthorize.mockRejectedValue(new Error('invalid root'))

    const outcome = await store().authorize(SESSION, FOLDER, DATA)

    expect(outcome).toEqual({ ok: false, reason: 'invalid root' })
    expect(store().grantFor(SESSION)).toBeUndefined()
  })
})

describe('a reply that outlives the question', () => {
  // The failure this prevents: the user cancels or switches, the backend
  // answers anyway, and a grant nobody is looking at stays live.
  it('is handed back rather than kept', async () => {
    let release: (id: string) => void = () => {}
    bindings.directEditAuthorize.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve
      })
    )

    const pending = store().authorize(SESSION, FOLDER, DATA)
    // The user moves on before the answer arrives.
    await store().revokeSession(SESSION)
    release('grant-late')
    const outcome = await pending

    expect(outcome).toEqual({ ok: false, reason: 'superseded' })
    expect(store().grantFor(SESSION)).toBeUndefined()
    expect(bindings.directEditRevoke).toHaveBeenCalledWith('grant-late')
  })

  it('is superseded by a newer authorization too', async () => {
    let releaseFirst: (id: string) => void = () => {}
    bindings.directEditAuthorize.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseFirst = resolve
      })
    )
    bindings.directEditAuthorize.mockResolvedValueOnce('grant-second')

    const first = store().authorize(SESSION, FOLDER, DATA)
    await store().authorize(SESSION, '/home/dev/note-py', DATA)
    releaseFirst('grant-first')

    expect(await first).toEqual({ ok: false, reason: 'superseded' })
    expect(bindings.directEditRevoke).toHaveBeenCalledWith('grant-first')
    expect(store().grantFor(SESSION)?.grantId).toBe('grant-second')
  })
})

describe('withdrawing a grant', () => {
  it('asks the backend before forgetting it', async () => {
    await store().authorize(SESSION, FOLDER, DATA)

    const revoked = await store().revokeSession(SESSION)

    expect(revoked).toBe(true)
    expect(bindings.directEditRevoke).toHaveBeenCalledWith('grant-1')
    expect(store().grantFor(SESSION)).toBeUndefined()
  })

  // Saying "removed" while knowingly holding one would be the lie. The caller
  // is told the truth so it can show it.
  it('reports failure honestly, and still stops using it here', async () => {
    await store().authorize(SESSION, FOLDER, DATA)
    bindings.directEditRevoke.mockRejectedValue(new Error('backend gone'))

    const revoked = await store().revokeSession(SESSION)

    expect(revoked).toBe(false)
    expect(store().grantFor(SESSION)).toBeUndefined()
  })

  it('is safe when there was nothing to withdraw', async () => {
    const revoked = await store().revokeSession('never-authorized')

    expect(revoked).toBe(true)
    expect(bindings.directEditRevokeSession).toHaveBeenCalledWith(
      'never-authorized'
    )
  })

  it('forgets locally without pretending the backend was asked', async () => {
    await store().authorize(SESSION, FOLDER, DATA)

    store().forget(SESSION)

    expect(store().grantFor(SESSION)).toBeUndefined()
    expect(bindings.directEditRevoke).not.toHaveBeenCalled()
  })
})

describe('what the session may actually do', () => {
  const binding = { sessionId: SESSION, folder: FOLDER }
  const grant = { sessionId: SESSION, folder: FOLDER, grantId: 'grant-1' }

  it('is editable only with capability and a live grant', () => {
    expect(
      effectiveAccess({
        persisted: 'edit-folder',
        capability: CAN,
        grant,
        binding,
      })
    ).toEqual({
      access: 'edit-folder',
      readRoot: FOLDER,
      writeRoot: FOLDER,
      destination: 'repository',
    })
  })

  // The restart case: the preference survives, the authority does not.
  it('falls back to review when the preference has no grant behind it', () => {
    const effective = effectiveAccess({
      persisted: 'edit-folder',
      capability: CAN,
      grant: null,
      binding,
    })

    expect(effective).toMatchObject({
      access: 'review-only',
      downgradedFrom: 'edit-folder',
      reason: 'no-grant',
      writeRoot: null,
      destination: 'sandbox',
    })
  })

  it('falls back when the platform cannot enforce it', () => {
    expect(
      effectiveAccess({
        persisted: 'edit-folder',
        capability: CANNOT,
        grant,
        binding,
      })
    ).toMatchObject({ access: 'review-only', reason: 'no-capability' })
  })

  it('falls back while the capability is still unknown', () => {
    expect(
      effectiveAccess({
        persisted: 'edit-folder',
        capability: CAN,
        grant,
        binding,
        capabilityKnown: false,
      })
    ).toMatchObject({ access: 'review-only', reason: 'capability-unknown' })
  })

  it.each([
    ['another session', { sessionId: 'session-b', folder: FOLDER, grantId: 'g' }],
    ['another folder', { sessionId: SESSION, folder: '/home/dev/note-py', grantId: 'g' }],
  ])('refuses a grant issued for %s', (_name, wrong) => {
    expect(
      effectiveAccess({
        persisted: 'edit-folder',
        capability: CAN,
        grant: wrong,
        binding,
      })
    ).toMatchObject({ access: 'review-only', reason: 'binding-changed' })
  })

  it('leaves review only alone, with no downgrade to explain', () => {
    const effective = effectiveAccess({
      persisted: 'review-only',
      capability: CAN,
      grant,
      binding,
    })

    expect(effective.access).toBe('review-only')
    expect(effective.downgradedFrom).toBeUndefined()
    expect(effective.readRoot).toBe(FOLDER)
  })

  it('says the managed worktree is not available rather than pretending', () => {
    expect(
      effectiveAccess({
        persisted: 'managed-worktree',
        capability: CAN,
        grant,
        binding,
      })
    ).toMatchObject({
      access: 'review-only',
      downgradedFrom: 'managed-worktree',
      reason: 'no-capability',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { COWORK_MODES, type CoworkMode } from '@/lib/coworkMode'
import {
  ACCESS_MODES,
  accessOf,
  consentCovers,
  decideMutation,
  effectiveAccess,
  rootsFor,
  runCarries,
  supports,
  type AccessCapability,
  type AccessMode,
  type MutationInput,
} from '@/lib/coworkAccess'

const BINDING = { sessionId: 's1', folder: '/home/dev/obs-forwarder' }
const CONSENT = { sessionId: 's1', folder: '/home/dev/obs-forwarder' }
const WORKTREE = '/jan/worktrees/s1/obs-forwarder'

/**
 * Everything enforceable, so the matrix can exercise modes the backend cannot
 * hold the line on yet. What production actually supports is asserted on its
 * own, below.
 */
const ALL: AccessCapability = { managedWorktree: true, directEdit: true }

const input = (over: Partial<MutationInput> = {}): MutationInput => ({
  runMode: 'auto',
  access: 'review-only',
  binding: BINDING,
  consent: CONSENT,
  bindingIntact: true,
  unresolvedSkillCount: 0,
  capability: ALL,
  worktreePath: WORKTREE,
  ...over,
})

describe('the run mode and the access mode are different questions', () => {
  // The whole point of the split: being allowed to act without asking says
  // nothing about what may be acted upon.
  it.each(ACCESS_MODES)(
    'refuses every mutation in Review first, whatever the access mode (%s)',
    (access) => {
      const decision = decideMutation(input({ runMode: 'review', access }))

      expect(decision).toEqual({ allowed: false, reason: 'review-mode' })
    }
  )

  it('asks per change in Ask mode, in every access mode', () => {
    for (const access of ACCESS_MODES) {
      const decision = decideMutation(input({ runMode: 'ask', access }))
      expect({ access, ...decision }).toMatchObject({
        access,
        allowed: true,
        needsApproval: true,
      })
    }
  })

  it('does not ask in Autonomous, in every access mode', () => {
    for (const access of ACCESS_MODES) {
      const decision = decideMutation(input({ runMode: 'auto', access }))
      expect({ access, ...decision }).toMatchObject({
        access,
        allowed: true,
        needsApproval: false,
      })
    }
  })
})

describe('the full matrix', () => {
  // Nine combinations, stated rather than reasoned about at each call site.
  const expected: Record<CoworkMode, Record<AccessMode, string>> = {
    review: {
      'review-only': 'refused: review-mode',
      'managed-worktree': 'refused: review-mode',
      'edit-folder': 'refused: review-mode',
    },
    ask: {
      'review-only': 'allowed, asks, to sandbox',
      'managed-worktree': 'allowed, asks, to managed',
      'edit-folder': 'allowed, asks, to repository',
    },
    auto: {
      'review-only': 'allowed, silent, to sandbox',
      'managed-worktree': 'allowed, silent, to managed',
      'edit-folder': 'allowed, silent, to repository',
    },
  }

  const describeDecision = (runMode: CoworkMode, access: AccessMode) => {
    const decision = decideMutation(input({ runMode, access }))
    if (!decision.allowed) return `refused: ${decision.reason}`
    return `allowed, ${decision.needsApproval ? 'asks' : 'silent'}, to ${decision.destination}`
  }

  it('holds for every run mode against every access mode', () => {
    for (const runMode of COWORK_MODES) {
      for (const access of ACCESS_MODES) {
        expect({
          runMode,
          access,
          result: describeDecision(runMode, access),
        }).toEqual({ runMode, access, result: expected[runMode][access] })
      }
    }
  })
})

describe('what refuses before anything else', () => {
  // Ordered by how fundamental the objection is: the answer to "may I write"
  // is meaningless if the repository it referred to is already gone.
  it('refuses a stale binding ahead of every other reason', () => {
    const decision = decideMutation(
      input({
        runMode: 'review',
        access: 'edit-folder',
        consent: undefined,
        unresolvedSkillCount: 3,
        bindingIntact: false,
      })
    )

    expect(decision).toEqual({ allowed: false, reason: 'stale-binding' })
  })

  it('refuses an unresolved skill ahead of the run mode', () => {
    const decision = decideMutation(
      input({ runMode: 'review', unresolvedSkillCount: 1 })
    )

    expect(decision).toEqual({ allowed: false, reason: 'unresolved-skill' })
  })

  it.each([1, 2, 5])(
    'refuses while %i requested skills are unresolved',
    (count) => {
      expect(
        decideMutation(input({ unresolvedSkillCount: count })).allowed
      ).toBe(false)
    }
  )
})

describe('editing the selected folder', () => {
  it('needs consent that names this session and this folder', () => {
    expect(
      decideMutation(input({ access: 'edit-folder', consent: CONSENT })).allowed
    ).toBe(true)
  })

  it('refuses with no consent at all', () => {
    expect(
      decideMutation(input({ access: 'edit-folder', consent: undefined }))
    ).toEqual({ allowed: false, reason: 'no-consent' })
  })

  // Consent is per session and per folder precisely so it cannot follow the
  // user somewhere they never agreed to.
  it('refuses consent given for another folder', () => {
    expect(
      decideMutation(
        input({
          access: 'edit-folder',
          consent: { sessionId: 's1', folder: '/home/dev/note-py' },
        })
      )
    ).toEqual({ allowed: false, reason: 'no-consent' })
  })

  it('refuses consent given in another session', () => {
    expect(
      decideMutation(
        input({
          access: 'edit-folder',
          consent: { sessionId: 's2', folder: BINDING.folder },
        })
      )
    ).toEqual({ allowed: false, reason: 'no-consent' })
  })

  it('does not hold once the folder is detached', () => {
    expect(consentCovers(CONSENT, { sessionId: 's1', folder: null })).toBe(
      false
    )
  })

  // Review only and managed worktree do not touch the checkout, so neither
  // needs the confirmation that editing it does.
  it.each(['review-only', 'managed-worktree'] as const)(
    'is not required by %s',
    (access) => {
      expect(
        decideMutation(input({ access, consent: undefined })).allowed
      ).toBe(true)
    }
  )
})

describe('a mode the backend cannot enforce', () => {
  // Offering "Jan can modify files in this exact folder" while the write gate
  // still refuses every path outside the sandbox would be a promise the
  // product does not keep.
  it.each(['managed-worktree', 'edit-folder'] as const)(
    'refuses %s rather than pretending',
    (access) => {
      expect(
        decideMutation(
          input({
            access,
            capability: { managedWorktree: false, directEdit: false },
          })
        )
      ).toEqual({ allowed: false, reason: 'unsupported-access' })
    }
  )

  it('always supports review only', () => {
    expect(
      supports({ managedWorktree: false, directEdit: false }, 'review-only')
    ).toBe(true)
  })
})

describe('the roots a run uses', () => {
  it('reads the repository and writes the sandbox in review only', () => {
    expect(rootsFor('review-only', { folder: BINDING.folder })).toEqual({
      readRoot: BINDING.folder,
      writeRoot: null,
      destination: 'sandbox',
    })
  })

  // The worktree is the run's whole world. Reading the checkout alongside it
  // would mean reasoning about one tree and changing another.
  it('reads and writes only the worktree in managed mode', () => {
    expect(
      rootsFor('managed-worktree', {
        folder: BINDING.folder,
        worktreePath: WORKTREE,
      })
    ).toEqual({
      readRoot: WORKTREE,
      writeRoot: WORKTREE,
      destination: 'managed',
    })
  })

  it('falls back to the sandbox when a managed worktree has no path yet', () => {
    expect(
      rootsFor('managed-worktree', {
        folder: BINDING.folder,
        worktreePath: null,
      })
    ).toEqual({
      readRoot: BINDING.folder,
      writeRoot: null,
      destination: 'sandbox',
    })
  })

  it('reads and writes the selected folder when editing it', () => {
    expect(rootsFor('edit-folder', { folder: BINDING.folder })).toEqual({
      readRoot: BINDING.folder,
      writeRoot: BINDING.folder,
      destination: 'repository',
    })
  })

  it('writes nowhere when no folder is attached', () => {
    expect(rootsFor('edit-folder', { folder: null })).toEqual({
      readRoot: null,
      writeRoot: null,
      destination: 'sandbox',
    })
  })
})

describe('a session saved before access modes existed', () => {
  // Silence is not consent. Reading a missing field as permission is how a
  // safe default quietly stops being one.
  it('is review only', () => {
    expect(accessOf({})).toBe('review-only')
    expect(accessOf({ access: undefined })).toBe('review-only')
  })

  it('keeps an access mode it was given', () => {
    expect(accessOf({ access: 'edit-folder' })).toBe('edit-folder')
  })
})

describe('a managed worktree in force', () => {
  const base = {
    persisted: 'managed-worktree' as const,
    capability: { managedWorktree: true, directEdit: true },
    capabilityKnown: true,
    binding: { sessionId: 's1', folder: '/repo' },
    worktreePath: '/jan/worktrees/abc/s1',
  }
  const grant = {
    sessionId: 's1',
    folder: '/jan/worktrees/abc/s1',
    grantId: 'g1',
  }

  it('reads and writes the worktree, and not the checkout', () => {
    // The worktree is the run's whole world. Reading the source alongside it
    // would have the agent reasoning about one tree and changing another.
    const effective = effectiveAccess({ ...base, grant })

    expect(effective.access).toBe('managed-worktree')
    expect(effective.readRoot).toBe('/jan/worktrees/abc/s1')
    expect(effective.writeRoot).toBe('/jan/worktrees/abc/s1')
    expect(effective.destination).toBe('managed')
  })

  it('refuses a grant that names the source checkout', () => {
    // The failure that would defeat the entire mode: a grant for /repo would
    // write the very tree the worktree exists to leave alone.
    const effective = effectiveAccess({
      ...base,
      grant: { sessionId: 's1', folder: '/repo', grantId: 'g1' },
    })

    expect(effective.access).toBe('review-only')
    expect(effective.writeRoot).toBeNull()
    expect(effective.reason).toBe('binding-changed')
  })

  it('refuses a grant issued to another session', () => {
    const effective = effectiveAccess({
      ...base,
      grant: { ...grant, sessionId: 'other' },
    })

    expect(effective.access).toBe('review-only')
    expect(effective.reason).toBe('binding-changed')
  })

  it('writes nothing until a worktree actually exists', () => {
    const effective = effectiveAccess({ ...base, worktreePath: null, grant })

    expect(effective.access).toBe('review-only')
    expect(effective.downgradedFrom).toBe('managed-worktree')
    expect(effective.reason).toBe('no-grant')
  })

  it('writes nothing while the backend holds no grant', () => {
    const effective = effectiveAccess({ ...base, grant: null })

    expect(effective.reason).toBe('no-grant')
    expect(effective.writeRoot).toBeNull()
  })

  it('stays in review when the platform cannot confine writes', () => {
    const effective = effectiveAccess({
      ...base,
      capability: { managedWorktree: false, directEdit: false },
      grant,
    })

    expect(effective.reason).toBe('no-capability')
  })

  it('treats an unanswered capability query as a no', () => {
    // An absent answer is not a yes, for this mode as for the other one.
    const effective = effectiveAccess({
      ...base,
      capabilityKnown: false,
      grant,
    })

    expect(effective.access).toBe('review-only')
    expect(effective.downgradedFrom).toBe('managed-worktree')
    expect(effective.reason).toBe('capability-unknown')
  })
})

describe('what a run actually carries', () => {
  const grant = { grantId: 'grant-1' }

  it('reads the worktree, not the checkout, in a managed session', () => {
    const effective = effectiveAccess({
      persisted: 'managed-worktree',
      capability: ALL,
      capabilityKnown: true,
      grant: { sessionId: 's1', folder: WORKTREE, grantId: 'grant-1' },
      binding: BINDING,
      worktreePath: WORKTREE,
    })

    const carried = runCarries(effective, {
      folder: BINDING.folder,
      grantId: grant.grantId,
    })
    // The worktree is the run's whole world. Reading the source alongside it
    // would have the agent reasoning about one tree and changing another.
    expect(carried.readRoot).toBe(WORKTREE)
    expect(carried.writeGrant).toBe('grant-1')
  })

  it('carries no authority in review only, whatever grant exists', () => {
    const effective = effectiveAccess({
      persisted: 'review-only',
      capability: ALL,
      capabilityKnown: true,
      grant: { sessionId: 's1', folder: BINDING.folder, grantId: 'grant-1' },
      binding: BINDING,
      worktreePath: null,
    })

    const carried = runCarries(effective, {
      folder: BINDING.folder,
      grantId: grant.grantId,
    })
    expect(carried.readRoot).toBe(BINDING.folder)
    expect(carried.writeGrant).toBeNull()
  })

  it('carries no authority when the mode was downgraded', () => {
    // The downgrade has to mean something rather than merely display
    // something: a session whose worktree is gone must not still be handing
    // its grant to every tool call.
    const effective = effectiveAccess({
      persisted: 'managed-worktree',
      capability: ALL,
      capabilityKnown: true,
      grant: { sessionId: 's1', folder: WORKTREE, grantId: 'grant-1' },
      binding: BINDING,
      worktreePath: null,
    })

    expect(effective.destination).toBe('sandbox')
    expect(
      runCarries(effective, { folder: BINDING.folder, grantId: 'grant-1' })
        .writeGrant
    ).toBeNull()
  })

  it('writes the attached folder only when that is the destination', () => {
    const effective = effectiveAccess({
      persisted: 'edit-folder',
      capability: ALL,
      capabilityKnown: true,
      grant: { sessionId: 's1', folder: BINDING.folder, grantId: 'grant-1' },
      binding: BINDING,
      worktreePath: null,
    })

    const carried = runCarries(effective, {
      folder: BINDING.folder,
      grantId: 'grant-1',
    })
    expect(carried.readRoot).toBe(BINDING.folder)
    expect(carried.writeGrant).toBe('grant-1')
    // And the three destinations stay distinct all the way through.
    expect(effective.destination).toBe('repository')
  })
})

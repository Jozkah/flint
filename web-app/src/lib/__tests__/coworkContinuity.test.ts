import { describe, expect, it } from 'vitest'
import {
  decideOpening,
  isExplicitDirective,
  recordFor,
  resumesIntoWork,
  type ContinuityRecord,
} from '@/lib/coworkContinuity'

const record = (over: Partial<ContinuityRecord> = {}): ContinuityRecord => ({
  state: 'inspecting',
  folder: '/repo',
  ...over,
})

describe('telling an instruction from an opening remark', () => {
  it.each([
    'implement task 2 now',
    'Implement task 2',
    'please fix the failing test',
    'add a retry to the uploader',
    'refactor the parser and then update the docs',
  ])('reads %j as an instruction', (text) => {
    expect(isExplicitDirective(text)).toBe(true)
  })

  it.each([
    'read this project',
    'learn it',
    'continue where the other harness stopped',
    'probably task 1',
    'check the plan',
    'what does this repo do?',
    '',
  ])('does not read %j as an instruction', (text) => {
    expect(isExplicitDirective(text)).toBe(false)
  })

  it('treats a hedge as the uncertainty it is', () => {
    // "probably implement task 2" is someone thinking out loud. Acting on it is
    // the exact behaviour this module exists to stop.
    expect(isExplicitDirective('probably implement task 2')).toBe(false)
    expect(isExplicitDirective('maybe fix the parser')).toBe(false)
    expect(isExplicitDirective('i think we should update the docs')).toBe(false)
  })

  it('does not take a report of an instruction as one', () => {
    // Describing what a document says is not asking for it to be done.
    expect(isExplicitDirective('the plan says to implement task 2')).toBe(false)
    expect(
      isExplicitDirective('the README recommends running the migration')
    ).toBe(false)
  })

  it('ignores verbs quoted from code', () => {
    // A pasted snippet must not be able to instruct.
    expect(isExplicitDirective('what does `rm -rf build` do here?')).toBe(false)
    expect(
      isExplicitDirective('explain this:\n```\ndelete the row\n```')
    ).toBe(false)
  })

  it('does not fire on a verb buried mid-sentence', () => {
    expect(
      isExplicitDirective('the uploader will add a retry when it fails')
    ).toBe(false)
  })
})

describe('what to do with an opening turn', () => {
  it('inspects first when the request does not say what to change', () => {
    expect(
      decideOpening({ folder: '/repo', priorTurns: 0, text: 'learn it' })
    ).toBe('inspect-and-propose')
  })

  it('follows a request that plainly says what to change', () => {
    expect(
      decideOpening({
        folder: '/repo',
        priorTurns: 0,
        text: 'implement task 2 now',
      })
    ).toBe('follow-the-request')
  })

  it('leaves sessions with no repository alone', () => {
    // Nothing to protect, and gating here would make the ordinary case worse.
    expect(
      decideOpening({ folder: null, priorTurns: 0, text: 'learn it' })
    ).toBe('follow-the-request')
  })

  it('only gates the opening turn', () => {
    // Once the user has seen the repository and answered a proposal,
    // second-guessing plain requests is an obstacle, not a safeguard.
    expect(
      decideOpening({ folder: '/repo', priorTurns: 4, text: 'now do task 3' })
    ).toBe('follow-the-request')
  })

  it('treats an answer to a proposal as an answer, not a new opening', () => {
    expect(
      decideOpening({
        folder: '/repo',
        priorTurns: 0,
        text: 'yes, go ahead',
        record: record({ state: 'awaiting-continuation' }),
      })
    ).toBe('follow-the-request')
  })

  it('defaults to inspecting when it cannot tell', () => {
    // The asymmetry, stated as a test: a misread request costs a round trip,
    // never an unwanted edit.
    expect(
      decideOpening({
        folder: '/repo',
        priorTurns: 0,
        text: 'hmm, this looks like the thing from last week',
      })
    ).toBe('inspect-and-propose')
  })
})

describe('a record belongs to one repository', () => {
  it('ignores a record left over from another folder', () => {
    // Rebinding must not carry a proposal about one repository to another.
    expect(recordFor(record({ folder: '/other' }), '/repo')).toBeNull()
  })

  it('keeps a record for the folder it names', () => {
    expect(recordFor(record(), '/repo')).not.toBeNull()
  })

  it('has no record when nothing is attached', () => {
    expect(recordFor(record(), null)).toBeNull()
  })
})

describe('resuming', () => {
  it('does not resume into work on an unanswered proposal', () => {
    // The regression this guards: a session saved mid-proposal, reopened, and
    // executing because the state was on disk.
    expect(resumesIntoWork(record({ state: 'awaiting-continuation' }))).toBe(
      false
    )
  })

  it.each(['inspecting', 'completed', 'blocked', 'cancelled'] as const)(
    'does not resume into work from %s',
    (state) => {
      expect(resumesIntoWork(record({ state }))).toBe(false)
    }
  )

  it('resumes work that was already under way', () => {
    expect(resumesIntoWork(record({ state: 'executing' }))).toBe(true)
  })

  it('resumes nothing without a record', () => {
    expect(resumesIntoWork(null)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import {
  isMissingPathError,
  planReviewDecision,
  planReviewRequest,
  renderPlanReviewResult,
  planExecuteNotice,
  PLAN_EXECUTE_INSTRUCTION,
} from '../coworkPlanReview'
import { parseAskRequest } from '../coworkAsk'
import {
  EXECUTE_PLAN_LABEL,
  EXIT_PLAN_LABEL,
  KEEP_PLANNING_LABEL,
  PLAN_REVIEW_QUESTION_ID,
} from '../coworkPrompt'

const review = { questions: [{ id: PLAN_REVIEW_QUESTION_ID }] }
const answer = (label: string) => [{ id: PLAN_REVIEW_QUESTION_ID, selected: [label] }]

describe('plan review (janhq/jan#8906)', () => {
  it('recognises the missing-file errors both platforms produce', () => {
    expect(isMissingPathError('ERROR: No such file or directory (os error 2)')).toBe(true)
    expect(
      isMissingPathError('The system cannot find the file specified. (os error 2)')
    ).toBe(true)
    expect(isMissingPathError('ERROR: permission denied (os error 13)')).toBe(false)
  })

  it('asks a question the ask card can render, with the three plan choices', () => {
    const parsed = parseAskRequest(planReviewRequest('index.html'))
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.questions[0].id).toBe(PLAN_REVIEW_QUESTION_ID)
    expect(parsed.questions[0].question).toContain('index.html')
    expect(parsed.questions[0].options.map((o) => o.label)).toEqual([
      EXECUTE_PLAN_LABEL,
      KEEP_PLANNING_LABEL,
      EXIT_PLAN_LABEL,
    ])
  })

  it('maps each answer to a decision, and anything else to keep planning', () => {
    expect(planReviewDecision(review, answer(EXECUTE_PLAN_LABEL))).toBe('execute')
    expect(planReviewDecision(review, answer(EXIT_PLAN_LABEL))).toBe('exit')
    expect(planReviewDecision(review, answer(KEEP_PLANNING_LABEL))).toBe('keep')
    // A dismissed card never makes anything writable.
    expect(planReviewDecision(review, null)).toBe('keep')
    expect(
      planReviewDecision(review, [
        { id: PLAN_REVIEW_QUESTION_ID, selected: [], custom_input: 'just do it' },
      ])
    ).toBe('keep')
  })

  it('leaves every other question alone', () => {
    expect(
      planReviewDecision({ questions: [{ id: 'scope' }] }, [
        { id: 'scope', selected: ['Yes'] },
      ])
    ).toBe('none')
  })

  // The model asks in its own words in plan mode; choosing "Execute plan" on
  // its card must leave plan mode, not come back as a bare answer.
  it('treats a model-written question offering Execute plan as a plan review', () => {
    const own = {
      questions: [
        {
          id: 'next',
          options: [{ label: 'Execute plan' }, { label: 'Revise the plan' }],
        },
      ],
    }
    expect(planReviewDecision(own, [{ id: 'next', selected: ['execute plan'] }])).toBe(
      'execute'
    )
    expect(planReviewDecision(own, [{ id: 'next', selected: ['Revise the plan'] }])).toBe(
      'keep'
    )
    expect(planReviewDecision(own, null)).toBe('keep')
  })

  it('ends this read-only run so the plan continues in one that can write', () => {
    const result = renderPlanReviewResult('execute', answer(EXECUTE_PLAN_LABEL))
    expect(result.endsTurn).toBe(true)
    expect(result.output).toMatch(/Plan mode is off/)
    expect(result.output).toMatch(/Do not call any tool that writes/)
    expect(PLAN_EXECUTE_INSTRUCTION).toMatch(/Carry it out/)
    expect(renderPlanReviewResult('exit', answer(EXIT_PLAN_LABEL)).output).toMatch(
      /no further tool calls/
    )
    expect(renderPlanReviewResult('keep', null).output).toMatch(/Stay read-only/)
  })

  it('never reports an unanswered review as approval', () => {
    const out = renderPlanReviewResult('keep', null).output
    expect(out).toMatch(/did not answer/)
    expect(out).toMatch(/not approval/)
  })

  it('says why an approved plan cannot change the user files', () => {
    expect(planExecuteNotice({ folder: null, access: 'review-only' })).toBe('noFolder')
    expect(planExecuteNotice({ folder: '/repo', access: 'review-only' })).toBe('reviewOnly')
    expect(planExecuteNotice({ folder: '/repo', access: 'edit-folder' })).toBeNull()
  })
})

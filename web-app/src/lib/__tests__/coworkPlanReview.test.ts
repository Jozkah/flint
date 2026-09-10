import { describe, it, expect } from 'vitest'
import {
  isMissingPathError,
  planReviewDecision,
  planReviewRequest,
  renderPlanReviewResult,
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
        { id: 'scope', selected: [EXECUTE_PLAN_LABEL] },
      ])
    ).toBe('none')
  })

  it('tells the model this run stays read-only after approval', () => {
    const out = renderPlanReviewResult('execute', answer(EXECUTE_PLAN_LABEL)).output
    expect(out).toMatch(/next message/)
    expect(out).toMatch(/do not call any tool that writes/)
    expect(renderPlanReviewResult('exit', answer(EXIT_PLAN_LABEL)).output).toMatch(
      /no further tool calls/
    )
    expect(renderPlanReviewResult('keep', null).output).toMatch(/Stay read-only/)
  })
})

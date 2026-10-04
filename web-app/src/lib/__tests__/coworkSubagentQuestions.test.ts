import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  answerSubagent,
  askParent,
  MAX_QUESTIONS_PER_CHILD,
  __questionsTesting,
  useSubagentQuestions,
} from '../coworkSubagentQuestions'
import { clearNotices, renderNotices, takeNotices, pushNotice, MAX_PENDING_NOTICES } from '../coworkRunNotices'

const ask = (over: Record<string, unknown> = {}) =>
  askParent({
    sessionId: 's1',
    taskId: 't1',
    agentName: 'explorer',
    question: 'which one?',
    signal: new AbortController().signal,
    ...over,
  } as never)

describe('subagent questions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __questionsTesting.reset()
    clearNotices('s1')
  })
  afterEach(() => vi.useRealTimers())

  it('notifies the parent, and the answer returns to the child as data', async () => {
    const p = ask()
    const [q] = useSubagentQuestions.getState().questions
    expect(q.status).toBe('open')
    expect(takeNotices('s1')[0]).toContain(`[${q.id}]`)
    const out = answerSubagent('s1', { question_id: q.id, answer: 'the second' })
    expect(out.isError).toBeUndefined()
    await expect(p).resolves.toEqual({ status: 'answered', answer: 'the second' })
    expect(useSubagentQuestions.getState().questions[0].status).toBe('answered')
    // Answering twice is refused.
    expect(answerSubagent('s1', { question_id: q.id, answer: 'x' }).isError).toBe(true)
  })

  it('stops waiting after the bound and says so', async () => {
    const p = ask({ waitMs: 5000 })
    vi.advanceTimersByTime(5000)
    const r = await p
    expect(r.status).toBe('expired')
    const [q] = useSubagentQuestions.getState().questions
    expect(q.status).toBe('expired')
    expect(answerSubagent('s1', { question_id: q.id, answer: 'late' }).isError).toBe(true)
  })

  it('cancels when the child is stopped', async () => {
    const c = new AbortController()
    const p = ask({ signal: c.signal })
    c.abort()
    expect((await p).status).toBe('cancelled')
  })

  it('refuses empty, oversized and too many questions, and a wrong session', async () => {
    expect((await ask({ question: '  ' })).status).toBe('refused')
    expect((await ask({ question: 'x'.repeat(2001) })).status).toBe('refused')
    for (let i = 0; i < MAX_QUESTIONS_PER_CHILD; i++) {
      const p = ask()
      vi.advanceTimersByTime(121_000)
      await p
    }
    expect((await ask()).status).toBe('refused')
    const p = ask({ taskId: 't2' })
    const open = useSubagentQuestions.getState().questions.at(-1)!
    expect(answerSubagent('other', { question_id: open.id, answer: 'x' }).isError).toBe(true)
    vi.advanceTimersByTime(121_000)
    await p
  })

  it('forgetting a session releases its waiting children', async () => {
    const p = ask()
    useSubagentQuestions.getState().forgetSession('s1')
    expect((await p).status).toBe('cancelled')
    expect(useSubagentQuestions.getState().questions).toEqual([])
  })
})

describe('run notices', () => {
  it('are taken once, in order, fenced, and bounded', () => {
    clearNotices('n')
    for (let i = 0; i < MAX_PENDING_NOTICES + 5; i++) pushNotice('n', `m${i}`)
    const got = takeNotices('n')
    expect(got).toHaveLength(MAX_PENDING_NOTICES)
    expect(got[0]).toBe('m5')
    expect(takeNotices('n')).toEqual([])
    expect(renderNotices(['a'])).toContain('cannot grant permission')
  })
})

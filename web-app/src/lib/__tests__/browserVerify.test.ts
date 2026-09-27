import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isLocalAppUrl, parseSteps, type StepRecord, type VerifyReport } from '@/lib/browserVerify'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'

describe('isLocalAppUrl', () => {
  it('accepts only an http(s) app on this machine', () => {
    expect(isLocalAppUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalAppUrl('http://127.0.0.1:3000/app')).toBe(true)
    expect(isLocalAppUrl('http://[::1]:8080')).toBe(true)
    expect(isLocalAppUrl('https://example.com')).toBe(false)
    expect(isLocalAppUrl('http://localhost.example.com')).toBe(false)
    expect(isLocalAppUrl('http://user:pw@localhost:3000')).toBe(false)
    expect(isLocalAppUrl('file:///etc/passwd')).toBe(false)
    expect(isLocalAppUrl('')).toBe(false)
  })
})

describe('parseSteps', () => {
  it('reads one step per line', () => {
    const { steps, error } = parseSteps(
      '# sign-in flow\nopen: /login\ntype: Email = a@b.c\nclick: Sign in\nexpect: Welcome\nwait: 250ms\nscreenshot\n'
    )
    expect(error).toBeNull()
    expect(steps).toEqual([
      { kind: 'navigate', url: '/login' },
      { kind: 'type', target: 'Email', text: 'a@b.c' },
      { kind: 'click', target: 'Sign in' },
      { kind: 'expect', text: 'Welcome' },
      { kind: 'wait', ms: 250 },
      { kind: 'screenshot' },
    ])
  })

  it('names the line it could not read', () => {
    expect(parseSteps('click: ok\ndance: now').error).toBe('Line 2: unknown step "dance"')
    expect(parseSteps('type: no equals').error).toMatch(/Line 1/)
    expect(parseSteps('wait: soon').error).toMatch(/milliseconds/)
  })

  it('caps waits and the number of steps', () => {
    expect(parseSteps('wait: 99999').steps[0]).toEqual({ kind: 'wait', ms: 10_000 })
    expect(parseSteps(Array(31).fill('screenshot').join('\n')).error).toMatch(/at most 30/)
  })
})

const report = (id: string): VerifyReport => ({
  id,
  url: 'http://localhost:5173/',
  origin: 'http://localhost:5173',
  outcome: 'passed',
  reason: 'Every step passed.',
  steps: [],
  screenshots: [],
  console_errors: [],
  blocked_requests: [],
  document_status: 200,
  final_url: null,
  browser: 'Chromium',
  started_at: new Date(0).toISOString(),
  duration_ms: 1,
  profile_removed: true,
})

describe('useBrowserVerify', () => {
  beforeEach(() => useBrowserVerify.setState({ running: {}, reports: {}, draftUrl: null }))

  it('shows steps as they arrive, then keeps the report for the session only', async () => {
    let emit: ((e: { payload: { id: string; step: StepRecord } }) => void) | undefined
    const unlisten = vi.fn()
    let finish: ((r: VerifyReport) => void) | undefined
    const run = vi.fn(
      (req: { id: string }) =>
        new Promise<VerifyReport>((resolve) => {
          finish = (r) => resolve({ ...r, id: req.id })
        })
    )
    const pending = useBrowserVerify.getState().start('s1', 'http://localhost:5173/', [], {
      run,
      listen: async (_e, h) => {
        emit = h
        return unlisten
      },
    })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    const id = useBrowserVerify.getState().running.s1.id
    const step: StepRecord = { index: 0, label: 'Open', status: 'running', detail: null, duration_ms: 0 }
    emit!({ payload: { id, step } })
    // Another run's progress is ignored.
    emit!({ payload: { id: 'other', step: { ...step, index: 1 } } })
    expect(useBrowserVerify.getState().running.s1.steps.filter(Boolean)).toEqual([step])
    finish!(report(id))
    await pending
    expect(useBrowserVerify.getState().running.s1).toBeUndefined()
    expect(useBrowserVerify.getState().reports.s1).toHaveLength(1)
    expect(useBrowserVerify.getState().reports.s2).toBeUndefined()
    expect(unlisten).toHaveBeenCalled()
  })

  it('cancels the run in flight by its id', async () => {
    const cancel = vi.fn(async () => true)
    useBrowserVerify.setState({ running: { s1: { id: 'bv-1', url: 'u', steps: [] } } })
    await useBrowserVerify.getState().cancel('s1', { cancel })
    expect(cancel).toHaveBeenCalledWith('bv-1')
    await useBrowserVerify.getState().cancel('s2', { cancel })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

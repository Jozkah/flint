/** AH-029/AH-030: a run that stopped getting anywhere is stopped. */
import { describe, expect, it } from 'vitest'
import {
  canonicalKey,
  detectLoop,
  loopStopMessage,
  type ObservedCall,
} from '../runLoopGuard'

const call = (over: Partial<ObservedCall> = {}): ObservedCall => ({
  tool: 'read',
  input: { path: 'a.ts' },
  ...over,
})

it('lets ordinary work through', () => {
  expect(
    detectLoop([
      call({ input: { path: 'a.ts' } }),
      call({ tool: 'edit', input: { path: 'a.ts', text: '1' }, path: 'a.ts', after: '1' }),
      call({ tool: 'edit', input: { path: 'a.ts', text: '2' }, path: 'a.ts', after: '12' }),
      call({ tool: 'bash', input: { command: 'npm test' } }),
    ])
  ).toEqual({ tripped: false })
})

it('stops the second failure after the shell said not to retry', () => {
  const nul = (n: number) =>
    call({
      tool: 'bash',
      input: { command: `go build ./... ${n}` },
      failed: true,
      error: `open NUL: Access is denied ${n}\n[device_path: ... Report it to the user rather than retrying.]`,
    })
  expect(detectLoop([nul(1)])).toEqual({ tripped: false })
  const verdict = detectLoop([nul(1), call(), nul(2)])
  expect(verdict.tripped && verdict.reason).toBe('failing-shell')
})

it('stops the same call made over and over', () => {
  // Three is ordinary -- re-reading a file after editing it, running the same
  // test twice while fixing it. Five is a model going in circles.
  expect(detectLoop([call(), call(), call()])).toEqual({ tripped: false })
  const verdict = detectLoop([call(), call(), call(), call(), call()])
  expect(verdict).toMatchObject({ tripped: true, reason: 'repeated-call' })
})

it('is not fooled by a different spelling of the same call', () => {
  expect(canonicalKey({ tool: 'read', input: { a: 1, b: 2 } })).toBe(
    canonicalKey({ tool: 'read', input: { b: 2, a: 1 } })
  )
  const verdict = detectLoop([
    call({ input: { path: 'a.ts', mode: 'r' } }),
    call({ input: { mode: 'r', path: 'a.ts' } }),
    call({ input: { path: ' a.ts ', mode: 'r' } }),
    call({ input: { mode: 'r', path: ' a.ts ' } }),
    call({ input: { path: 'a.ts', mode: 'r' } }),
  ])
  expect(verdict).toMatchObject({ tripped: true, reason: 'equivalent-call' })
})

it('stops a call that keeps failing the same way', () => {
  const failing = (input: unknown) =>
    call({ tool: 'bash', input, failed: true, error: 'command not found' })
  const verdict = detectLoop([
    failing({ command: 'foo 1' }),
    failing({ command: 'foo 2' }),
    failing({ command: 'foo 3' }),
  ])
  expect(verdict).toMatchObject({ tripped: true, reason: 'repeated-failure' })
})

it('does not count two different failures as a repeat', () => {
  expect(
    detectLoop([
      call({ tool: 'bash', input: { command: 'a' }, failed: true, error: 'x' }),
      call({ tool: 'bash', input: { command: 'b' }, failed: true, error: 'y' }),
      call({ tool: 'bash', input: { command: 'c' }, failed: true, error: 'z' }),
    ])
  ).toEqual({ tripped: false })
})

it('stops an edit/revert cycle, but not a file being built up', () => {
  const write = (n: number, after: string) =>
    call({ tool: 'edit', input: { path: 'a.ts', n }, path: 'a.ts', after })

  expect(
    detectLoop([write(1, 'A'), write(2, 'B'), write(3, 'A'), write(4, 'B')])
  ).toMatchObject({ tripped: true, reason: 'no-progress' })

  expect(
    detectLoop([write(1, 'A'), write(2, 'AB'), write(3, 'ABC'), write(4, 'ABCD')])
  ).toEqual({ tripped: false })
})

it('stops delegation that keeps delegating', () => {
  expect(
    detectLoop([call({ tool: 'task', input: { name: 'x' }, depth: 3 })])
  ).toMatchObject({ tripped: true, reason: 'recursive-delegation' })
  expect(
    detectLoop([call({ tool: 'task', input: { name: 'x' }, depth: 1 })])
  ).toEqual({ tripped: false })
})

it('gives the same verdict on the same history, so a restart agrees with itself', () => {
  const history = [call(), call(), call(), call(), call()]
  expect(detectLoop(history)).toEqual(detectLoop([...history]))
})

it('tells the model to stop rather than to try again', () => {
  const verdict = detectLoop([call(), call(), call(), call(), call()])
  const message = loopStopMessage(verdict as never)
  expect(message).toContain('not making progress')
  expect(message).toContain('wait for instructions')
})

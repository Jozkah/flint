import { describe, it, expect, vi } from 'vitest'
import {
  BackgroundTasks,
  RETAINED_WINDOW_CHARS,
  renderTaskStatus,
  runBackgroundTool,
} from '../coworkBackgroundTasks'
import type { ToolOutcome } from '../coworkRunner'

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('BackgroundTasks', () => {
  it('returns at once while the child runs, then reports it done', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    const info = tasks.start('c1', 'explorer', () => gate.promise, () => true)
    expect(info.state).toBe('running')
    expect(tasks.status('c1')?.state).toBe('running')
    expect(tasks.running()).toHaveLength(1)

    gate.resolve({ output: 'found it' })
    const outcome = await tasks.await('c1')
    expect(outcome?.output).toBe('found it')
    expect(tasks.status('c1')?.state).toBe('done')
    expect(tasks.running()).toHaveLength(0)
    // Awaiting again returns the same answer rather than failing.
    expect((await tasks.await('c1'))?.output).toBe('found it')
  })

  it('runs children at the same time', async () => {
    const tasks = new BackgroundTasks()
    const a = deferred<ToolOutcome>()
    const b = deferred<ToolOutcome>()
    tasks.start('a', 'x', () => a.promise, () => true)
    tasks.start('b', 'y', () => b.promise, () => true)
    expect(tasks.running().map((t) => t.id)).toEqual(['a', 'b'])
    b.resolve({ output: 'B' })
    expect((await tasks.await('b'))?.output).toBe('B')
    // `a` is still running while `b` is already collected.
    expect(tasks.status('a')?.state).toBe('running')
    a.resolve({ output: 'A' })
    await tasks.settleAll()
    expect(tasks.running()).toHaveLength(0)
  })

  it('records a failed outcome, and a throw as a failure the parent can read', async () => {
    const tasks = new BackgroundTasks()
    tasks.start('f', 'x', async () => ({ output: 'ERROR: nope', isError: true }), () => true)
    tasks.start('t', 'x', async () => {
      throw new Error('boom')
    }, () => true)
    await tasks.settleAll()
    expect(tasks.status('f')?.state).toBe('failed')
    expect(tasks.status('t')?.state).toBe('failed')
    expect((await tasks.await('t'))?.output).toContain('boom')
  })

  it('cancels through the handle it was given, and reports cancelled', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    const cancel = vi.fn(() => {
      gate.resolve({ output: '(the subagent was cancelled)', isError: true })
      return true
    })
    tasks.start('c', 'x', () => gate.promise, cancel)
    expect(tasks.cancel('c')).toBe('cancelled')
    expect(cancel).toHaveBeenCalledTimes(1)
    await tasks.settleAll()
    expect(tasks.status('c')?.state).toBe('cancelled')
    expect(tasks.cancel('c')).toBe('finished')
    expect(tasks.cancel('never')).toBe('unknown')
  })

  it('stops waiting when the awaiting call is aborted, leaving the child running', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    tasks.start('w', 'x', () => gate.promise, () => true)
    const controller = new AbortController()
    const waiting = tasks.await('w', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    expect(tasks.status('w')?.state).toBe('running')
  })

  it('answers undefined for a task this run never started', async () => {
    expect(await new BackgroundTasks().await('nope')).toBeUndefined()
  })

  describe('a cut answer', () => {
    const full = Array.from({ length: 40_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

    it('keeps the whole text and tells the model how to read the rest', async () => {
      const tasks = new BackgroundTasks(9_000)
      tasks.start('big', 'x', async () => ({ output: 'head…tail', full }), () => true)
      const outcome = await tasks.await('big')
      expect(outcome?.full).toBeUndefined()
      expect(outcome?.output).toContain('await_task with task_id=big and offset=9000')
    })

    it('reads the rest back a window at a time to the end', async () => {
      const tasks = new BackgroundTasks()
      tasks.start('big', 'x', async () => ({ output: 'cut', full }), () => true)
      await tasks.settleAll()
      const first = await runBackgroundTool('await_task', { task_id: 'big', offset: 9_000 }, tasks)
      expect(first.output.startsWith(full.slice(9_000, 9_050))).toBe(true)
      expect(first.output).toContain(`offset=${9_000 + RETAINED_WINDOW_CHARS}`)
      const last = await runBackgroundTool('await_task', { task_id: 'big', offset: 39_000 }, tasks)
      expect(last.output).toContain('the end of the answer')
      const past = await runBackgroundTool('await_task', { task_id: 'big', offset: 40_000 }, tasks)
      expect(past.isError).toBe(true)
      const none = await runBackgroundTool('await_task', { task_id: 'small', offset: 0 }, tasks)
      expect(none.isError).toBe(true)
    })

    it('keeps only the most recent cut answers', () => {
      const tasks = new BackgroundTasks()
      for (let i = 0; i < 11; i += 1) tasks.retain(`r${i}`, 'x'.repeat(50))
      expect(tasks.readRetained('r0', 0)).toMatch(/^ERROR/)
      expect(tasks.readRetained('r10', 0)).not.toMatch(/^ERROR/)
    })

    it('collects a foreground answer the same way', () => {
      const tasks = new BackgroundTasks(9_000)
      const out = tasks.collect('call-1', { output: 'cut', full })
      expect(out.output).toContain('task_id=call-1')
      expect(tasks.collect('call-2', { output: 'short' })).toEqual({ output: 'short' })
    })
  })
})

describe('the three tools', () => {
  it('task_status lists every task, or one, without waiting', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    tasks.start('a', 'explorer', () => gate.promise, () => true, () => 1_000)
    const all = await runBackgroundTool('task_status', {}, tasks, { now: () => 6_000 })
    expect(all.output).toContain('a [explorer] running, 5s')
    const one = await runBackgroundTool('task_status', { task_id: 'a' }, tasks)
    expect(one.output).toContain('a [explorer]')
    const missing = await runBackgroundTool('task_status', { task_id: 'zz' }, tasks)
    expect(missing.isError).toBe(true)
    expect(renderTaskStatus([], 0)).toContain('No background tasks')
  })

  it('await_task waits for the child and returns its outcome', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    tasks.start('a', 'x', () => gate.promise, () => true)
    const waiting = runBackgroundTool('await_task', { task_id: 'a' }, tasks)
    gate.resolve({ output: 'answer' })
    expect((await waiting).output).toBe('answer')
  })

  it('cancel_task says what it did', async () => {
    const tasks = new BackgroundTasks()
    const gate = deferred<ToolOutcome>()
    tasks.start('a', 'x', () => gate.promise, () => { gate.resolve({ output: 'x', isError: true }); return true })
    expect((await runBackgroundTool('cancel_task', { task_id: 'a' }, tasks)).output).toContain('Cancelled a')
    await tasks.settleAll()
    expect((await runBackgroundTool('cancel_task', { task_id: 'a' }, tasks)).output).toContain('already finished')
    expect((await runBackgroundTool('cancel_task', { task_id: 'q' }, tasks)).isError).toBe(true)
  })

  it('needs a task_id for await and cancel', async () => {
    const tasks = new BackgroundTasks()
    expect((await runBackgroundTool('await_task', {}, tasks)).isError).toBe(true)
    expect((await runBackgroundTool('cancel_task', null, tasks)).isError).toBe(true)
  })
})

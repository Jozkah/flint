import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({ executeAgentTool }))

const { executeWebTool } = vi.hoisted(() => ({ executeWebTool: vi.fn() }))
vi.mock('@/lib/webSearchTool', () => ({
  WEB_TOOL_NAMES: new Set(['web_search', 'web_fetch']),
  executeWebTool,
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import type { PendingToolCall } from '../coworkRunner'
import type { CoworkMode } from '../coworkMode'

const call = (toolName: string, input: unknown = {}): PendingToolCall => ({
  toolCallId: 'c1',
  toolName,
  input,
})

const ctx = (over = {}) => ({
  sessionId: 's1',
  readOnlyFolder: null,
  mode: 'auto' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  ...over,
})

describe('dispatchCoworkTool', () => {
  beforeEach(() => {
    executeAgentTool.mockReset()
    executeAgentTool.mockResolvedValue({ content: 'ok' })
  })

  // The trailing 'session' is load-bearing: under the default 'thread' scope a
  // session's files land where the thread sweep's keep-list can never mention
  // them, and the sweep deletes the only copy of the agent's work.
  it('routes built-ins to the Rust plugin with the session as workspace key', async () => {
    const c = ctx()
    await dispatchCoworkTool(call('read', { path: 'a' }), c)
    expect(executeAgentTool).toHaveBeenCalledWith(
      'read',
      { path: 'a' },
      's1',
      null,
      'session'
    )
  })

  it('routes the client-only tools to their handlers', async () => {
    const c = ctx()
    expect((await dispatchCoworkTool(call('todo'), c)).output).toBe('todo ok')
    expect((await dispatchCoworkTool(call('ask'), c)).output).toBe('ask ok')
    expect((await dispatchCoworkTool(call('task'), c)).output).toBe('task ok')
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  // Withholding a tool from the advertised set is not authoritative: a model
  // can still emit a call for one. Without this the run would happily write
  // files in a mode whose entire promise is that it does not.
  it('refuses a mutating tool in review mode even though it was never advertised', async () => {
    const c = ctx({ mode: 'review' })
    const out = await dispatchCoworkTool(call('write', { path: 'a' }), c)
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/disabled in review mode/)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('still allows reads in review mode', async () => {
    await dispatchCoworkTool(call('read'), ctx({ mode: 'review' }))
    expect(executeAgentTool).toHaveBeenCalled()
  })

  it('asks before a mutation, and runs it once allowed', async () => {
    const onApprove = vi.fn(async () => true)
    const out = await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'ask', onApprove })
    )
    expect(onApprove).toHaveBeenCalledWith('c1', 'write', { path: 'a' })
    expect(out.isError).toBeUndefined()
    expect(executeAgentTool).toHaveBeenCalled()
  })

  it('does not run a mutation the user refused', async () => {
    const out = await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'ask', onApprove: vi.fn(async () => false) })
    )
    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/did not allow/)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  // The gate failing open would make the mode's promise false, so a caller
  // that cannot present the prompt refuses instead.
  it('refuses a mutation when nothing can present the prompt', async () => {
    const out = await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'ask', onApprove: undefined })
    )
    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('treats a thrown prompt as a refusal rather than rejecting', async () => {
    const out = await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({
        mode: 'ask',
        onApprove: vi.fn(async () => {
          throw new Error('run aborted')
        }),
      })
    )
    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('does not ask about a read in ask mode', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(call('read'), ctx({ mode: 'ask', onApprove }))
    expect(onApprove).not.toHaveBeenCalled()
    expect(executeAgentTool).toHaveBeenCalled()
  })

  it('never asks in autonomous mode', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'auto', onApprove })
    )
    expect(onApprove).not.toHaveBeenCalled()
    expect(executeAgentTool).toHaveBeenCalled()
  })

  it('passes the attached folder through', async () => {
    await dispatchCoworkTool(call('grep'), ctx({ readOnlyFolder: '/repo' }))
    expect(executeAgentTool).toHaveBeenCalledWith(
      'grep',
      {},
      's1',
      '/repo',
      'session'
    )
  })

  it('carries the display diff without putting it in the output', async () => {
    executeAgentTool.mockResolvedValue({
      content: 'Wrote a.txt',
      diff: '- a\n+ b',
    })
    const out = await dispatchCoworkTool(call('edit'), ctx())
    expect(out.output).toBe('Wrote a.txt')
    expect(out.diff).toBe('- a\n+ b')
  })

  // A rejection would abort the whole run; the model can usually recover if it
  // is simply told what failed.
  it('turns a tool error into a result instead of throwing', async () => {
    executeAgentTool.mockResolvedValue({ error: 'no such file' })
    const out = await dispatchCoworkTool(call('read'), ctx())
    expect(out).toEqual({ output: 'no such file', isError: true })
  })

  it('turns a thrown exception into a result too', async () => {
    executeAgentTool.mockRejectedValue(new Error('ipc died'))
    const out = await dispatchCoworkTool(call('read'), ctx())
    expect(out).toEqual({ output: 'ipc died', isError: true })
  })
})

describe('web tools', () => {
  beforeEach(() => executeWebTool.mockReset())

  it('routes a web call to the websearch plugin', async () => {
    executeWebTool.mockResolvedValue({ content: { kind: 'web', results: [] } })
    const out = await dispatchCoworkTool(
      call('web_search', { query: 'jan' }),
      ctx({ webSearch: true })
    )
    expect(executeWebTool).toHaveBeenCalledWith('web_search', { query: 'jan' })
    // Serialized, not passed through: the model gets a string, and the citation
    // parser re-parses it for the source chips.
    expect(JSON.parse(out.output)).toMatchObject({ kind: 'web' })
    expect(out.isError).toBeFalsy()
  })

  // Withholding is not authoritative -- a model can call a tool that was never
  // advertised -- so an off switch in Settings is enforced here too.
  it('refuses without reaching the network when web search is off', async () => {
    const out = await dispatchCoworkTool(call('web_search'), ctx())
    expect(executeWebTool).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(out.output).toContain('Settings')
  })

  it('reports a plugin failure as a tool error', async () => {
    executeWebTool.mockResolvedValue({ error: 'no API key' })
    const out = await dispatchCoworkTool(
      call('web_fetch', { url: 'https://x.dev' }),
      ctx({ webSearch: true })
    )
    expect(out).toMatchObject({ output: 'no API key', isError: true })
  })
})

/**
 * A skill the user explicitly asked for and did not get.
 *
 * Reading on is fine — that is what Review first is for. Changing files while
 * ignoring the instructions those changes were supposed to follow is not, and
 * silently doing it is the complaint this exists to answer.
 */
describe('a requested skill that is not in play', () => {
  const unresolved = [{ requested: 'superpowers', state: 'missing' }]

  it('stops a mutation, naming the skill and its state', async () => {
    const out = await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'auto', unresolvedSkills: unresolved })
    )

    expect(out.isError).toBe(true)
    expect(out.output).toContain('superpowers (missing)')
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it.each(['write', 'edit', 'bash', 'memory_write', 'skill_write', 'task'])(
    'stops %s',
    async (tool) => {
      const out = await dispatchCoworkTool(
        call(tool, { path: 'a', command: 'ls' }),
        ctx({ mode: 'auto', unresolvedSkills: unresolved })
      )
      expect({ tool, isError: out.isError }).toEqual({ tool, isError: true })
    }
  )

  it('still allows inspection', async () => {
    await dispatchCoworkTool(
      call('read', { path: 'a' }),
      ctx({ mode: 'auto', unresolvedSkills: unresolved })
    )

    expect(executeAgentTool).toHaveBeenCalled()
  })

  // It refuses before the prompt, so the user is never asked to approve a
  // change that would be made without the instructions they asked for.
  it('does not ask for approval first', async () => {
    const onApprove = vi.fn(async () => true)
    await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'ask', onApprove, unresolvedSkills: unresolved })
    )

    expect(onApprove).not.toHaveBeenCalled()
  })

  it('gets out of the way once every request resolved', async () => {
    await dispatchCoworkTool(
      call('write', { path: 'a' }),
      ctx({ mode: 'auto', unresolvedSkills: [] })
    )

    expect(executeAgentTool).toHaveBeenCalled()
  })
})

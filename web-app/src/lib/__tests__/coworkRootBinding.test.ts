import { describe, it, expect, vi, beforeEach } from 'vitest'

const { executeAgentTool } = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))
vi.mock('@/lib/agentTools', () => ({ executeAgentTool }))

const { executeWebTool } = vi.hoisted(() => ({ executeWebTool: vi.fn() }))
vi.mock('@/lib/webSearchTool', () => ({
  WEB_TOOL_NAMES: new Set(['web_search', 'web_fetch']),
  executeWebTool,
}))

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { dispatchCoworkTool } from '../coworkDispatch'
import { buildCoworkSystemPrompt } from '../coworkPrompt'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import type { PendingToolCall } from '../coworkRunner'
import type { CoworkMode } from '../coworkMode'

/**
 * The reported failure, kept as a test.
 *
 * The user selected one repository and Jan announced a sibling — a different
 * checkout in the same parent directory — then began working in it. Nothing
 * here reproduces a bypass in the current code; these assertions exist so that
 * if one is ever introduced, it fails here rather than in someone's editor.
 */
const SELECTED = 'D:\\Code\\obs-forwarder'
const SIBLING = 'D:\\Code\\note-py'
const PARENT = 'D:\\Code'

/** Verbatim, because the wording is what the model acted on. */
const REPORTED_PROMPT =
  'Read this project and learn it. I was in the process of implementing it in ' +
  'another harness but stopped. you should follow all docs in @docs and ensure ' +
  'u continue from where it left off (probably task 1)'

const call = (toolName: string, input: unknown = {}): PendingToolCall => ({
  toolCallId: 'c1',
  toolName,
  input,
})

const ctx = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  readOnlyFolder: SELECTED,
  mode: 'review' as CoworkMode,
  webSearch: false,
  onTodo: vi.fn(async () => ({ output: 'todo ok' })),
  onAsk: vi.fn(async () => ({ output: 'ask ok' })),
  onTask: vi.fn(async () => ({ output: 'task ok' })),
  ...over,
})

/** Every root the dispatcher handed the backend across this test. */
const rootsUsed = () =>
  executeAgentTool.mock.calls.map(
    (args) => (args[3] as { readOnlyProject?: string | null })?.readOnlyProject ?? null
  )

const promptFor = (folder: string | null, instructions?: string | null) =>
  buildCoworkSystemPrompt({
    workspacePath: '/data/agent-workspace/sessions/s1',
    readOnlyFolder: folder,
    planMode: true,
    bashAvailable: false,
    subagentNames: [],
    webSearch: false,
    projectInstructions: instructions ?? null,
  })

beforeEach(() => {
  executeAgentTool.mockReset()
  executeAgentTool.mockResolvedValue({ content: 'ok' })
  useCoworkSessions.setState({ sessions: [], currentId: null })
})

describe('the repository the model is told about', () => {
  it('is the selected one, and the sibling is never named', () => {
    const prompt = promptFor(SELECTED)

    expect(prompt).toContain(SELECTED)
    expect(prompt).not.toContain(SIBLING)
    expect(prompt).not.toContain('note-py')
  })

  it('says plainly that nothing is attached when nothing is', () => {
    const prompt = promptFor(null)

    expect(prompt).not.toContain('D:\\Code')
    expect(prompt).toContain('No project folder is attached')
  })

  // Instructions are read from the selected root only. A sibling's docs must
  // not arrive through this door either.
  it('carries only instructions handed to it, under the selected root', () => {
    const prompt = promptFor(SELECTED, '# obs-forwarder\n\nTask 1: parse.')

    expect(prompt).toContain('Task 1: parse.')
    expect(prompt).not.toContain('note-py')
  })
})

describe('the root every tool call is dispatched against', () => {
  it('is the selected repository, for each tool the reported prompt provokes', async () => {
    // What "read this project and follow all docs in @docs" actually runs.
    for (const tool of ['read', 'list', 'grep', 'glob']) {
      await dispatchCoworkTool(call(tool, { path: 'docs' }), ctx())
    }

    expect(rootsUsed()).toEqual([SELECTED, SELECTED, SELECTED, SELECTED])
    expect(rootsUsed()).not.toContain(SIBLING)
    expect(rootsUsed()).not.toContain(PARENT)
  })

  // Containment of the argument is the backend's job. What must hold here is
  // that the dispatcher never *offers* a different root to resolve it against.
  it('stays the selected repository even when the model asks for the sibling', async () => {
    await dispatchCoworkTool(
      call('read', { path: `${SIBLING}\\main.py` }),
      ctx()
    )

    expect(rootsUsed()).toEqual([SELECTED])
  })

  it('is never the parent directory, so siblings cannot be enumerated', async () => {
    await dispatchCoworkTool(call('list', { path: PARENT }), ctx())

    expect(rootsUsed()).toEqual([SELECTED])
  })
})

describe('the first turn on a repository', () => {
  // Review first is the default for a repository-bound session, and the
  // reported prompt is ambiguous continuity work — exactly the case that must
  // inspect and stop rather than resume someone else's task.
  it('may inspect', async () => {
    for (const tool of ['read', 'list', 'grep', 'glob']) {
      const out = await dispatchCoworkTool(call(tool, { path: 'docs' }), ctx())
      expect({ tool, isError: out.isError }).toEqual({
        tool,
        isError: undefined,
      })
    }
  })

  it('may not write, edit, run commands, or dispatch a subagent', async () => {
    for (const tool of [
      'write',
      'edit',
      'bash',
      'memory_write',
      'skill_write',
    ]) {
      const out = await dispatchCoworkTool(
        call(tool, { path: 'a', command: 'ls' }),
        ctx()
      )
      expect({ tool, isError: out.isError }).toEqual({ tool, isError: true })
    }
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('records the prompt it was given, so the fixture cannot drift', () => {
    expect(REPORTED_PROMPT).toContain('probably task 1')
    expect(REPORTED_PROMPT).toContain('@docs')
  })
})

describe('a collection name that looks like a path', () => {
  // The reported user "selected or believed they selected" a repository. A
  // chat collection is named, not attached, and naming one must never become
  // filesystem access.
  it('does not attach a folder', () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setTitle(id, SELECTED)

    const session = useCoworkSessions
      .getState()
      .sessions.find((one) => one.id === id)!
    expect(session.title).toBe(SELECTED)
    expect(session.folder).toBeNull()
  })

  it('leaves the session with no root to dispatch against', async () => {
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setTitle(id, SELECTED)
    const session = useCoworkSessions
      .getState()
      .sessions.find((one) => one.id === id)!

    await dispatchCoworkTool(
      call('read', { path: 'docs' }),
      ctx({ readOnlyFolder: session.folder ?? null, mode: 'auto' })
    )

    expect(rootsUsed()).toEqual([null])
  })
})

describe('changing the folder while a run is in flight', () => {
  const intact = (bound: string | null, live: string | null) => () =>
    bound === live

  it('refuses a tool call once the folder was detached', async () => {
    const out = await dispatchCoworkTool(
      call('read', { path: 'docs' }),
      ctx({ bindingIntact: intact(SELECTED, null) })
    )

    expect(out.isError).toBe(true)
    expect(out.output).toMatch(/no longer attached/)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  // The reported failure in its worst form: the run keeps going, but against
  // the repository the user swapped in.
  it('refuses once a different folder was attached', async () => {
    const out = await dispatchCoworkTool(
      call('read', { path: 'docs' }),
      ctx({ bindingIntact: intact(SELECTED, SIBLING) })
    )

    expect(out.isError).toBe(true)
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('runs normally while the binding still holds', async () => {
    await dispatchCoworkTool(
      call('read', { path: 'docs' }),
      ctx({ bindingIntact: intact(SELECTED, SELECTED) })
    )

    expect(rootsUsed()).toEqual([SELECTED])
  })
})

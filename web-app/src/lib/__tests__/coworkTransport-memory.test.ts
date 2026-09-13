/**
 * Cowork's system prompt carries remembered facts, scoped to the attached
 * folder, below the run's own rules.
 *
 * Its prompt override used to rebuild the system turn from scratch and drop
 * the memory block the parent had retrieved, so a Cowork run remembered
 * nothing, and it never bound a project, so project memory could not apply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'

const { sandboxEnforces, buildCoworkTools, memoryRetrieve, getJanDataFolder } =
  vi.hoisted(() => ({
    sandboxEnforces: vi.fn(() => true),
    buildCoworkTools: vi.fn(),
    memoryRetrieve: vi.fn(),
    getJanDataFolder: vi.fn(),
  }))
vi.mock('@/lib/agentTools', () => ({ sandboxEnforces }))
vi.mock('@/lib/coworkTools', async (orig) => ({
  ...(await orig<typeof import('../coworkTools')>()),
  buildCoworkTools,
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  memoryRetrieve: (...a: unknown[]) => memoryRetrieve(...a),
}))
vi.mock('@/hooks/useServiceHub', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

import { CoworkChatTransport } from '../coworkTransport'

const BLOCK =
  '# Remembered\n\nFacts recorded from earlier work.\n\n- [mem-1] (project) Deploys go through make ship.'

const config = (over = {}) => ({
  planMode: false,
  webSearch: false,
  subagentNames: [],
  allowSubagents: false,
  workspacePath: '/sandbox/sessions/s1',
  readOnlyFolder: '/work/api',
  projectInstructions: 'Always run pnpm lint before finishing.',
  ...over,
})

type Internals = {
  refreshMemory(): Promise<void>
  buildSystemPrompt(messages: UIMessage[]): string
}
const internals = (t: CoworkChatTransport) => t as unknown as Internals

const withFiles = [
  {
    id: 'u1',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Read this\n[ATTACHED_FILES]\n- file_id: f1, name: a.txt, mode: inline\n[/ATTACHED_FILES]',
      },
    ],
  },
] as UIMessage[]

beforeEach(() => {
  memoryRetrieve.mockReset().mockResolvedValue({
    block: BLOCK,
    injectedIds: ['mem-1'],
    injectedHashes: ['h'],
    conflictIds: [],
    droppedIds: [],
    charsUsed: 60,
    candidateIds: ['mem-1'],
    projectId: 'proj-abc',
    disabled: false,
  })
  getJanDataFolder.mockReset().mockResolvedValue('/data')
})

describe('memory in a Cowork run', () => {
  it('scopes project memory to the attached folder, not the session sandbox', async () => {
    const t = new CoworkChatTransport('s1', config())
    await internals(t).refreshMemory()
    expect(memoryRetrieve).toHaveBeenCalledWith(
      { dataFolder: '/data', projectRoot: '/work/api', sessionId: 's1' },
      { temporary: false }
    )
    expect(JSON.stringify(memoryRetrieve.mock.calls[0])).not.toContain('/sandbox/')
  })

  it('has no project when no folder is attached', async () => {
    const t = new CoworkChatTransport('s1', config({ readOnlyFolder: null }))
    await internals(t).refreshMemory()
    expect(memoryRetrieve).toHaveBeenCalledWith(
      { dataFolder: '/data', sessionId: 's1' },
      { temporary: false }
    )
  })

  it('includes the memory block in the system prompt', async () => {
    const t = new CoworkChatTransport('s1', config())
    await internals(t).refreshMemory()
    const prompt = internals(t).buildSystemPrompt([])
    expect(prompt).toContain(BLOCK)
  })

  /// Memory is labelled as facts, not instructions, and sits below the run's
  /// policy and the project's instructions so nothing remembered outranks them.
  it('places memory below the project instructions and above the files note', async () => {
    const t = new CoworkChatTransport('s1', config())
    await internals(t).refreshMemory()
    const prompt = internals(t).buildSystemPrompt(withFiles)
    const instructions = prompt.indexOf('Always run pnpm lint before finishing.')
    const memory = prompt.indexOf('# Remembered')
    const files = prompt.indexOf('[ATTACHED_FILES] block')
    expect(instructions).toBeGreaterThanOrEqual(0)
    expect(memory).toBeGreaterThan(instructions)
    expect(files).toBeGreaterThan(memory)
  })

  it('adds nothing when no memory applies', async () => {
    memoryRetrieve.mockResolvedValue({
      block: null,
      injectedIds: [],
      injectedHashes: [],
      conflictIds: [],
      droppedIds: [],
      charsUsed: 0,
    })
    const t = new CoworkChatTransport('s1', config())
    const before = internals(t).buildSystemPrompt([])
    await internals(t).refreshMemory()
    expect(internals(t).buildSystemPrompt([])).toBe(before)
    expect(before).not.toContain('# Remembered')
    expect(before.endsWith('\n\n')).toBe(false)
  })
})

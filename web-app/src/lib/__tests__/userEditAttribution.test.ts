import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeAgentTool = vi.fn()
vi.mock('@/lib/agentTools', () => ({
  executeAgentTool: (...args: unknown[]) => executeAgentTool(...args),
}))

import { actorFromEvent, actorLabelParts, changedByText } from '../changeActor'
import { collectCodeFileDiffs } from '../coworkDiffs'
import { saveUserEdit, userEditRunId } from '../coworkCodeSave'
import { useCoworkUserEdits } from '@/hooks/useCoworkUserEdits'

beforeEach(() => {
  executeAgentTool.mockReset()
  useCoworkUserEdits.setState({ bySession: {} })
})

describe('a hand edit is the user’s', () => {
  it('is saved through the write tool as the user, under its own undo run', async () => {
    executeAgentTool.mockResolvedValue({ content: 'ok', diff: '+ x' })
    const outcome = await saveUserEdit({
      sessionId: 's1',
      target: { kind: 'real', path: '/repo/a.ts', grant: 'g1' },
      content: 'x',
      readRoot: '/repo',
      extraFolders: ['/more'],
    })
    expect(outcome).toEqual({ ok: true, diff: '+ x' })
    const [tool, args, session, options] = executeAgentTool.mock.calls[0]
    expect(tool).toBe('write')
    expect(args).toEqual({ path: '/repo/a.ts', content: 'x' })
    expect(session).toBe('s1')
    expect(options).toMatchObject({
      scope: 'session',
      writeGrant: 'g1',
      readOnlyProject: '/repo',
      extraProjects: ['/more'],
      actor: { id: 'user' },
    })
    expect(options.undoRun).toMatch(/^user-edit-/)
  })

  it('never carries the grant for a sandbox save', async () => {
    executeAgentTool.mockResolvedValue({ content: 'ok' })
    await saveUserEdit({
      sessionId: 's1',
      target: { kind: 'sandbox', path: 'a.ts' },
      content: 'x',
      readRoot: '/repo',
    })
    expect(executeAgentTool.mock.calls[0][3].writeGrant).toBeNull()
  })

  it('reports the backend refusing the path', async () => {
    executeAgentTool.mockResolvedValue({ error: 'outside every root' })
    const outcome = await saveUserEdit({
      sessionId: 's1',
      target: { kind: 'sandbox', path: '../../x' },
      content: 'x',
      readRoot: null,
    })
    expect(outcome).toEqual({ ok: false, error: 'outside every root' })
  })

  it('gives each save its own run', () => {
    expect(userEditRunId(1)).not.toBe(userEditRunId(1))
  })

  it('reads as the user in the undo journal and the execution record', () => {
    const t = (k: string, v?: Record<string, unknown>) =>
      v ? `${k}:${JSON.stringify(v)}` : k
    expect(actorLabelParts({ id: 'user', kind: 'user', label: 'you' })).toEqual({
      kind: 'user',
    })
    expect(changedByText({ id: 'user', kind: 'user', label: '' }, t)).toBe(
      'common:turnUndo.changedBy:{"who":"common:turnUndo.user"}'
    )
    expect(actorFromEvent('user', '')).toEqual({
      id: 'user',
      kind: 'user',
      label: '',
    })
  })

  it('lists the edit in Changes attributed to the user', () => {
    const files = collectCodeFileDiffs([], [], [
      { writtenPath: 'a.ts', diff: '- a\n+ b' },
    ])
    expect(files).toEqual([
      {
        path: 'a.ts',
        additions: 1,
        deletions: 1,
        operations: [{ diff: '- a\n+ b', source: 'user' }],
      },
    ])
  })

  it('tells the agent once, on the next turn', () => {
    const store = useCoworkUserEdits.getState()
    store.record('s1', { path: 'a.ts', writtenPath: 'a.ts', where: 'real', at: 1 })
    expect(useCoworkUserEdits.getState().takePending('s1')).toHaveLength(1)
    expect(useCoworkUserEdits.getState().takePending('s1')).toHaveLength(0)
    // The Changes list keeps it.
    expect(useCoworkUserEdits.getState().bySession.s1.edits).toHaveLength(1)
  })
})

import { describe, it, expect } from 'vitest'
import { deriveTaskTitle, MAX_TASK_TITLE_CHARS } from '../taskTitle'
import { parseSubagentRequest } from '../coworkSubagent'
import { parseTeamRequest, isolatedTaskAsTeam } from '../coworkTeam'
import { taskTool, teamTool } from '../coworkTools'

describe('deriveTaskTitle', () => {
  it('prefers the model-supplied title', () => {
    expect(deriveTaskTitle('  Map the lexer  ', 'Read every file under src/ and report.')).toBe('Map the lexer')
  })
  it('falls back to the first sentence of the brief, without its full stop', () => {
    expect(deriveTaskTitle(undefined, 'Audit the Rust agent loop. Then list the tests.\nMore.')).toBe(
      'Audit the Rust agent loop'
    )
  })
  it('clips a long first sentence', () => {
    const t = deriveTaskTitle(undefined, 'x'.repeat(200))!
    expect(t.length).toBe(MAX_TASK_TITLE_CHARS)
    expect(t.endsWith('…')).toBe(true)
  })
  it('has nothing for an empty brief', () => {
    expect(deriveTaskTitle(undefined, '   ')).toBeUndefined()
  })
  it('two different briefs for the same role give different titles', () => {
    expect(deriveTaskTitle(undefined, 'Survey radar.')).not.toBe(deriveTaskTitle(undefined, 'Survey rooms.'))
  })
})

describe('parseSubagentRequest title', () => {
  it('keeps a title and ignores a blank one', () => {
    expect(parseSubagentRequest({ subagent_name: 'explorer', description: 'd', title: ' Find it ' })).toMatchObject({
      title: 'Find it',
    })
    expect(parseSubagentRequest({ subagent_name: 'explorer', description: 'd', title: ' ' })).not.toHaveProperty('title')
  })
})

describe('the per-call model argument', () => {
  it('is carried by task and by each team task, and a blank one is dropped', () => {
    expect(parseSubagentRequest({ subagent_name: 'explorer', description: 'd', model: ' fast ' })).toMatchObject({ model: 'fast' })
    expect(parseSubagentRequest({ subagent_name: 'explorer', description: 'd', model: ' ' })).not.toHaveProperty('model')
    const team = parseTeamRequest({ tasks: [{ id: 'a', description: 'd', model: 'fast' }, { id: 'b', description: 'd' }] })
    expect(Array.isArray(team) && team[0]).toMatchObject({ model: 'fast' })
    expect(Array.isArray(team) && team[1]).not.toHaveProperty('model')
    const iso = isolatedTaskAsTeam({ subagent_name: 'explorer', description: 'd', isolate: true, model: 'fast' })
    expect(iso && 'tasks' in iso && iso.tasks[0]).toMatchObject({ model: 'fast' })
  })

  it('is offered in both tool schemas, as optional', () => {
    const task = JSON.stringify(taskTool(['explorer']).inputSchema)
    expect(task).toContain('"model"')
    expect(JSON.parse(task).jsonSchema?.required ?? JSON.parse(task).required).not.toContain('model')
    expect(JSON.stringify(teamTool(['explorer']).inputSchema)).toContain('"model"')
  })
})

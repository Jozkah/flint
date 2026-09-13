/**
 * Reading who made a change (AH-110).
 *
 * The rules that matter: a role is never shown as a named agent, a change with
 * no recorded actor is unknown rather than the agent running now, and a renamed
 * agent changes only the words -- the identity a change points at is the id.
 */
import { describe, it, expect } from 'vitest'
import {
  actorFromEvent,
  actorLabelParts,
  changedByText,
  turnActors,
} from '@/lib/changeActor'

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key

describe('changeActor', () => {
  it('says what kind of agent made a change, from the id and not the label', () => {
    expect(actorLabelParts({ id: 'agent', kind: 'primary', label: '' })).toEqual({
      kind: 'primary',
    })
    expect(
      actorLabelParts({ id: 'agent:explorer', kind: 'named', label: 'Explorer' })
    ).toEqual({ kind: 'named', name: 'Explorer' })
    expect(
      actorLabelParts({ id: 'role:reviewer', kind: 'role', label: 'Reviewer' })
    ).toEqual({ kind: 'role', name: 'Reviewer' })
    // A definition renamed since: the label is gone, the identity is not.
    expect(actorLabelParts({ id: 'agent:explorer', kind: 'named', label: '' })).toEqual({
      kind: 'named',
      name: 'explorer',
    })
  })

  it('treats a change with no actor as unknown, never as the current agent', () => {
    expect(actorLabelParts(undefined)).toEqual({ kind: 'unknown' })
    expect(actorLabelParts(null)).toEqual({ kind: 'unknown' })
    expect(actorLabelParts({ id: '  ', kind: 'primary', label: 'main' })).toEqual({
      kind: 'unknown',
    })
    expect(changedByText(undefined, t)).toContain('turnUndo.unknownAgent')
  })

  it('puts the whole sentence in one string, so nothing depends on colour', () => {
    expect(changedByText({ id: 'agent', kind: 'primary', label: '' }, t)).toBe(
      'common:turnUndo.changedBy(common:turnUndo.primaryAgent)'
    )
    expect(
      changedByText({ id: 'role:reviewer', kind: 'role', label: 'Reviewer' }, t)
    ).toBe('common:turnUndo.changedBy(common:turnUndo.roleAgent(Reviewer))')
  })

  it('reads an execution-record row, with or without the identity', () => {
    expect(actorFromEvent('role:tester', 'tester')).toEqual({
      id: 'role:tester',
      kind: 'role',
      label: 'tester',
    })
    expect(actorFromEvent('agent', 'main')).toEqual({
      id: 'agent',
      kind: 'primary',
      label: '',
    })
    // An older row has the display name only: still attributed, still typed.
    expect(actorFromEvent('', 'main')).toEqual({ id: 'agent', kind: 'primary', label: '' })
    expect(actorFromEvent(undefined, 'explorer')).toEqual({
      id: 'agent:explorer',
      kind: 'named',
      label: 'explorer',
    })
    expect(actorFromEvent('', '')).toBeNull()
  })

  it('lists a turn’s agents, and admits the ones it does not know', () => {
    const known = { id: 'agent', kind: 'primary' as const, label: '' }
    expect(
      turnActors({ actors: [known], changes: [{ path: 'a', actor: known }] })
    ).toEqual([known])
    // A turn holding a legacy change says so beside the agents it does know.
    expect(
      turnActors({
        actors: [known],
        changes: [{ path: 'a', actor: known }, { path: 'b' }],
      })
    ).toEqual([known, null])
    expect(turnActors({})).toEqual([null])
  })
})

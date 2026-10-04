import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/lib/agentTools', () => ({ getAgentToolSchemas: vi.fn() }))

import { taskDescription, teamDescription } from '../coworkTools'
import {
  SUBAGENT_ROLES,
  savedSubagentNames,
  subagentChoices,
  subagentRoleMenu,
} from '../coworkSubagentGuide'

/** ~4 characters per token: a deliberate over-estimate for English prose. */
const approxTokens = (s: string) => Math.ceil(s.length / 4)

describe('delegation tool descriptions', () => {
  const names = ['explorer', 'reviewer', 'my-agent']

  it('task teaches when to delegate, when not to, and how to brief', () => {
    const d = taskDescription(names)
    expect(d).toContain('Delegate when')
    expect(d).toContain('open-ended')
    expect(d).toContain('Do not delegate')
    expect(d).toContain('complete brief')
    expect(d).toContain('does not see the subagent')
    expect(d).toContain('Saved: my-agent')
  })

  // Cowork runs a step's tool calls one at a time, so telling the model that
  // several `task` calls run together would be false; `team` is the parallel one.
  it('task is honest that calls run one after another and points at team', () => {
    const d = taskDescription(names)
    expect(d).toContain('one after another')
    expect(d).toContain('background:true')
    expect(d).toContain('await_task')
    expect(d).toContain('`team`')
    expect(d).not.toContain('run concurrently')
  })

  it('team teaches the parallel use and keeps the overlap rules', () => {
    const d = teamDescription(names)
    expect(d).toContain('same time')
    expect(d).toContain('independent parts')
    expect(d).toContain('complete brief')
    expect(d).toContain('does not see')
    expect(d).toContain('depends_on')
    expect(d).toContain('`writes`')
    expect(d).toContain('`isolate`')
  })

  it('stay well under the budget a small local model can spare', () => {
    expect(approxTokens(taskDescription(names))).toBeLessThan(450)
    expect(approxTokens(teamDescription(names))).toBeLessThan(450)
  })

  it('offer every shipped role with a reason to pick it', () => {
    for (const r of SUBAGENT_ROLES) {
      expect(taskDescription([])).toContain(`${r.name} (${r.when})`)
      expect(teamDescription([])).toContain(`${r.name} (${r.when})`)
    }
  })

  it('list only non-role names as saved', () => {
    expect(savedSubagentNames(names)).toEqual(['my-agent'])
    expect(subagentChoices(['explorer'])).not.toContain('Saved')
  })
})

describe('role table', () => {
  // The Rust side is the source of truth for what a role is for.
  it('matches core/agent/roles.rs name for name and clause for clause', () => {
    const rust = readFileSync(
      resolve(__dirname, '../../../../src-tauri/src/core/agent/roles.rs'),
      'utf8'
    )
    const pairs = [
      ...rust.matchAll(/name: "(\w+)",\s+when: "([^"]+)",/g),
    ].map((m) => ({ name: m[1], when: m[2] }))
    expect(pairs).toEqual(SUBAGENT_ROLES.map((r) => ({ ...r })))
    expect(subagentRoleMenu().split('; ')).toHaveLength(pairs.length)
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('@janhq/tauri-plugin-websearch-api', () => ({
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imageSearch: vi.fn(),
}))

import {
  ENABLE_TOOLS_NAME,
  enableToolsTool,
  groupOf,
  groupsToOffer,
  offerSignature,
  parseEnableRequest,
  splitToolGroups,
  TOOL_GROUPS,
} from '../coworkToolGroups'
import { coworkToolsFromSchemas } from '../coworkTools'
import { estimateToolTokens } from '../context-manager'

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
const called = (name: string) => ({ role: 'assistant', parts: [{ type: `tool-${name}` }] })

describe('groupsToOffer', () => {
  it('offers nothing for a plain message', () => {
    expect(groupsToOffer({ text: 'test' })).toEqual([])
  })

  it('offers a group once the opening message mentions its subject', () => {
    expect(groupsToOffer({ text: 'open the website and click login' })).toContain('browser')
    expect(groupsToOffer({ text: 'run these three reviewers in parallel' })).toContain('team')
    expect(groupsToOffer({ text: 'why is my docker container down' })).toContain('devops')
    // RQA-006: naming the tool itself offers its group.
    expect(groupsToOffer({ text: 'run the tests with host_build (program npm)' })).toContain('devops')
    expect(groupsToOffer({ text: 'check it with git_inspect' })).toContain('repo')
  })

  it('keeps a group once the session used it, so the prefix does not flip', () => {
    const out = groupsToOffer({ text: 'thanks', history: [user('hi'), called('browser')] })
    expect(out).toEqual(['browser'])
    // Earlier user turns count too.
    expect(groupsToOffer({ text: 'ok', history: [user('check the browser')] })).toContain('browser')
  })

  it('offers messaging to a run another session started', () => {
    expect(groupsToOffer({ text: 'hello', fromSession: true })).toContain('messaging')
  })
})

describe('splitToolGroups', () => {
  const tools = {
    read: 1,
    bash: 2,
    browser: 3,
    browser_click: 4,
    team: 5,
    send_message: 6,
    host_query: 7,
  }

  it('holds back every group nothing asked for and keeps the core', () => {
    const { lean, held, heldGroups } = splitToolGroups(tools, new Set())
    expect(Object.keys(lean)).toEqual(['read', 'bash'])
    expect(Object.keys(held).sort()).toEqual(
      ['browser', 'browser_click', 'host_query', 'send_message', 'team'].sort()
    )
    expect(heldGroups).toEqual(['browser', 'team', 'messaging', 'host'])
  })

  it('still gives a run that needs the browser the browser, every browser tool', () => {
    const { lean, heldGroups } = splitToolGroups(tools, new Set(['browser']))
    expect(lean).toHaveProperty('browser')
    expect(lean).toHaveProperty('browser_click')
    expect(heldGroups).not.toContain('browser')
  })

  it('advertises everything when lean is off', () => {
    const out = splitToolGroups(tools, undefined)
    expect(out.lean).toBe(tools)
    expect(out.heldGroups).toEqual([])
  })

  it('puts the offered groups in the signature, so a different set is a different prefix', () => {
    expect(offerSignature(new Set(['browser']))).not.toBe(offerSignature(new Set()))
    expect(offerSignature(undefined)).toBe('full')
    expect(offerSignature(new Set(['team', 'browser']))).toBe(offerSignature(new Set(['browser', 'team'])))
  })
})

describe('enable_tools', () => {
  it('lists only the groups still held', () => {
    const tool = enableToolsTool(['team', 'browser']) as { description: string }
    expect(tool.description).toContain('team:')
    expect(tool.description).toContain('browser:')
    expect(tool.description).not.toContain('messaging:')
  })

  it('accepts a held group and refuses unknown or absent ones with a reason', () => {
    expect(parseEnableRequest({ groups: ['team'] }, ['team'], new Set())).toEqual({ groups: ['team'] })
    expect(parseEnableRequest({ groups: ['nope'] }, ['team'], new Set())).toMatch(/Unknown group/)
    // A group with no tools in this run (off in Settings or plan mode) is not
    // a way around that switch.
    expect(parseEnableRequest({ groups: ['browser'] }, ['team'], new Set())).toMatch(/no tools in this run/)
    expect(parseEnableRequest({}, ['team'], new Set())).toMatch(/needs `groups`/)
  })

  it('every group tool maps back to its group', () => {
    for (const [id, spec] of Object.entries(TOOL_GROUPS)) {
      for (const name of spec.tools) expect(groupOf(name)).toBe(id)
    }
    expect(groupOf('read')).toBeUndefined()
    expect(groupOf('browser_type')).toBe('browser')
  })
})

/**
 * Cost of the tools the web layer builds itself (the Rust-side ones are in
 * `context_cost_report`, tauri-plugin-agent-tools). Run with
 * `yarn vitest run coworkToolGroups` for the figures.
 */
describe('client tool cost', () => {
  it('prints what the lean set saves among the tools Cowork builds itself', () => {
    const full = coworkToolsFromSchemas([], {
      planMode: false,
      webSearch: true,
      allowSubagents: true,
      subagentNames: ['researcher'],
    })
    const cost = (set: Record<string, unknown>) =>
      Object.entries(set).reduce((n, [name, t]) => n + estimateToolTokens(name, t), 0)
    const { lean, heldGroups } = splitToolGroups(full, new Set())
    const withMeta = { ...lean, [ENABLE_TOOLS_NAME]: enableToolsTool(heldGroups) }
    console.log(
      `client tools: full ${cost(full)} tokens, lean ${cost(withMeta)} tokens ` +
        `(enable_tools ${estimateToolTokens(ENABLE_TOOLS_NAME, enableToolsTool(heldGroups))})`
    )
    expect(cost(withMeta)).toBeLessThan(cost(full))
    expect(lean).toHaveProperty('task')
    expect(lean).toHaveProperty('ask')
    expect(full).toHaveProperty('team')
    expect(lean).not.toHaveProperty('team')
  })
})

describe('enable_tools follow-ups', () => {
  it('says a group already advertised is available, not that it has no tools', () => {
    const msg = parseEnableRequest({ groups: ['browser'] }, ['team'], new Set(), new Set(['browser']))
    expect(msg).toMatch(/already available/)
  })

  it('a successful enable_tools call in history keeps the group offered', () => {
    const history = [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-enable_tools',
            state: 'output-available',
            input: { groups: ['team'] },
            output: 'Loaded 1 tools: team.',
          },
        ],
      },
    ]
    expect(groupsToOffer({ text: '', history } as never)).toContain('team')
    const failed = [
      {
        role: 'assistant',
        parts: [
          { type: 'tool-enable_tools', state: 'output-available', input: { groups: ['team'] }, output: 'ERROR: x' },
        ],
      },
    ]
    expect(groupsToOffer({ text: '', history: failed } as never)).not.toContain('team')
  })

  it('an activated skill that names a subject offers its group', () => {
    expect(groupsToOffer({ text: 'hi', skillText: 'Use docker compose to build' })).toContain('devops')
  })
})

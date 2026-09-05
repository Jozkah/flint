import { describe, it, expect } from 'vitest'
import {
  buildCoworkSystemPrompt,
  buildSubagentSystemPrompt,
  PLAN_REVIEW_QUESTION_ID,
} from '../coworkPrompt'

const opts = (over = {}) => ({
  workspacePath: '/data/agent-workspace/sessions/s1',
  readOnlyFolder: null,
  planMode: false,
  webSearch: false,
  bashAvailable: true,
  subagentNames: [],
  ...over,
})

describe('buildCoworkSystemPrompt', () => {
  it('names the workspace as the writable directory', () => {
    const p = buildCoworkSystemPrompt(opts())
    expect(p).toContain('/data/agent-workspace/sessions/s1')
    expect(p).toContain('No project folder is attached')
  })

  // Without this the model retries the same refused write until the step
  // budget runs out — the single most expensive thing it can get wrong here.
  it('spells out that an attached folder is read-only and how to work around it', () => {
    const p = buildCoworkSystemPrompt(opts({ readOnlyFolder: '/home/u/repo' }))
    expect(p).toContain('/home/u/repo')
    expect(p).toContain('READ-ONLY')
    expect(p).toMatch(/copy it into your workspace/i)
    expect(p).toMatch(/Do not\s+retry a refused write/i)
  })

  it('explains a missing shell rather than staying silent about it', () => {
    const p = buildCoworkSystemPrompt(opts({ bashAvailable: false }))
    expect(p).toMatch(/Shell commands are unavailable/i)
    expect(buildCoworkSystemPrompt(opts())).not.toMatch(
      /Shell commands are unavailable/i
    )
  })

  it('carries the plan-review contract the ask card special-cases', () => {
    const p = buildCoworkSystemPrompt(opts({ planMode: true }))
    expect(p).toContain('PLAN MODE (read only)')
    expect(p).toContain(PLAN_REVIEW_QUESTION_ID)
    expect(p).toContain('Execute plan')
    expect(p).toContain('Keep planning')
    expect(p).toContain('Exit plan mode')
  })

  it('describes subagents only when some are available and not planning', () => {
    expect(
      buildCoworkSystemPrompt(opts({ subagentNames: ['researcher'] }))
    ).toContain('researcher')
    expect(
      buildCoworkSystemPrompt(
        opts({ subagentNames: ['researcher'], planMode: true })
      )
    ).not.toContain('# Subagents')
    expect(buildCoworkSystemPrompt(opts())).not.toContain('# Subagents')
  })
})

describe('buildSubagentSystemPrompt', () => {
  const opts = {
    workspacePath: '/ws/s1',
    readOnlyFolder: '/home/me/repo',
    bashAvailable: true,
  }

  it('keeps the definition prompt and adds the workspace facts', () => {
    const out = buildSubagentSystemPrompt('You review Rust.', opts)
    expect(out).toContain('You review Rust.')
    // The Rust `system_prompt_override` replaces the whole prompt, which works
    // for the CLI (cwd is the project) but leaves a desktop child unable to
    // guess its sandbox path.
    expect(out).toContain('/ws/s1')
    expect(out).toContain('READ-ONLY')
  })

  it('states the three things a child cannot do', () => {
    const out = buildSubagentSystemPrompt('p', opts)
    expect(out).toContain('cannot see the conversation')
    expect(out).toContain('cannot ask the user')
    expect(out).toContain('cannot dispatch')
  })

  it('never leaks plan mode or a subagent roster into a child', () => {
    const out = buildSubagentSystemPrompt('p', opts)
    expect(out).not.toContain('PLAN MODE')
    expect(out).not.toContain('# Subagents')
  })

  // A child whose allowlist dropped the web tools must not be told it has them.
  it('describes web access only when the child kept the tools', () => {
    expect(buildSubagentSystemPrompt('p', { ...opts, webSearch: true })).toContain(
      '# Web'
    )
    expect(buildSubagentSystemPrompt('p', opts)).not.toContain('# Web')
  })
})

describe('web block', () => {
  it('is absent when web search is off', () => {
    expect(buildCoworkSystemPrompt(opts())).not.toContain('# Web')
  })

  // The marker has to match chat's, or the renderer shows raw text instead of
  // source chips.
  it('names both tools and the citation marker when on', () => {
    const p = buildCoworkSystemPrompt(opts({ webSearch: true }))
    expect(p).toContain('web_search')
    expect(p).toContain('web_fetch')
    expect(p).toContain('[[cite:URL]]')
  })
})

describe('project instructions (JAN.md)', () => {
  // Spec: the run context must name any project instruction file Jan already
  // supports. Jan's is `JAN.md` — `core::agent::context` reads that one and
  // deliberately ignores AGENTS.md and CLAUDE.md — but the desktop's prompt is
  // built here, in TypeScript, and never included it. Only the CLI honoured a
  // project's own instructions.

  it('carries JAN.md verbatim, wrapped as authoritative project context', () => {
    const p = buildCoworkSystemPrompt(
      opts({
        readOnlyFolder: '/home/u/proj',
        projectInstructions: '# House rules\n\nAlways run `make check`.',
      })
    )
    expect(p).toContain('<project_context>')
    expect(p).toContain('<project_instructions path="JAN.md">')
    expect(p).toContain('Always run `make check`.')
    expect(p).toContain('</project_context>')
  })

  it('tells the model the file exists and outranks the general guidelines', () => {
    const p = buildCoworkSystemPrompt(
      opts({ readOnlyFolder: '/home/u/proj', projectInstructions: 'rules' })
    )
    expect(p).toContain('It carries a `JAN.md`')
    expect(p).toContain('take')
    // Last block, so it is the final word before the conversation.
    expect(p.trimEnd().endsWith('</project_context>')).toBe(true)
  })

  it('says nothing when the project has no JAN.md', () => {
    for (const value of [undefined, null, '', '   \n  ']) {
      const p = buildCoworkSystemPrompt(
        opts({ readOnlyFolder: '/home/u/proj', projectInstructions: value })
      )
      expect(p).not.toContain('project_context')
      expect(p).not.toContain('JAN.md')
    }
  })

  it('keeps the sandbox and the project distinct alongside it', () => {
    // The instructions must not blur the boundary the rest of the block sets.
    const p = buildCoworkSystemPrompt(
      opts({
        workspacePath: '/data/sessions/s1',
        readOnlyFolder: '/home/u/proj',
        projectInstructions: 'rules',
      })
    )
    expect(p).toContain('`/data/sessions/s1`')
    expect(p).toContain('It is mounted READ-ONLY.')
  })
})

/**
 * What the model is told about the attached folder.
 *
 * This block used to assert read-only unconditionally, which was true until a
 * folder could be authorized and then became a lie the model would repeat back
 * to the user. It now follows the run's effective access.
 */
describe('describing the attached folder', () => {
  const withAccess = (folderAccess?: 'read-only' | 'editable') =>
    buildCoworkSystemPrompt(
      opts({ readOnlyFolder: '/home/dev/obs-forwarder', folderAccess })
    )

  it('says read-only when nothing authorized writing to it', () => {
    const prompt = withAccess('read-only')

    expect(prompt).toContain('READ-ONLY')
    expect(prompt).toContain('will be refused')
  })

  // Every caller that predates direct editing keeps what it had.
  it('says read-only when the caller says nothing at all', () => {
    expect(withAccess()).toContain('READ-ONLY')
  })

  it('says it may be edited once the run is authorized', () => {
    const prompt = withAccess('editable')

    expect(prompt).not.toContain('READ-ONLY')
    expect(prompt).toContain('authorized you to edit it')
    expect(prompt).toContain('working directory')
  })

  // The sandbox does not stop existing when the folder becomes writable, and
  // work left there is still not a change to the user's repository.
  it('keeps the sandbox a separate destination when editing', () => {
    const prompt = withAccess('editable')

    expect(prompt).toContain('not a change to their repository')
  })

  it('tells it not to claim changes it did not make', () => {
    const prompt = withAccess('editable')

    expect(prompt).toContain('already modified when you started')
    expect(prompt).toContain('Do not commit, stash, reset or discard')
  })

  it('names the folder either way', () => {
    for (const access of ['read-only', 'editable'] as const) {
      expect(withAccess(access)).toContain('/home/dev/obs-forwarder')
    }
  })
})

import { describe, it, expect } from 'vitest'
import cases from './gitToolCases.json'
import {
  gitApproval,
  gitCommandLine,
  gitInsideSessionTree,
  gitRemoteFacts,
  planGitCall,
  planGitTool,
} from '@/lib/gitTool'

type Case = {
  program: string
  args: string[]
  class: 'read' | 'local' | 'remote' | 'deny'
  destructive?: boolean
}

describe('git tool classification (shared with tools/git_tool.rs)', () => {
  for (const c of cases as Case[]) {
    it(`${c.program} ${c.args.join(' ')} -> ${c.class}`, () => {
      const result = planGitCall(c.program, c.args)
      if (c.class === 'deny') {
        expect(result.ok).toBe(false)
        return
      }
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.plan.class).toBe(c.class)
      expect(result.plan.destructive !== undefined).toBe(c.destructive ?? false)
    })
  }
})

describe('gitApproval', () => {
  it('runs reads and refused calls without a prompt', () => {
    expect(gitApproval({ args: ['status'] })).toBeNull()
    expect(gitApproval({ args: ['-c', 'core.sshCommand=x', 'push'] })).toBeNull()
    expect(gitApproval({ args: 'status' })).toBeNull()
  })

  it('asks about a local change like any other change', () => {
    const a = gitApproval({ args: ['commit', '-m', 'x'] })
    expect(a?.alwaysAsk).toBe(false)
  })

  it('asks about a push every time and says it reaches the remote', () => {
    const a = gitApproval({ args: ['push', 'origin', 'main'] })
    expect(a?.alwaysAsk).toBe(true)
    // Named as a push to that remote, so "do not push" is visibly at stake.
    expect(a?.reason).toMatch(/^Push: publishes commits to origin\b/)
    expect(gitApproval({ args: ['push'] })?.reason).toMatch(
      /to the default remote/
    )
    const f = gitApproval({ args: ['push', '--force'] })
    expect(f?.reason).toMatch(/^Destructive: force push/)
    const pr = gitApproval({ program: 'gh', args: ['pr', 'create', '--fill'] })
    expect(pr?.alwaysAsk).toBe(true)
    expect(pr?.reason).toMatch(/GitHub/)
  })

  it('reads JSON-string input and keeps cwd', () => {
    const r = planGitTool(JSON.stringify({ args: ['add', '.'], cwd: 'sub' }))
    expect(r.ok && r.plan.cwd).toBe('sub')
  })

  it('quotes arguments with spaces in the command line', () => {
    expect(gitCommandLine({ program: 'git', args: ['commit', '-m', 'two words'] })).toBe(
      'git commit -m "two words"'
    )
  })
})

describe('gitInsideSessionTree', () => {
  it('is the worktree when the session has one', () => {
    const wt = 'C:\\wt\\s1'
    expect(gitInsideSessionTree(undefined, wt, true)).toBe(true)
    expect(gitInsideSessionTree('sub', wt, true)).toBe(true)
    expect(gitInsideSessionTree('..\\other', wt, true)).toBe(false)
    expect(gitInsideSessionTree('C:/wt/s1/pkg', wt, true)).toBe(true)
    expect(gitInsideSessionTree('C:\\repo', wt, true)).toBe(false)
  })

  it('is the sandbox only when no folder was granted', () => {
    expect(gitInsideSessionTree(undefined, null, false)).toBe(true)
    expect(gitInsideSessionTree(undefined, null, true)).toBe(false)
  })
})

describe('gitRemoteFacts', () => {
  it('names the remote URL and current branch for a push', async () => {
    const plan = planGitCall('git', ['push'])
    if (!plan.ok) throw new Error('plan')
    const calls: string[][] = []
    const facts = await gitRemoteFacts(plan.plan, async (args) => {
      calls.push(args)
      if (args[0] === 'rev-parse') return '$ git rev-parse --abbrev-ref HEAD\nfeature/x'
      return '$ git remote get-url origin\nhttps://github.com/o/r.git'
    })
    expect(facts).toBe('Remote origin (https://github.com/o/r.git), branch feature/x.')
    expect(calls).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['remote', 'get-url', 'origin'],
    ])
  })

  it('leaves out what it cannot read', async () => {
    const plan = planGitCall('git', ['push', 'upstream', 'main'])
    if (!plan.ok) throw new Error('plan')
    expect(await gitRemoteFacts(plan.plan, async () => null)).toBe(
      'Remote upstream, branch main.'
    )
  })
})

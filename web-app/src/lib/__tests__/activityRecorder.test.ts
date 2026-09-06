import { describe, it, expect } from 'vitest'
import {
  activityEventId,
  diffLineCounts,
  exitCodeOf,
  gitDetailOf,
  jobIdOf,
  kindForTool,
  pendingEventFor,
  permissionDecidedEvent,
  permissionRequestedEvent,
  runFinishedEvent,
  settledEventFor,
  titleForCall,
  verificationKindOf,
  type ActivityRunContext,
} from '../activityRecorder'
import { appendActivityEvent, emptyActivityLog } from '../activityEvents'

const run: ActivityRunContext = {
  sessionId: 's1',
  runId: 'r1',
  model: 'local/qwen',
}

describe('event identity', () => {
  it('scopes a call id to its session, because a provider only promises stream uniqueness', () => {
    expect(activityEventId('s1', 'call-1')).toBe('s1:call-1')
    expect(activityEventId('s2', 'call-1')).not.toBe(activityEventId('s1', 'call-1'))
  })

  it('gives the pending and settled events of one call the same id, so the row updates', () => {
    const pending = pendingEventFor(run, { callId: 'c1', toolName: 'bash', args: { command: 'ls' } }, 100)
    const settled = settledEventFor(
      run,
      { callId: 'c1', name: 'bash', args: { command: 'ls' } },
      { output: 'a\nb\n[exit 0]' },
      1100,
      100
    )
    expect(settled!.id).toBe(pending.id)

    let log = appendActivityEvent(emptyActivityLog('s1'), pending)
    log = appendActivityEvent(log, settled!)
    expect(log.events).toHaveLength(1)
    expect(log.events[0].status).toBe('ok')
    expect(log.events[0].detail).toMatchObject({ command: { exitCode: 0, durationMs: 1000 } })
  })
})

describe('classification', () => {
  it('reads create versus edit from the diff header rather than the tool name', () => {
    expect(kindForTool('write', '@@ created file @@\n+    1 | x')).toBe('file.created')
    expect(kindForTool('write', '-    1 | old\n+    1 | new')).toBe('file.edited')
    expect(kindForTool('edit')).toBe('file.edited')
    expect(kindForTool('read')).toBe('file.read')
    expect(kindForTool('bash')).toBe('command')
  })

  it('recognises the commands that verify', () => {
    expect(verificationKindOf('cargo test -p jan-agent-harness')).toBe('test')
    expect(verificationKindOf('npx vitest run src/x.test.ts')).toBe('test')
    expect(verificationKindOf('cargo build --release')).toBe('build')
    expect(verificationKindOf('npx eslint src')).toBe('lint')
    expect(verificationKindOf('npx tsc --noEmit')).toBe('typecheck')
    expect(verificationKindOf('ls -la')).toBeUndefined()
    expect(verificationKindOf('git status')).toBeUndefined()
  })

  it('reads the git subcommand, not any word on the line', () => {
    expect(gitDetailOf('git status --porcelain')).toEqual({ operation: 'status' })
    expect(gitDetailOf('git -C /repo commit -m x')).toEqual({ operation: 'commit' })
    expect(gitDetailOf('git log --grep commit')).toEqual({ operation: 'other' })
    expect(gitDetailOf('cargo build')).toBeUndefined()
  })

  it('marks a destructive git operation as destructive', () => {
    expect(gitDetailOf('git push --force origin main')).toEqual({
      operation: 'push',
      destructive: true,
    })
    expect(gitDetailOf('git reset --hard HEAD~1')).toEqual({
      operation: 'other',
      destructive: true,
    })
    expect(gitDetailOf('git clean -fd')).toEqual({ operation: 'other', destructive: true })
    expect(gitDetailOf('git push origin main')).toEqual({ operation: 'push' })
  })
})

describe('facts read from what the tool printed', () => {
  it('takes the exit code from the marker, and reports none when there is none', () => {
    expect(exitCodeOf('output\n[exit 101]')).toBe(101)
    expect(exitCodeOf('[exit 0]')).toBe(0)
    expect(exitCodeOf('still running')).toBeUndefined()
  })

  it('takes the background job id when the command backgrounded itself', () => {
    expect(jobIdOf('started\n[job abc-123]')).toBe('abc-123')
    expect(jobIdOf('done')).toBeUndefined()
  })

  it('counts diff lines rather than trusting a summary', () => {
    expect(diffLineCounts('+one\n+two\n-old')).toEqual({ added: 2, removed: 1 })
    expect(diffLineCounts(undefined)).toEqual({})
  })
})

describe('titles', () => {
  it('names the action and its target', () => {
    expect(titleForCall('read', { path: 'src/main.rs' })).toBe('Read src/main.rs')
    expect(titleForCall('write', { path: 'a.txt' })).toBe('Wrote a.txt')
    expect(titleForCall('edit', { path: 'a.txt' })).toBe('Edited a.txt')
    expect(titleForCall('bash', { command: 'cargo test' })).toBe('Ran tests')
    expect(titleForCall('bash', { command: 'git status' })).toBe('git status')
    expect(titleForCall('bash', { command: 'ls -la' })).toBe('Ran ls -la')
    expect(titleForCall('grep', { pattern: 'TODO' })).toBe('Searched for TODO')
  })

  it('uses only the first line of a multi-line command', () => {
    expect(titleForCall('bash', { command: 'echo one\necho two' })).toBe('Ran echo one')
  })

  it('falls back to the tool name rather than inventing a description', () => {
    expect(titleForCall('some_mcp_tool', { whatever: 1 })).toBe('some_mcp_tool')
  })
})

describe('pending events', () => {
  it('records the line range a read asked for', () => {
    const event = pendingEventFor(
      run,
      { callId: 'c', toolName: 'read', args: { path: 'a.ts', offset: 40, limit: 20 } },
      1
    )
    expect(event.kind).toBe('file.read')
    expect(event.detail).toMatchObject({ read: { path: 'a.ts', fromLine: 40, toLine: 59 } })
    expect(event.status).toBe('pending')
  })

  it('leaves the range absent when the read did not ask for one', () => {
    const event = pendingEventFor(run, { callId: 'c', toolName: 'read', args: { path: 'a.ts' } }, 1)
    expect(event.detail).toMatchObject({ read: { path: 'a.ts' } })
    expect((event.detail as { read: { fromLine?: number } }).read.fromLine).toBeUndefined()
  })

  it('classifies a git command as git before it classifies it as a command', () => {
    const event = pendingEventFor(
      run,
      { callId: 'c', toolName: 'bash', args: { command: 'git push --force' } },
      1
    )
    expect(event.kind).toBe('git')
    expect(event.detail).toMatchObject({ git: { operation: 'push', destructive: true } })
  })

  it('carries the run, model and call identifiers', () => {
    const event = pendingEventFor(run, { callId: 'c', toolName: 'bash', args: { command: 'ls' } }, 1)
    expect(event).toMatchObject({
      sessionId: 's1',
      runId: 'r1',
      modelId: 'local/qwen',
      callId: 'c',
    })
  })
})

describe('settled events', () => {
  it('records exit code, duration and output for a command', () => {
    const event = settledEventFor(
      run,
      { callId: 'c', name: 'bash', args: { command: 'cargo build' } },
      { output: 'error: nope\n[exit 101]', isError: true },
      5000,
      1000
    )!
    expect(event.status).toBe('error')
    expect(event.kind).toBe('verification')
    expect(event.detail).toMatchObject({
      verification: { tool: 'build', exitCode: 101, durationMs: 4000 },
    })
  })

  it('reports no duration when it does not know one', () => {
    const event = settledEventFor(
      run,
      { callId: 'c', name: 'bash', args: { command: 'ls' } },
      { output: '[exit 0]' },
      5000
    )!
    expect((event.detail as { command: { durationMs?: number } }).command.durationMs).toBeUndefined()
  })

  it('marks a backgrounded command as background, with its job id', () => {
    const event = settledEventFor(
      run,
      { callId: 'c', name: 'bash', args: { command: 'npm run dev' } },
      { output: 'started\n[job job-7]' },
      2,
      1
    )!
    expect(event.detail).toMatchObject({ command: { background: true, jobId: 'job-7' } })
  })

  it('records a write as a create when the diff says the file was created', () => {
    const event = settledEventFor(
      run,
      { callId: 'c', name: 'write', args: { path: 'new.txt' } },
      { output: 'Created new.txt (5 bytes)', diff: '@@ created file @@\n+    1 | hello' },
      2,
      1
    )!
    expect(event.kind).toBe('file.created')
    expect(event.detail).toMatchObject({ change: { path: 'new.txt', added: 1, removed: 0 } })
  })

  it('returns nothing for a turn with no call id or name to attribute it to', () => {
    expect(settledEventFor(run, { callId: undefined, name: 'bash', args: {} }, { output: '' }, 1)).toBeNull()
    expect(settledEventFor(run, { callId: 'c', name: undefined, args: {} }, { output: '' }, 1)).toBeNull()
  })
})

describe('permission events', () => {
  it('turns the question into the answer on the same row', () => {
    const requested = permissionRequestedEvent(
      run,
      { requestId: 'r9', tool: 'bash', promptKind: 'destructive_git', resource: 'git reset --hard' },
      1
    )
    const decided = permissionDecidedEvent(
      run,
      {
        requestId: 'r9',
        tool: 'bash',
        promptKind: 'destructive_git',
        resource: 'git reset --hard',
        decision: 'deny',
        decidedBy: 'user',
      },
      2
    )
    expect(decided.id).toBe(requested.id)

    let log = appendActivityEvent(emptyActivityLog('s1'), requested)
    log = appendActivityEvent(log, decided)
    expect(log.events).toHaveLength(1)
    expect(log.events[0].kind).toBe('permission.decided')
    expect(log.events[0].status).toBe('error')
    expect(log.events[0].title).toBe('Permission denied for bash')
  })

  it('records an auto-approval as a decision, not as an absence of one', () => {
    const event = permissionDecidedEvent(
      run,
      { requestId: 'r1', tool: 'write', promptKind: 'write', decision: 'auto_allowed', decidedBy: 'policy' },
      1
    )
    expect(event.status).toBe('ok')
    expect(event.detail).toMatchObject({
      permission: { decision: 'auto_allowed', decidedBy: 'policy' },
    })
  })
})

describe('run events', () => {
  it('says how a run ended, including cancelled', () => {
    expect(runFinishedEvent(run, { status: 'ok' }, 1).title).toBe('Run finished')
    expect(runFinishedEvent(run, { status: 'error', reason: 'upstream' }, 1)).toMatchObject({
      kind: 'run.finished',
      title: 'Run failed',
      detail: { outcome: { reason: 'upstream' } },
    })
    expect(runFinishedEvent(run, { status: 'cancelled' }, 1)).toMatchObject({
      kind: 'cancelled',
      title: 'Run cancelled',
    })
  })
})

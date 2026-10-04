import { describe, it, expect } from 'vitest'
import en from '@/locales/en/permissions.json'
import {
  categorizeTool,
  describePermissionRequest,
  redactSecrets,
  sanitizeResource,
  sanitizeValue,
  workspaceName,
  MAX_RESOURCE_LENGTH,
  REDACTED,
  type PermissionMessage,
} from '@/lib/permissionRequest'

/** Resolve a message against the real English bundle, as the UI would. */
const text = (msg: PermissionMessage): string => {
  const [ns, path] = msg.key.split(':')
  expect(ns).toBe('permissions')
  let node: unknown = en
  for (const part of path.split('.')) {
    node = (node as Record<string, unknown>)?.[part]
  }
  expect(typeof node, `missing key ${msg.key}`).toBe('string')
  return (node as string).replace(/\{\{(\w+)\}\}/g, (_, v) =>
    String(msg.values?.[v] ?? `{{${v}}}`)
  )
}

describe('categorizeTool', () => {
  it.each([
    ['write', 'file-change'],
    ['edit', 'file-change'],
    ['apply_patch', 'file-change'],
    ['memory_write', 'file-change'],
    ['skill_write', 'file-change'],
    ['bash', 'command'],
    ['web_fetch', 'network'],
    ['web_search', 'network'],
    ['read', 'read'],
    ['grep', 'read'],
    ['screenshot', 'read'],
    ['task', 'other'],
    ['something_new', 'other'],
  ])('%s is %s', (tool, category) => {
    expect(categorizeTool(tool)).toBe(category)
  })

  it('treats any tool with a server as an external tool, whatever its name', () => {
    expect(categorizeTool('write_file', 'filesystem')).toBe('external-tool')
    expect(categorizeTool('bash', 'remote')).toBe('external-tool')
  })
})

describe('describePermissionRequest', () => {
  it('names the file and the workspace for a single edit', () => {
    const d = describePermissionRequest({
      toolName: 'edit',
      input: { path: 'src/app.ts', old_string: 'a', new_string: 'b' },
      workspaceLabel: 'C:\\Users\\me\\Forma\\',
    })
    expect(d.category).toBe('file-change')
    expect(text(d.categoryLabel)).toBe('File change')
    expect(text(d.action)).toBe('Flint wants to change src/app.ts in Forma')
    expect(d.resources).toEqual(['src/app.ts'])
    expect(d.consequences.map(text)).toEqual([
      'It can create, overwrite or change the contents of files.',
    ])
  })

  it('counts several files, including ones named inside a patch', () => {
    const d = describePermissionRequest({
      toolName: 'apply_patch',
      input: JSON.stringify({
        patch: [
          '*** Begin Patch',
          '*** Update File: a.ts',
          '*** Add File: b.ts',
          '*** Delete File: c.ts',
        ].join('\n'),
      }),
      workspaceLabel: '/home/me/Forma',
    })
    expect(d.resources).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(text(d.action)).toBe('Flint wants to change 3 files in Forma')
  })

  it('describes a command with its consequence and a redacted command line', () => {
    const d = describePermissionRequest({
      toolName: 'bash',
      input: { command: 'PGPASSWORD=hunter2 psql -h db' },
    })
    expect(d.category).toBe('command')
    expect(text(d.action)).toBe('Flint wants to run a command')
    expect(d.resources).toEqual([`PGPASSWORD=${REDACTED} psql -h db`])
    expect(d.consequences.map(text)).toEqual([
      'It can change files and run programs on this computer.',
    ])
    expect(d.technicalDetails.argumentsJson).not.toContain('hunter2')
  })

  it('names only the host of a fetched URL and strips its secrets', () => {
    const d = describePermissionRequest({
      toolName: 'web_fetch',
      input: { url: 'https://api.example.com/v1?token=abc123&q=1' },
    })
    expect(d.category).toBe('network')
    expect(text(d.action)).toBe('Flint wants to open api.example.com')
    expect(d.resources[0]).toBe(
      `https://api.example.com/v1?token=${REDACTED}&q=1`
    )
  })

  it('offers the server, not the tool, for "always" on an MCP tool', () => {
    const d = describePermissionRequest({
      toolName: 'create_issue',
      serverName: 'github',
      input: { title: 'x' },
    })
    expect(d.category).toBe('external-tool')
    expect(text(d.action)).toBe('Flint wants to use create_issue from github')
    expect(d.resources).toContain('github')
    const always = d.scopeExplanations['allow-always']!
    expect(text(always.label)).toBe('Always allow github')
    expect(text(always.explanation)).toBe(
      'Every tool from github, in every conversation, until you revoke it.'
    )
    expect(always.broader).toBe(true)
    expect(d.technicalDetails.serverName).toBe('github')
  })

  it('offers scopes least broad first and marks only "always" as broader', () => {
    const d = describePermissionRequest({ toolName: 'write', input: {} })
    expect(d.scopesOffered).toEqual(['allow-once', 'allow-thread', 'allow-always'])
    expect(d.scopeExplanations['allow-once']!.broader).toBe(false)
    expect(d.scopeExplanations['allow-thread']!.broader).toBe(false)
    expect(text(d.scopeExplanations['allow-thread']!.explanation)).toBe(
      'This tool, in this conversation, until you revoke it.'
    )
    expect(text(d.scopeExplanations['allow-always']!.label)).toBe(
      'Always allow write'
    )
  })

  // A temporary chat reuses one id, so a "this conversation" grant would carry
  // into the next temporary chat. Offering it would promise a scope the store
  // cannot keep.
  it('does not offer the conversation scope when the conversation id is reused', () => {
    const d = describePermissionRequest({
      toolName: 'fetch',
      serverName: 's',
      threadIsEphemeral: true,
    })
    expect(d.scopesOffered).toEqual(['allow-once', 'allow-always'])
    expect(d.scopeExplanations['allow-thread']).toBeUndefined()
  })

  it('shows a reason only when the caller supplied one', () => {
    expect(describePermissionRequest({ toolName: 'bash' }).reason).toBeUndefined()
    expect(
      describePermissionRequest({ toolName: 'bash', taskContext: '   ' }).reason
    ).toBeUndefined()
    expect(
      describePermissionRequest({
        toolName: 'bash',
        taskContext: 'Run the test suite',
      }).reason
    ).toBe('Run the test suite')
  })

  it('does not guess at an unknown tool', () => {
    const d = describePermissionRequest({ toolName: 'mystery' })
    expect(d.category).toBe('other')
    expect(text(d.action)).toBe('Flint wants to use mystery')
    expect(d.consequences.map(text)[0]).toMatch(/cannot tell what this tool does/)
    expect(d.resources).toEqual([])
    expect(d.technicalDetails.argumentsJson).toBe('')
  })

  it('describes helpers and memory saves in their own words', () => {
    expect(text(describePermissionRequest({ toolName: 'task' }).action)).toBe(
      'Flint wants to start a helper agent'
    )
    const memory = describePermissionRequest({
      toolName: 'memory_write',
      input: { name: 'prefs', content: 'x' },
    })
    expect(text(memory.action)).toBe('Flint wants to save something it will remember')
    expect(memory.consequences).toHaveLength(2)
  })

  it('lists the files a team declares it will change', () => {
    const d = describePermissionRequest({
      toolName: 'team',
      input: {
        tasks: [
          { id: 'a', description: 'x', writes: ['one.ts'] },
          { id: 'b', description: 'y', writes: ['two.ts', 'one.ts'] },
        ],
      },
    })
    expect(d.resources).toEqual(['one.ts', 'two.ts'])
  })

  it('pretty-prints arguments with secret-named keys redacted', () => {
    const d = describePermissionRequest({
      toolName: 'call',
      serverName: 'api',
      input: { apiKey: 'plain', nested: { Authorization: 'Bearer abc' }, n: 2 },
    })
    const parsed = JSON.parse(d.technicalDetails.argumentsJson)
    expect(parsed).toEqual({
      apiKey: REDACTED,
      nested: { Authorization: REDACTED },
      n: 2,
    })
    expect(d.technicalDetails.argumentsJson).toContain('\n  ')
  })
})

describe('sanitizing', () => {
  it('redacts common credential shapes', () => {
    for (const line of [
      'export API_KEY=abc123',
      'deploy --token=abcdefabcdef',
      'curl -H "Authorization: Bearer abc.def"',
      'aws AKIAIOSFODNN7EXAMPLE',
      'use sk-abcdefghijklmnop',
      'git clone https://user:pw@example.com/repo',
    ]) {
      expect(redactSecrets(line), line).toContain(REDACTED)
    }
  })

  it('leaves ordinary text alone', () => {
    for (const line of [
      'git status',
      'read /home/user/project/src/main.rs',
      'cargo test --workspace',
      'npm run build -- --mode=production',
    ]) {
      expect(redactSecrets(line)).toBe(line)
    }
  })

  it('truncates long resources to one bounded line', () => {
    const long = `echo ${'x'.repeat(400)}\nsecond line`
    const out = sanitizeResource(long)
    expect(out.length).toBe(MAX_RESOURCE_LENGTH)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toContain('\n')
  })

  it('bounds long argument strings', () => {
    const out = sanitizeValue({ content: 'y'.repeat(2000) }) as {
      content: string
    }
    expect(out.content.length).toBeLessThan(600)
    expect(out.content).toMatch(/more characters\)$/)
  })

  it('shortens a workspace path to its folder name', () => {
    expect(workspaceName('/a/b/Forma')).toBe('Forma')
    expect(workspaceName('C:\\x\\Forma\\')).toBe('Forma')
    expect(workspaceName('   ')).toBeUndefined()
    expect(workspaceName(undefined)).toBeUndefined()
  })
})

describe('git tool prompts', () => {
  it('names the command, remote and branch of a push, and that it reaches the remote', () => {
    const req = describePermissionRequest({
      toolName: 'git',
      input: { args: ['push', 'origin', 'feature/x'] },
    })
    expect(req.category).toBe('git')
    expect(text(req.categoryLabel)).toBe('Git')
    expect(req.resources).toEqual([
      'git push origin feature/x',
      'remote origin',
      'branch feature/x',
    ])
    expect(text(req.action)).toBe(
      'Flint wants to run git push origin feature/x, which changes origin'
    )
    expect(req.badges?.map((b) => text(b.message))).toEqual(['Reaches remote'])
    expect(req.warning).toBeUndefined()
    // Asked every time: nothing broader than "Allow once" is offered.
    expect(req.scopesOffered).toEqual(['allow-once'])
    req.consequences.forEach((c) => text(c))
  })

  it('shows the stronger warning for a force push', () => {
    const req = describePermissionRequest({
      toolName: 'git',
      input: { args: ['push', '--force', 'origin', 'main'] },
    })
    expect(req.badges?.map((b) => [text(b.message), b.tone])).toEqual([
      ['Reaches remote', 'warning'],
      ['Destructive', 'danger'],
    ])
    expect(text(req.warning!)).toMatch(/^Destructive: force push/)
    expect(req.scopesOffered).toEqual(['allow-once'])
  })

  it('says GitHub for gh', () => {
    const req = describePermissionRequest({
      toolName: 'git',
      input: { program: 'gh', args: ['pr', 'create', '--base', 'main', '--repo', 'o/r'] },
    })
    expect(req.resources).toContain('repo o/r')
    expect(req.resources).toContain('branch --base main')
    expect(text(req.badges![0].message)).toBe('Reaches GitHub')
  })

  it('offers the usual scopes for a local change', () => {
    const req = describePermissionRequest({
      toolName: 'git',
      input: { args: ['commit', '-m', 'x'] },
      workspaceLabel: 'C:/code/Forma',
    })
    expect(text(req.action)).toBe('Flint wants to run git commit -m x in Forma')
    expect(req.badges).toBeUndefined()
    expect(req.scopesOffered).toEqual(['allow-once', 'allow-thread', 'allow-always'])
  })

  it('offers only "Allow once" when the caller always asks', () => {
    const req = describePermissionRequest({ toolName: 'bash', input: {}, alwaysAsk: true })
    expect(req.scopesOffered).toEqual(['allow-once'])
  })

  it('offers a scoped standing grant for a recognized process stop', () => {
    const req = describePermissionRequest({
      toolName: 'host_powershell',
      input: { script: 'Stop-Process -Id 42' },
      alwaysAsk: true,
    })
    expect(req.scopesOffered).toEqual(['allow-once', 'allow-thread', 'allow-always'])
    expect(req.scopeExplanations['allow-always']?.explanation.key)
      .toBe('permissions:scope.allowSimilarExplanation')
  })

  it('explains clipboard read and offers narrow conversation and global grants', () => {
    const read = describePermissionRequest({ toolName: 'clipboard', input: { action: 'read' }, alwaysAsk: true })
    expect(read.action.key).toBe('permissions:action.readClipboard')
    expect(read.consequences[0].key).toBe('permissions:consequence.readClipboard')
    expect(read.scopesOffered).toEqual(['allow-once', 'allow-thread', 'allow-always'])
    const write = describePermissionRequest({ toolName: 'clipboard', input: { action: 'write', text: 'x' }, alwaysAsk: true })
    expect(write.scopesOffered).toEqual(['allow-once'])
  })
})

describe('self-approval MCP tools', () => {
  it('is flagged, warned about, and never offered a standing grant', () => {
    const req = describePermissionRequest({
      toolName: 'approve_command',
      serverName: 'super-shell',
      input: { command: 'rm -rf x' },
    })
    expect(req.scopesOffered).toEqual(['allow-once'])
    expect(text(req.badges![0].message)).toBe('Approves its own commands')
    expect(text(req.warning!)).toContain('super-shell')
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildSlashItems,
  expandCommand,
  filterSlashItems,
  markSkillMessage,
  parseSlashInput,
  parseSlashMarker,
  resolveSlash,
  slashDisplay,
  slashQuery,
  substituteArguments,
  type SlashCatalogEntry,
} from '../slashCommands'

const command = (
  name: string,
  plugin: string,
  body = 'Do $ARGUMENTS',
  extra: Partial<SlashCatalogEntry> = {}
): SlashCatalogEntry => ({
  kind: 'command',
  name,
  plugin,
  description: `${plugin} ${name}`,
  scope: 'project',
  body,
  ...extra,
})

const skill = (name: string, plugin?: string): SlashCatalogEntry => ({
  kind: 'skill',
  name,
  plugin,
  description: `skill ${name}`,
  scope: 'global',
})

describe('substituteArguments', () => {
  it('replaces $ARGUMENTS and positional words', () => {
    expect(substituteArguments('Release $1 to $2: $ARGUMENTS', 'v1.2 prod now')).toBe(
      'Release v1.2 to prod: v1.2 prod now'
    )
  })

  it('empties missing positions and leaves $10 and $ARGUMENTATION literal', () => {
    expect(substituteArguments('[$3] $10 $ARGUMENTATION $0', 'a b')).toBe(
      '[] $10 $ARGUMENTATION $0'
    )
  })

  it('keeps dollars that are not placeholders', () => {
    expect(substituteArguments('pay $x or $ now', 'a')).toBe('pay $x or $ now')
  })
})

describe('parseSlashInput', () => {
  it('splits the token and arguments', () => {
    expect(parseSlashInput('/git:commit fix the  bug\nmore')).toEqual({
      token: 'git:commit',
      args: 'fix the  bug\nmore',
    })
    expect(parseSlashInput('/help')).toEqual({ token: 'help', args: '' })
  })

  it('refuses paths and non-commands', () => {
    expect(parseSlashInput('/usr/bin/env python')).toBeNull()
    expect(parseSlashInput('/ nothing')).toBeNull()
    expect(parseSlashInput('hello /help')).toBeNull()
    expect(parseSlashInput('//comment')).toBeNull()
  })
})

describe('buildSlashItems', () => {
  it('offers the bare name only when it is unambiguous', () => {
    const items = buildSlashItems([
      command('commit', 'git'),
      command('deploy', 'ops'),
      command('deploy', 'infra'),
    ])
    const commit = items.find((i) => i.id === 'command:git:commit')!
    expect(commit.trigger).toBe('commit')
    expect(commit.aliases).toEqual(['git:commit', 'commit'])
    const deploys = items.filter((i) => i.entry?.name === 'deploy')
    expect(deploys.map((d) => d.trigger)).toEqual(['ops:deploy', 'infra:deploy'])
    expect(deploys.every((d) => !d.aliases.includes('deploy'))).toBe(true)
  })

  it('lets a built-in own its bare name', () => {
    const items = buildSlashItems([command('help', 'docs')], [
      { name: 'help', description: 'Help', run: () => {} },
    ])
    expect(resolveSlash('/help', items)!.item.kind).toBe('builtin')
    expect(resolveSlash('/docs:help', items)!.item.kind).toBe('command')
  })

  it('keeps a standalone skill name over a plugin entry of the same name', () => {
    const items = buildSlashItems([skill('review'), command('review', 'gh')])
    expect(resolveSlash('/review', items)!.item.kind).toBe('skill')
    expect(resolveSlash('/gh:review', items)!.item.kind).toBe('command')
  })

  it('derives an argument hint from placeholders', () => {
    const [item] = buildSlashItems([command('rel', 'p', 'x', { hints: ['$1', '$ARGUMENTS'] })])
    expect(item.argumentHint).toBe('<1> [arguments]')
    const [hinted] = buildSlashItems([command('rel', 'p', 'x', { argumentHint: '[tag]' })])
    expect(hinted.argumentHint).toBe('[tag]')
  })
})

describe('resolveSlash', () => {
  const items = buildSlashItems([command('commit', 'git'), skill('notes')])

  it('passes unknown commands and paths through as plain text', () => {
    expect(resolveSlash('/nope do it', items)).toBeNull()
    expect(resolveSlash('/usr/bin/env', items)).toBeNull()
    expect(resolveSlash('just text', items)).toBeNull()
  })

  it('resolves qualified and bare names with their arguments', () => {
    expect(resolveSlash('/git:commit  wip ', items)).toMatchObject({ args: 'wip' })
    expect(resolveSlash('/commit', items)!.item.id).toBe('command:git:commit')
    expect(resolveSlash('/notes today', items)).toMatchObject({ args: 'today' })
  })
})

describe('slashQuery and filterSlashItems', () => {
  it('only opens while the first token is typed', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/com')).toBe('com')
    expect(slashQuery('/commit ')).toBeNull()
    expect(slashQuery('/usr/')).toBeNull()
    expect(slashQuery('text')).toBeNull()
  })

  it('ranks prefix matches before substring and description matches', () => {
    const items = buildSlashItems([
      command('recommit', 'x', 'b', { description: 'other' }),
      command('commit', 'git'),
      command('push', 'y', 'b', { description: 'commit upstream' }),
    ])
    expect(filterSlashItems(items, 'commit').map((i) => i.trigger)).toEqual([
      'commit',
      'recommit',
      'push',
    ])
    expect(filterSlashItems(items, 'zzz')).toEqual([])
    expect(filterSlashItems(items, '')).toHaveLength(3)
  })
})

describe('expansion and the transcript marker', () => {
  it('expands a command body with its arguments behind a marker', () => {
    const text = expandCommand(
      command('commit', 'git', 'Commit: $ARGUMENTS ($1)', { allowedTools: ['Bash(git:*)', 'Read'] }),
      'fix --amend'
    )
    expect(text).toContain('You have invoked the "git:commit" command')
    expect(text).toContain('Commit: fix --amend (fix)')
    expect(text).toContain('[This command may use only these tools: Bash(git:*), Read]')
    const parsed = parseSlashMarker(text)!
    expect(parsed.invocation).toEqual({ kind: 'command', name: 'git:commit', args: 'fix --amend' })
    expect(parsed.body.startsWith('[IMPORTANT')).toBe(true)
    expect(slashDisplay(parsed.invocation)).toBe('/git:commit fix --amend')
  })

  it('appends arguments to a body without placeholders', () => {
    const text = expandCommand(command('lint', 'dev', 'Run the linter.'), 'src/')
    expect(text).toMatch(/Run the linter\.\n\nARGUMENTS: src\/$/)
  })

  it('survives arguments that would close an HTML comment', () => {
    const text = markSkillMessage('notes', 'a --> b }', 'Body')
    expect(text.split('\n')[0]).not.toMatch(/-->.*-->/)
    expect(parseSlashMarker(text)!.invocation.args).toBe('a --> b }')
    expect(parseSlashMarker(text)!.body).toBe('Body')
  })

  it('ignores ordinary messages and malformed markers', () => {
    expect(parseSlashMarker('hello')).toBeNull()
    expect(parseSlashMarker('<!-- flint:slash {bad} -->\nx')).toBeNull()
    expect(parseSlashMarker('<!-- flint:slash {"kind":"x","name":"a","args":""} -->\n')).toBeNull()
  })
})

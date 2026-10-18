import { beforeEach, describe, expect, it } from 'vitest'
import {
  fillPrompt,
  missingVars,
  parseVars,
  promptSlug,
  usePromptLibrary,
} from '../promptLibrary'
import { rankReferences, type ReferenceSources } from '../referenceMenu'

describe('parseVars', () => {
  it('finds plain and defaulted variables once each, in order', () => {
    expect(parseVars('Write about {{topic}} in a {{tone:friendly}} tone.')).toEqual([
      { name: 'topic' },
      { name: 'tone', default: 'friendly' },
    ])
  })

  it('asks for a repeated variable once and takes the first default', () => {
    expect(parseVars('{{x}} then {{x:later}} then {{x:other}}')).toEqual([
      { name: 'x', default: 'later' },
    ])
  })

  it('ignores escaped and malformed braces', () => {
    expect(parseVars('literal \\{{not}} and {{ }} and {{1bad}} and {single}')).toEqual([])
  })

  it('tolerates spaces inside the braces', () => {
    expect(parseVars('{{ name : Ada }}')).toEqual([{ name: 'name', default: 'Ada' }])
  })
})

describe('fillPrompt', () => {
  it('fills values, falls back to defaults, then to nothing', () => {
    const body = 'Hi {{who}}, tone {{tone:calm}}, {{missing}}!'
    expect(fillPrompt(body, { who: 'Sam' })).toBe('Hi Sam, tone calm, !')
    expect(fillPrompt(body, { who: 'Sam', tone: 'bold' })).toBe('Hi Sam, tone bold, !')
  })

  it('fills every occurrence of a repeated variable', () => {
    expect(fillPrompt('{{a}} and {{a}}', { a: 'x' })).toBe('x and x')
  })

  it('turns an escaped opener into literal braces', () => {
    expect(fillPrompt('use \\{{name}} syntax, hi {{name}}', { name: 'Bo' })).toBe(
      'use {{name}} syntax, hi Bo'
    )
  })

  it('never re-reads a value as a variable', () => {
    expect(fillPrompt('{{a}}', { a: '{{b}}' })).toBe('{{b}}')
  })

  it('a prompt with no variables is returned unchanged', () => {
    expect(fillPrompt('plain text', {})).toBe('plain text')
  })
})

describe('missingVars', () => {
  it('lists only required variables with no value', () => {
    const body = '{{a}} {{b:def}} {{c}}'
    expect(missingVars(body, { a: 'x' })).toEqual(['c'])
    expect(missingVars(body, { a: 'x', c: ' ' })).toEqual(['c'])
    expect(missingVars(body, { a: 'x', c: 'y' })).toEqual([])
  })
})

describe('promptSlug', () => {
  it('makes a command-safe slug', () => {
    expect(promptSlug('Weekly  Standup!')).toBe('weekly-standup')
    expect(promptSlug('???')).toBe('prompt')
  })

  it('keeps ASCII slugs and drops Latin accents', () => {
    expect(promptSlug('Code Review v2')).toBe('code-review-v2')
    expect(promptSlug('Café Menü')).toBe('cafe-menu')
  })

  it('gives non-Latin names their own slug instead of "prompt"', () => {
    expect(promptSlug('週次レポート')).toBe('週次レポート')
    expect(promptSlug('Еженедельный отчёт!')).toBe('еженедельный-отчёт')
    expect(promptSlug('がぎぐ')).toBe('がぎぐ')
    expect(promptSlug('週次レポート')).not.toBe(promptSlug('日次レポート'))
  })
})

describe('usePromptLibrary', () => {
  beforeEach(() => usePromptLibrary.setState({ prompts: [] }))

  it('refuses with a code, not English prose', () => {
    const s = usePromptLibrary.getState()
    expect(s.add({ name: ' ', body: 'x' })).toEqual({ ok: false, code: 'nameRequired' })
    expect(s.add({ name: 'a', body: ' ' })).toEqual({ ok: false, code: 'bodyRequired' })
    expect(s.update('nope', { name: 'a', body: 'b' })).toEqual({ ok: false, code: 'gone' })
    expect(s.importJson('{')).toEqual({ ok: false, code: 'invalidJson' })
    expect(s.importJson('{}')).toEqual({ ok: false, code: 'noPrompts' })
  })

  it('adds, updates and removes', () => {
    const add = usePromptLibrary.getState().add({ name: ' Standup ', body: 'What I did: {{x}}', tags: ['Work', 'work'] })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    expect(add.prompt.name).toBe('Standup')
    expect(add.prompt.tags).toEqual(['work'])
    const upd = usePromptLibrary.getState().update(add.prompt.id, { name: 'Standup 2', body: 'b', folder: 'Team' })
    expect(upd.ok && upd.prompt.folder).toBe('Team')
    usePromptLibrary.getState().remove(add.prompt.id)
    expect(usePromptLibrary.getState().prompts).toEqual([])
  })

  it('refuses an empty name or body', () => {
    expect(usePromptLibrary.getState().add({ name: ' ', body: 'x' }).ok).toBe(false)
    expect(usePromptLibrary.getState().add({ name: 'x', body: '  ' }).ok).toBe(false)
  })

  it('round-trips export and import without overwriting or duplicating', () => {
    usePromptLibrary.getState().add({ name: 'A', body: 'one {{v}}', folder: 'F', tags: ['t'] })
    const json = usePromptLibrary.getState().exportJson()
    // importing the same file adds nothing
    expect(usePromptLibrary.getState().importJson(json)).toEqual({ ok: true, added: 0 })
    usePromptLibrary.setState({ prompts: [] })
    expect(usePromptLibrary.getState().importJson(json)).toEqual({ ok: true, added: 1 })
    expect(usePromptLibrary.getState().prompts[0]).toMatchObject({ name: 'A', folder: 'F', tags: ['t'] })
  })

  it('rejects junk imports and skips bad entries', () => {
    expect(usePromptLibrary.getState().importJson('not json').ok).toBe(false)
    expect(usePromptLibrary.getState().importJson('{"x":1}').ok).toBe(false)
    const out = usePromptLibrary
      .getState()
      .importJson(JSON.stringify([{ name: 'ok', body: 'b' }, { name: 5 }, null, { name: '', body: 'x' }]))
    expect(out).toEqual({ ok: true, added: 1 })
  })
})

describe('prompts in the @ menu ranking', () => {
  const sources: ReferenceSources = {
    files: [{ path: 'src/standup.ts', name: 'standup.ts', kind: 'file', extension: 'ts' }],
    skills: [],
    agents: [],
    aliases: [],
    prompts: [
      { id: 'p1', name: 'Standup notes', detail: 'Team' },
      { id: 'p2', name: 'Translate', detail: 'standup helper' },
    ],
  }

  it('offers prompts with their id as the token, name matches first', () => {
    const found = rankReferences('standup', sources)
    expect(found.map((e) => [e.kind, e.token])).toEqual([
      ['prompt', 'prompt:p1'],
      ['file', 'src/standup.ts'],
      ['prompt', 'prompt:p2'],
    ])
  })

  it('narrows to prompts with the prompt: prefix', () => {
    expect(rankReferences('prompt:trans', sources).map((e) => e.token)).toEqual(['prompt:p2'])
  })

  it('is unchanged when there is no library', () => {
    expect(rankReferences('standup', { ...sources, prompts: undefined }).map((e) => e.kind)).toEqual([
      'file',
    ])
  })
})

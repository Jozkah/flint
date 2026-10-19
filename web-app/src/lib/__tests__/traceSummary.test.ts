import { describe, expect, it } from 'vitest'
import en from '@/locales/en/chat.json'
import ru from '@/locales/ru/chat.json'
import pl from '@/locales/pl/chat.json'
import cs from '@/locales/cs/chat.json'
import {
  partFailed,
  summarizeTrace,
  summaryDetails,
  summaryLabel,
  summaryPhrases,
  toolSentence,
  type TraceSummaryPart,
} from '../traceSummary'

const tool = (name: string, input: unknown = {}, state = 'output-available', output?: unknown) => ({
  type: `tool-${name}`,
  state,
  input,
  ...(output !== undefined ? { output } : {}),
})
const bash = (command: string, exit = 0) => ({
  ...tool('bash', { command }),
  output: `out\n[exit ${exit}]`,
})

// A small i18next stand-in over the real locale files: CLDR plural forms via
// Intl.PluralRules, the same way i18next picks `_one/_few/_many/_other`.
const tFor = (lang: string, bundle: typeof en) => {
  const rules = new Intl.PluralRules(lang)
  const dict = bundle.transcriptView.summary as Record<string, string>
  return (key: string, opts?: Record<string, unknown>) => {
    const name = key.replace('chat:transcriptView.summary.', '')
    const count = Number(opts?.count ?? 0)
    const text = dict[`${name}_${rules.select(count)}`] ?? dict[name] ?? key
    return text.replace('{{count}}', String(count))
  }
}
const t = tFor('en', en)
const label = (parts: TraceSummaryPart[]) => summaryLabel(summarizeTrace(parts), t)

describe('summarizeTrace', () => {
  it('counts commands, files and other tools, with line totals', () => {
    const s = summarizeTrace([
      tool('bash', { command: 'ls' }),
      tool('bash', { command: 'pwd' }),
      tool('write', { path: 'a.ts', content: 'one\ntwo\nthree\n' }),
      tool('write', { path: 'b.ts', content: 'x' }),
      tool('edit', { path: 'a.ts', edits: [{ old_string: 'a\nb', new_string: 'c' }] }),
      tool('edit', { path: 'a.ts', edits: [{ old_string: 'c', new_string: 'd\ne' }] }),
      tool('read', { path: 'a.ts' }),
      tool('grep', { pattern: 'x' }),
      tool('web_search', { query: 'q' }),
      { type: 'text' },
    ])
    expect(s).toMatchObject({
      commands: 2, created: 2, edited: 1, read: 1, searched: 1, tools: 1, failed: 0,
      added: 3 + 1 + 1 + 2, removed: 2 + 1,
    })
  })

  it('counts only the lines an edit really changes', () => {
    const s = summarizeTrace([
      tool('edit', {
        path: 'a.ts',
        edits: [{ old_string: 'one\ntwo', new_string: 'one\nnew1\nnew2\nnew3\ntwo' }],
      }),
    ])
    expect(s).toMatchObject({ added: 3, removed: 0 })
  })

  it('treats a command that exited non-zero as failed', () => {
    expect(partFailed({ ...tool('bash'), output: 'ok\n[exit 0]' })).toBe(false)
    expect(partFailed({ ...tool('bash'), output: 'no\n[exit 2]' })).toBe(true)
  })
})

describe('summaryLabel', () => {
  it.each<[string, TraceSummaryPart[], string | undefined]>([
    ['all ok', [bash('ls'), tool('edit', { path: 'a' }), tool('read', { path: 'b' })],
      'Edited 1 file, ran 1 command, read 1 file'],
    ['one failed command: marked on commands, not on the last kind',
      [bash('ls'), bash('make', 2), tool('write', { path: 'n' }), tool('edit', { path: 'a' }), tool('read', { path: 'r' })],
      'Edited 1 file, created 1 file, ran 2 commands (1 failed), read 1 file'],
    ['a failed edit is reported on edits',
      [tool('edit', { path: 'a' }, 'output-error'), bash('ls')],
      'Could not edit 1 file, ran 1 command'],
    ['a denied write is reported on created, with no lines added',
      [tool('write', { path: 'a', content: 'x\ny' }, 'output-denied')],
      'Could not create 1 file'],
    ['a write refused in its output text is not created',
      [tool('write', { path: 'a', content: 'x' }, 'output-available', 'Denied: the user declined this write'),
       tool('edit', { path: 'b' }, 'output-available', 'ERROR: [sandbox_denied] path is outside the workspace')],
      'Could not edit 1 file, could not create 1 file'],
    ['two failed writes are not "created 2 files"',
      [tool('write', { path: 'a' }, 'output-error'), tool('write', { path: 'b' }, 'output-denied')],
      'Could not create 2 files'],
    ['some writes failed: only the ones that went through are created',
      [tool('write', { path: 'a' }), tool('write', { path: 'b' }, 'output-error')],
      'Created 1 file (1 failed)'],
    ['a call awaiting approval is not counted yet',
      [bash('ls'), tool('bash', { command: 'git push' }, 'approval-requested'), tool('bash', { command: 'x' }, 'input-available')],
      'Ran 1 command'],
    ['a retried command that then worked is one success',
      [bash('yarn test', 1), bash('yarn test')],
      'Ran 1 command'],
    ['a command re-run after a fix counts twice, keeping its failure',
      [bash('yarn test', 1), tool('edit', { path: 'a' }), bash('yarn test')],
      'Edited 1 file, ran 2 commands (1 failed)'],
    ['a retried edit that then worked is not a failure',
      [tool('edit', { path: 'a' }, 'output-error'), tool('edit', { path: 'a' })],
      'Edited 1 file'],
    ['the same command run twice on purpose counts twice',
      [bash('git status'), bash('git status')],
      'Ran 2 commands'],
    ['zero of a kind is left out', [tool('read', { path: 'a' }), tool('grep', { pattern: 'x' })],
      'Read 1 file, searched 1 time'],
    ['only reads, one file read twice', [tool('read', { path: 'a' }), tool('read', { path: 'a' }), tool('read', { path: 'b' })],
      'Read 2 files'],
    ['1 vs many', [bash('a'), bash('b'), bash('c')], 'Ran 3 commands'],
    ['nothing finished', [tool('bash', { command: 'ls' }, 'input-streaming')], undefined],
  ])('%s', (_name, parts, expected) => {
    expect(label(parts)).toBe(expected)
  })

  it('follows a fixed order: edited, created, commands, read, searched, tools', () => {
    const s = summarizeTrace([
      tool('web_fetch', { url: 'u' }), tool('grep', {}), tool('read', { path: 'r' }),
      bash('ls'), tool('write', { path: 'w' }), tool('edit', { path: 'e' }),
    ])
    expect(summaryPhrases(s).map((p) => p.key)).toEqual([
      'edited', 'created', 'commands', 'read', 'searched', 'tools',
    ])
  })

  it.each([
    ['ru', ru, [1, 2, 5], ['выполнена 1 команда', 'выполнено 2 команды', 'выполнено 5 команд']],
    ['pl', pl, [1, 2, 5], ['uruchomiono 1 polecenie', 'uruchomiono 2 polecenia', 'uruchomiono 5 poleceń']],
    ['cs', cs, [1, 2, 5], ['spustil 1 příkaz', 'spustil 2 příkazy', 'spustil 5 příkazů']],
  ] as const)('%s uses its plural forms', (lang, bundle, counts, expected) => {
    const tl = tFor(lang, bundle as typeof en)
    counts.forEach((n, i) => {
      const parts = Array.from({ length: n }, (_, k) => bash(`c${k}`))
      const text = summaryLabel(summarizeTrace(parts), tl) ?? ''
      expect(text.toLowerCase()).toBe(expected[i].toLowerCase())
    })
  })
})

describe('summaryDetails', () => {
  it('lists each finished call with its status', () => {
    expect(
      summaryDetails([
        bash('ls'),
        bash('make', 2),
        tool('edit', { path: 'x/y.ts' }, 'output-error'),
        tool('bash', { command: 'git push' }, 'approval-requested'),
      ])
    ).toBe('✓ Ran ls\n✗ Ran make\n✗ Edited y.ts')
  })
})

describe('toolSentence', () => {
  it('prefers the description the model wrote', () => {
    expect(toolSentence(tool('bash', { command: 'ls', description: 'Listed patch files' }))).toBe('Listed patch files')
  })

  it('builds one from the arguments otherwise', () => {
    expect(toolSentence(tool('read', { path: 'C:/a/b/AUDIT.md' }))).toBe('Read AUDIT.md')
    expect(toolSentence(tool('write', { path: 'x/notes.md' }))).toBe('Created notes.md')
    expect(toolSentence(tool('edit', { path: 'x/y.ts' }))).toBe('Edited y.ts')
    expect(toolSentence(tool('grep', { pattern: 'foo' }))).toBe('Searched for foo')
    expect(toolSentence(tool('bash', { command: 'git   status' }))).toBe('Ran git status')
    expect(toolSentence(tool('memory_read', {}))).toBe('Used memory read')
  })
})

import { describe, it, expect } from 'vitest'
import {
  exportFileName,
  renderMarkdown,
  renderObsidian,
  stripAbsolutePaths,
  type ExportDoc,
} from '../exportMarkdown'
import { docFromCowork, docFromThread, docFromUIMessage } from '../exportDoc'

const base: ExportDoc = {
  title: 'Trip plan',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  model: 'llama-3',
  messages: [
    { role: 'user', text: 'Plan a trip, see @src/trip.md:3', at: Date.UTC(2026, 9, 1, 9, 30) },
    {
      role: 'assistant',
      text: 'Done. Saved to C:\\Users\\me\\proj\\trip.md and /home/me/proj/notes.txt.',
      reasoning: 'thinking about it',
      tools: [
        {
          name: 'write',
          input: { path: 'C:\\Users\\me\\proj\\trip.md' },
          output: 'wrote 120 bytes',
        },
        { name: 'bash', output: 'boom', isError: true },
      ],
    },
  ],
}

describe('exportFileName', () => {
  it('replaces characters Windows forbids', () => {
    expect(exportFileName('a<b>c:d"e/f\\g|h?i*j', 'md')).toBe('a-b-c-d-e-f-g-h-i-j.md')
  })
  it('drops control characters, trailing dots and doubled extensions', () => {
    expect(exportFileName('line1\nline2. ', 'md')).toBe('line1 line2.md')
    expect(exportFileName('notes.md', 'md')).toBe('notes.md')
    expect(exportFileName('report...', 'pdf')).toBe('report.pdf')
  })
  it('defuses reserved device names and empty titles', () => {
    expect(exportFileName('CON', 'png')).toBe('_CON.png')
    expect(exportFileName('  ', 'md')).toBe('export.md')
    expect(exportFileName('???', 'md')).toBe('---.md')
  })
  it('bounds the length', () => {
    expect(exportFileName('x'.repeat(500), 'md').length).toBe(83)
  })
})

describe('stripAbsolutePaths', () => {
  it('cuts machine paths to the file name and leaves URLs alone', () => {
    expect(stripAbsolutePaths('see C:\\Users\\me\\a\\b.ts now')).toBe('see b.ts now')
    expect(stripAbsolutePaths('at /home/me/x/y.py.')).toBe('at y.py.')
    expect(stripAbsolutePaths('https://example.com/home/me/x')).toBe(
      'https://example.com/home/me/x'
    )
    expect(stripAbsolutePaths('relative/dir/file.ts')).toBe('relative/dir/file.ts')
  })
})

describe('renderMarkdown', () => {
  it('writes a heading, a note and each turn', () => {
    const md = renderMarkdown(base)
    expect(md).toMatch(/^# Trip plan\n/)
    expect(md).toContain('> Exported from Flint · 2026-10-01 · llama-3')
    expect(md).toContain('## User · 2026-10-01 09:30')
    expect(md).toContain('## Assistant')
  })

  it('default view omits tool bodies, reasoning and absolute paths', () => {
    const md = renderMarkdown(base)
    expect(md).toContain('- Used `write`')
    expect(md).toContain('- Used `bash` (failed)')
    expect(md).not.toContain('wrote 120 bytes')
    expect(md).not.toContain('thinking about it')
    expect(md).not.toContain('C:\\Users')
    expect(md).not.toContain('/home/me')
    expect(md).toContain('trip.md')
  })

  it('verbose view keeps tool bodies, reasoning and paths', () => {
    const md = renderMarkdown(base, { view: 'verbose' })
    expect(md).toContain('wrote 120 bytes')
    expect(md).toContain('thinking about it')
    expect(md).toContain('C:\\\\Users\\\\me\\\\proj\\\\trip.md')
    expect(md).toContain('/home/me/proj/notes.txt')
  })

  it('fences tool output with more backticks than it contains', () => {
    const md = renderMarkdown(
      {
        ...base,
        messages: [{ role: 'assistant', text: '', tools: [{ name: 't', output: 'a ```x``` b' }] }],
      },
      { view: 'verbose' }
    )
    expect(md).toContain('````\na ```x``` b\n````')
  })

  it('says so when the thread is empty', () => {
    const md = renderMarkdown({ ...base, messages: [] })
    expect(md).toContain('_This conversation is empty._')
  })

  it('does not fail on a message with no text', () => {
    const md = renderMarkdown({ ...base, messages: [{ role: 'assistant', text: '  ' }] })
    expect(md).toContain('_(no text)_')
  })

  it('collapses a multi-line title to one heading line', () => {
    expect(renderMarkdown({ ...base, title: 'a\nb' })).toMatch(/^# a b\n/)
  })
})

describe('renderObsidian', () => {
  it('starts with YAML frontmatter and tags', () => {
    const note = renderObsidian(base)
    expect(note.startsWith('---\n')).toBe(true)
    const front = note.split('\n---\n')[0]
    expect(front).toContain('title: "Trip plan"')
    expect(front).toContain('type: chat')
    expect(front).toContain('model: "llama-3"')
    expect(front).toContain('messages: 2')
    expect(front).toContain('tags:\n  - flint\n  - flint/chat')
  })

  it('escapes quotes, colons, newlines and backslashes in the title', () => {
    const note = renderObsidian({ ...base, title: 'He said "hi": a\nb \\ c' })
    const line = note.split('\n').find((l) => l.startsWith('title:'))!
    expect(line).toBe('title: "He said \\"hi\\": a b \\\\ c"')
    // One physical line: a newline in a title must not break the frontmatter.
    expect(note.split('\n---\n')[0].split('\n').filter((l) => l.startsWith('title:'))).toHaveLength(1)
  })

  it('escapes a model name that looks like YAML', () => {
    const note = renderObsidian({ ...base, model: 'a: b\n- c' })
    expect(note).toContain('model: "a: b - c"')
  })

  it('turns @path references into wikilinks outside code fences', () => {
    const note = renderObsidian({
      ...base,
      messages: [{ role: 'user', text: 'open @src/a.ts:12 then\n```\n@keep/this.ts\n```' }],
    })
    expect(note).toContain('open [[src/a.ts]] then')
    expect(note).toContain('@keep/this.ts')
    expect(note).not.toContain('[[keep/this.ts]]')
  })

  it('links attachments by name; plain Markdown does not', () => {
    const doc: ExportDoc = {
      ...base,
      messages: [{ role: 'user', text: 'hi', files: ['report.pdf'] }],
    }
    expect(renderObsidian(doc)).toContain('Attached: [[report.pdf]]')
    expect(renderMarkdown(doc)).toContain('Attached: `report.pdf`')
  })

  it('tags a Cowork session and a single message by scope', () => {
    expect(renderObsidian({ ...base, scope: 'session' })).toContain('  - flint/cowork')
    expect(renderObsidian({ ...base, scope: 'message' })).toContain('type: chat-message')
  })

  it('renders an empty thread with valid frontmatter', () => {
    const note = renderObsidian({ ...base, messages: [] })
    expect(note).toContain('messages: 0')
    expect(note).toContain('_This conversation is empty._')
  })
})

describe('document adapters', () => {
  const now = new Date('2026-10-01T10:00:00Z')

  it('folds Cowork tool rows into the assistant reply and skips hidden turns', () => {
    const doc = docFromCowork(
      {
        id: 's',
        title: 'Fix it',
        turns: [
          { role: 'user', content: 'fix' },
          { role: 'user', content: 'continue', hidden: true },
          { role: 'tool', content: '', name: 'edit', args: { p: 1 }, result: 'ok' },
          { role: 'assistant', content: 'done' },
        ],
      },
      now
    )
    expect(doc.scope).toBe('session')
    expect(doc.messages).toHaveLength(3)
    expect(doc.messages[1].tools?.[0]).toMatchObject({ name: 'edit', output: 'ok' })
    expect(doc.messages[2].text).toBe('done')
  })

  it('reads a stored thread: text, reasoning, images and tool calls; drops system rows', () => {
    const doc = docFromThread(
      { id: 't', title: '', model: { id: 'm1' } },
      [
        { id: '1', role: 'system', content: [{ type: 'text', text: { value: 's', annotations: [] } }], created_at: 1 },
        { id: '2', role: 'user', content: [{ type: 'text', text: { value: 'hello', annotations: [] } }, { type: 'image_url', image_url: { url: 'x' } }], created_at: 1_700_000_000 },
        {
          id: '3',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: { value: 'hmm', annotations: [] } },
            { type: 'tool_call', tool_name: 'search', input: { q: 1 }, output: 'r' },
            { type: 'text', text: { value: 'answer', annotations: [] } },
          ],
          created_at: 1_700_000_001,
        },
      ] as never,
      now
    )
    expect(doc.title).toBe('New conversation')
    expect(doc.model).toBe('m1')
    expect(doc.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(doc.messages[0].images).toBe(1)
    expect(doc.messages[0].at).toBe(1_700_000_000_000)
    expect(doc.messages[1]).toMatchObject({ text: 'answer', reasoning: 'hmm' })
    expect(doc.messages[1].tools?.[0].name).toBe('search')
  })

  it('exports one UI message with tool parts and a snippet title', () => {
    const doc = docFromUIMessage(
      {
        id: 'm',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'The answer is 4' },
          { type: 'tool-calc', toolCallId: 'c', state: 'output-available', input: { a: 2 }, output: 4 },
        ],
      } as never,
      undefined,
      now
    )
    expect(doc.scope).toBe('message')
    expect(doc.title).toBe('The answer is 4')
    expect(doc.messages[0].tools?.[0]).toMatchObject({ name: 'calc', output: 4 })
    const md = renderMarkdown(doc)
    expect(md).toContain('- Used `calc`')
    expect(md).not.toContain('"a"')
  })
})

import { describe, it, expect } from 'vitest'
import {
  AUTO_TITLE_SOURCE_KEY,
  beginAutoTitle,
  decideAutoTitle,
  endAutoTitle,
  firstUserText,
} from '@/lib/threadAutoTitle'

const msg = (role: string, text: string) => ({
  role,
  content: [{ text: { value: text } }],
})

describe('decideAutoTitle', () => {
  const base = { enabled: true }

  it('titles a new chat on its first reply', () => {
    const d = decideAutoTitle({
      ...base,
      threadId: 't1',
      metadata: {},
      messages: [msg('user', 'hello'), msg('assistant', 'hi')],
    })
    expect(d).toEqual({ kind: 'generate', source: 'hello' })
  })

  it('does not re-title once the source is recorded, however many replies', () => {
    const messages = [msg('user', 'hello')]
    for (let i = 0; i < 8; i++) messages.push(msg('assistant', `r${i}`))
    const d = decideAutoTitle({
      ...base,
      threadId: 't2',
      metadata: { [AUTO_TITLE_SOURCE_KEY]: 'hello' },
      messages,
    })
    expect(d.kind).toBe('skip')
  })

  it('re-titles when the first user message was edited', () => {
    const d = decideAutoTitle({
      ...base,
      threadId: 't3',
      metadata: { [AUTO_TITLE_SOURCE_KEY]: 'hello' },
      messages: [msg('user', 'hello there, edited'), msg('assistant', 'hi')],
    })
    expect(d).toEqual({ kind: 'generate', source: 'hello there, edited' })
  })

  it('never replaces a title the user set', () => {
    const d = decideAutoTitle({
      ...base,
      threadId: 't4',
      metadata: { titleSetManually: true, [AUTO_TITLE_SOURCE_KEY]: 'a' },
      messages: [msg('user', 'b'), msg('assistant', 'x')],
    })
    expect(d.kind).toBe('skip')
  })

  it('skips while a title for the same source is in flight', () => {
    const args = {
      ...base,
      threadId: 't5',
      metadata: {},
      messages: [msg('user', 'q'), msg('assistant', 'a')],
    }
    beginAutoTitle('t5', 'q')
    expect(decideAutoTitle(args).kind).toBe('skip')
    endAutoTitle('t5', 'q')
    expect(decideAutoTitle(args).kind).toBe('generate')
  })

  it('adopts the title of an older chat without calling the model', () => {
    const d = decideAutoTitle({
      ...base,
      threadId: 't6',
      metadata: {},
      messages: [msg('user', 'q'), msg('assistant', 'a'), msg('user', 'q2'), msg('assistant', 'b')],
    })
    expect(d).toEqual({ kind: 'adopt', source: 'q' })
  })

  it('is off when the setting is off', () => {
    expect(
      decideAutoTitle({ enabled: false, threadId: 't7', metadata: {}, messages: [msg('user', 'q')] }).kind
    ).toBe('skip')
  })
})

describe('firstUserText', () => {
  it('reads the first user message only', () => {
    expect(firstUserText([msg('assistant', 'x'), msg('user', ' a '), msg('user', 'b')])).toBe('a')
  })
})

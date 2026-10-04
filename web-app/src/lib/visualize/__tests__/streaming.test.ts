import { describe, expect, it } from 'vitest'
import { partialWidgetArgs } from '../code'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import type { CoworkTurn } from '@/hooks/useCoworkSessions'

describe('partialWidgetArgs', () => {
  it('reads the title and the code written so far from unfinished JSON', () => {
    const text = '{"title":"Flow","loading_messages":["One","Two"],"widget_code":"<div class=\\"a\\">hi\\n<b'
    expect(partialWidgetArgs(text)).toEqual({
      title: 'Flow',
      loading_messages: ['One', 'Two'],
      widget_code: '<div class="a">hi\n<b',
    })
  })
  it('handles an escape cut in half and unicode', () => {
    expect(partialWidgetArgs('{"widget_code":"a\\').widget_code).toBe('a')
    expect(partialWidgetArgs('{"widget_code":"a\\u00e9\\u00').widget_code).toBe('a\u00e9')
  })
  it('stops at the closing quote', () => {
    expect(partialWidgetArgs('{"widget_code":"<p>x</p>","title":"T"}')).toMatchObject({
      widget_code: '<p>x</p>',
      title: 'T',
    })
  })
  it('returns nothing before the code starts', () => {
    expect(partialWidgetArgs('{"tit').widget_code).toBeUndefined()
  })
})

describe('Cowork turns while a widget streams', () => {
  const row = (over: Partial<CoworkTurn>): CoworkTurn =>
    ({ role: 'tool', content: '', callId: 'w1', name: 'show_widget', status: 'running', ...over }) as CoworkTurn
  const partOf = (turns: CoworkTurn[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (coworkTurnsToUIMessages(turns)[0].parts as any[]).find((p) => p.type === 'tool-show_widget')

  it('is an input-streaming part with the partial arguments', () => {
    const p = partOf([row({ args: null, argsLive: '{"title":"T","widget_code":"<div>hel' })])
    expect(p.state).toBe('input-streaming')
    expect(p.input).toMatchObject({ title: 'T', widget_code: '<div>hel' })
  })
  it('is a complete input once the parsed arguments land', () => {
    const p = partOf([row({ args: { title: 'T', widget_code: '<p>x</p>' }, argsLive: undefined })])
    expect(p.state).toBe('input-available')
    expect(p.input.widget_code).toBe('<p>x</p>')
  })
  it('is not folded away as hidden activity when hiding completed tools', () => {
    const msgs = coworkTurnsToUIMessages(
      [row({ status: 'done', args: { title: 'T', widget_code: '<p>x</p>' }, result: 'ok' })],
      { hideCompletedTools: true }
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((msgs[0].parts as any[]).some((p) => p.type === 'tool-show_widget')).toBe(true)
  })
})

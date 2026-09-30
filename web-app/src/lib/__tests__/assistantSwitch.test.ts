import { describe, expect, it } from 'vitest'
import { switchedFromOf } from '../assistantSwitch'

const a = (name?: string) => ({ role: 'assistant', metadata: name ? { assistantName: name } : {} })
const u = { role: 'user', metadata: {} }

describe('switchedFromOf', () => {
  it('names the assistant that answered before, when it differs', () => {
    expect(switchedFromOf([u, a('Flint'), u, a('Quartz')], 3)).toBe('Flint')
  })

  it('is undefined for the same assistant, the first reply, a user message or no names', () => {
    expect(switchedFromOf([u, a('Flint'), u, a('Flint')], 3)).toBeUndefined()
    expect(switchedFromOf([u, a('Flint')], 1)).toBeUndefined()
    expect(switchedFromOf([u, a('Flint')], 0)).toBeUndefined()
    expect(switchedFromOf([u, a(), u, a('Quartz')], 3)).toBeUndefined()
    expect(switchedFromOf([u, a('Flint'), u, a()], 3)).toBeUndefined()
  })
})

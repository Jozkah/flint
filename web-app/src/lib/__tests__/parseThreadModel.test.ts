import { describe, expect, it } from 'vitest'
import { parseThreadModel } from '../parseThreadModel'

describe('parseThreadModel', () => {
  it('accepts an object with string id and provider', () => {
    expect(parseThreadModel({ id: 'm', provider: 'p', extra: 1 })).toEqual({
      id: 'm',
      provider: 'p',
    })
  })

  it('rejects anything else', () => {
    expect(parseThreadModel('foo')).toBeUndefined()
    expect(parseThreadModel(undefined)).toBeUndefined()
    expect(parseThreadModel(null)).toBeUndefined()
    expect(parseThreadModel({ id: 1, provider: 'p' })).toBeUndefined()
    expect(parseThreadModel({ id: 'm' })).toBeUndefined()
  })
})

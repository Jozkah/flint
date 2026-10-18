import { describe, expect, it } from 'vitest'
import { splitTitleTail } from '../titleTail'

describe('splitTitleTail (T7-026)', () => {
  it('keeps the fork mark and trailing numbers apart so they never fade out', () => {
    expect(splitTitleTail('Number Sequence Generation (fork)')).toEqual(['Number Sequence Generation', ' (fork)'])
    expect(splitTitleTail('Number Sequence Generation (2)')).toEqual(['Number Sequence Generation', ' (2)'])
    expect(splitTitleTail('Draft 12')).toEqual(['Draft', ' 12'])
  })
  it('leaves a title without such a tail whole', () => {
    expect(splitTitleTail('Cache bug')).toEqual(['Cache bug', ''])
    expect(splitTitleTail('(fork)')).toEqual(['(fork)', ''])
    expect(splitTitleTail('')).toEqual(['', ''])
  })
})

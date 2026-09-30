import { afterEach, describe, expect, it } from 'vitest'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { replyLanguageLine } from '../replyLanguage'
import { languageCue } from '../rooms/context'

afterEach(() => useGeneralSetting.setState({ replyLanguage: '' }))

describe('reply language', () => {
  it('adds nothing until a language is pinned', () => {
    expect(replyLanguageLine()).toBe('')
  })

  it('names the pinned language and keeps code as it is', () => {
    useGeneralSetting.setState({ replyLanguage: 'French' })
    const line = replyLanguageLine()
    expect(line).toContain('in French')
    expect(line).toContain('code')
  })

  it("wins over the room's own language guess", () => {
    useGeneralSetting.setState({ replyLanguage: 'German' })
    expect(languageCue({ objective: 'Fix the tests' } as never)).toBe('Reply in German.')
  })
})

import { describe, it, expect } from 'vitest'
import i18n from '../setup'

/**
 * The app's own `t` had no plural support: every key written as `key_one` /
 * `key_other` in the locale files rendered as the raw key. Found in the real
 * app, where the Background Tasks panel's header read
 * "common:tasks.summaryNoTokens" and held steering input read
 * "common:steering.held".
 */
describe('plural keys', () => {
  it('picks _one and _other by count, with interpolation', () => {
    expect(i18n.t('common:tasks.summaryNoTokens', { count: 1 })).not.toContain('common:')
    expect(i18n.t('common:steering.held', { count: 1 })).toBe(
      '1 message was not delivered: the run it was typed for did not take it'
    )
    expect(i18n.t('common:steering.held', { count: 3 })).toBe(
      '3 messages were not delivered: the run they were typed for did not take them'
    )
  })

  it('prefers the exact plural form over a bare key, and falls back to it', () => {
    expect(i18n.t('common:coworkDisplay.hiddenCount', { count: 1 })).toBe(
      '1 completed tool activity hidden'
    )
    expect(i18n.t('common:coworkDisplay.hiddenCount', { count: 4 })).toBe(
      '4 completed tool activities hidden'
    )
  })

  it('uses _other where a language has no _one', () => {
    expect(i18n.t('common:changes.truncated', { count: 1 })).not.toContain('common:')
  })

  it('leaves keys without a count alone', () => {
    expect(i18n.t('common:steering.send')).toBe('Send')
  })
})

import { describe, it, expect } from 'vitest'
import i18n from '../setup'

/**
 * Several resource keys exist only in i18next's `_one`/`_other` plural form
 * (htmlArtifact.unresolvedAssets, preview.unresolvedRefs). The custom `t` must
 * resolve those when a numeric `count` is passed, or the raw key renders at the
 * user.
 */
describe('i18n plural resolution', () => {
  it('picks the _one form for count 1', () => {
    expect(i18n.t('common:preview.unresolvedRefs', { count: 1 })).toContain(
      '1 file this page links to'
    )
  })

  it('picks the _other form for other counts', () => {
    expect(i18n.t('common:preview.unresolvedRefs', { count: 3 })).toContain(
      '3 files this page links to'
    )
    expect(i18n.t('common:preview.unresolvedRefs', { count: 0 })).toContain(
      '0 files this page links to'
    )
  })

  it('still resolves plain keys with a count present', () => {
    expect(i18n.t('common:close', { count: 2 })).toBe('Close')
  })

  it('resolves the pre-existing plural-only keys', () => {
    expect(
      i18n.t('common:htmlArtifact.unresolvedAssets', { count: 2 })
    ).toContain('2 asset references')
  })
})

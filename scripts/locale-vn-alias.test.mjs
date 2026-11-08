// Vietnamese ships under the folder and saved-preference code `vn`, while
// browsers and Intl use `vi`. Every place that crosses between the two keeps
// an alias. A partial rename (the folder moved, one alias forgotten) would
// silently drop Vietnamese users to English, so the pieces are pinned
// together here: change them together or not at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { missingPluralForms } from './check-locale-parity.mjs'

const root = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('the Vietnamese locale folder and picker value are vn', () => {
  assert.ok(existsSync(join(root, 'web-app/src/locales/vn')), 'locales/vn is missing')
  assert.ok(!existsSync(join(root, 'web-app/src/locales/vi')), 'a vi folder needs the saved-preference migration')
  assert.match(read('web-app/src/containers/LanguageSwitcher.tsx'), /value:\s*'vn'/)
})

test('a phone reporting vi is served the vn folder', () => {
  assert.match(read('web-app/src/mobile/i18n.ts'), /\bvi:\s*'vn'/)
})

test('vn is mapped to vi wherever a tag reaches Intl or the document', () => {
  assert.match(read('web-app/src/lib/localeDate.ts'), /\{\s*vn:\s*'vi'\s*\}/)
  assert.match(read('web-app/src/i18n/TranslationContext.tsx'), /lng === 'vn' \? 'vi'/)
})

test('the parity check reads vn with Vietnamese plural rules', () => {
  const english = new Map([['items_one', '1 item'], ['items_other', 'n items']])
  const vietnamese = new Map([['items_other', 'n mục']])
  assert.deepEqual(missingPluralForms('vn', english, vietnamese), [])
})

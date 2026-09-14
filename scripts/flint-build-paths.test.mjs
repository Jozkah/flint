import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const makefile = readFileSync(new URL('../makefile', import.meta.url), 'utf8')

test('release and development build recipes stage the Flint CLI binary', () => {
  assert.doesNotMatch(makefile, /target[\\/]\S*[\\/]jan(?:\.exe)?/i)
  assert.doesNotMatch(makefile, /resources[\\/]bin[\\/]jan(?:\.exe)?/i)
  assert.match(makefile, /target[\\/]release[\\/]flint\.exe/)
  assert.match(makefile, /resources[\\/]bin[\\/]flint\.exe/)
})

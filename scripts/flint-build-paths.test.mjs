import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
const appImage = readFileSync(new URL('../src-tauri/build-utils/buildAppImage.sh', import.meta.url), 'utf8')
const nsis = readFileSync(new URL('../src-tauri/tauri.bundle.windows.nsis.template', import.meta.url), 'utf8')

test('release and development build recipes stage the Flint CLI binary', () => {
  assert.doesNotMatch(makefile, /target[\\/]\S*[\\/]jan(?:\.exe)?/i)
  assert.doesNotMatch(makefile, /resources[\\/]bin[\\/]jan(?:\.exe)?/i)
  assert.match(makefile, /target[\\/]release[\\/]flint\.exe/)
  assert.match(makefile, /resources[\\/]bin[\\/]flint\.exe/)
})

test('platform packaging never emits legacy Jan product or CLI names', () => {
  assert.doesNotMatch(appImage, /\/Jan(?:-|\.)/)
  assert.match(appImage, /\/Flint(?:-|\.)/)
  assert.doesNotMatch(nsis, /oname=jan\.exe/i)
  assert.match(nsis, /oname=flint\.exe/i)
})

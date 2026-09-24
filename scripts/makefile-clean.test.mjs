import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')

// #49: double quotes suppress tilde and glob expansion, so `rm -rf "~/..."`
// removed a literal relative path and `make clean` left the home-directory
// data in place while reporting success.
test('clean recipes do not quote home-relative paths', () => {
  const quotedHome = makefile
    .split(/\r?\n/)
    .filter((line) => /\brm\b/.test(line) && /["']~\//.test(line))
  assert.deepEqual(quotedHome, [])
})

test('the Linux clean branch still removes the extension and cache dirs', () => {
  assert.match(makefile, /^\trm -rf ~\/jan\/extensions\r?$/m)
  assert.match(makefile, /^\trm -rf ~\/\.cache\/jan\*\r?$/m)
})

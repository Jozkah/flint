/**
 * Tests for the icon build wrapper (#230).
 * Run with `node --test "scripts/*.test.mjs"`.
 *
 * The real `tauri icon` re-encodes its source in place; a fake generator that
 * does the same stands in for it here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIcon } from './build-icon.mjs'

const withSource = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'build-icon-'))
  const source = join(dir, 'icon.png')
  writeFileSync(source, Buffer.from('original artwork'))
  try {
    fn(source, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('buildIcon', () => {
  it('restores the source after the generator rewrites it', () => {
    withSource((source, dir) => {
      const status = buildIcon({
        source,
        run: (src) => {
          writeFileSync(src, Buffer.from('re-encoded'))
          writeFileSync(join(dir, '32x32.png'), Buffer.from('generated'))
          return 0
        },
      })
      assert.equal(status, 0)
      assert.equal(readFileSync(source, 'utf8'), 'original artwork')
      // The generated set is left in place.
      assert.equal(readFileSync(join(dir, '32x32.png'), 'utf8'), 'generated')
    })
  })

  it('restores the source and passes on a failing status', () => {
    withSource((source) => {
      const status = buildIcon({
        source,
        run: (src) => {
          writeFileSync(src, Buffer.from('half written'))
          return 3
        },
      })
      assert.equal(status, 3)
      assert.equal(readFileSync(source, 'utf8'), 'original artwork')
    })
  })

  it('restores the source when the generator throws', () => {
    withSource((source) => {
      assert.throws(() =>
        buildIcon({
          source,
          run: (src) => {
            writeFileSync(src, Buffer.from('broken'))
            throw new Error('boom')
          },
        })
      )
      assert.equal(readFileSync(source, 'utf8'), 'original artwork')
    })
  })
})

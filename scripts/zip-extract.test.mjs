import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractZipArchive } from './zip-extract.mjs'

// CI runs the script tests before installing dependencies (dependency-free
// suites), so skip, rather than fail, where unzipper or Python is missing.
// `yarn test:scripts` after an install runs them.
const hasUnzipper = await import('unzipper').then(
  () => true,
  () => false
)
const python = ['python3', 'python'].find((bin) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
const skip = !hasUnzipper
  ? 'unzipper is not installed'
  : !python
    ? 'Python is not available'
    : false

function makeZip(dir, entries) {
  const script = `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1],'w')
for name,data in json.loads(sys.argv[2]).items(): z.writestr(name,data)
z.close()`
  const file = path.join(dir, 'a.zip')
  execFileSync(python, ['-c', script, file, JSON.stringify(entries)])
  return file
}

test('extracts nested files from the validated directory', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-'))
  try {
    const zip = makeZip(dir, { 'a/b.txt': 'hi', 'c.txt': 'yo' })
    const out = path.join(dir, 'out')
    fs.mkdirSync(out)
    await extractZipArchive(zip, out)
    assert.equal(fs.readFileSync(path.join(out, 'a', 'b.txt'), 'utf8'), 'hi')
    assert.equal(fs.readFileSync(path.join(out, 'c.txt'), 'utf8'), 'yo')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses an entry that climbs out of the target', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-'))
  try {
    const zip = makeZip(dir, { '../evil.txt': 'x' })
    const out = path.join(dir, 'out')
    fs.mkdirSync(out)
    await assert.rejects(extractZipArchive(zip, out), /Unsafe/)
    assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

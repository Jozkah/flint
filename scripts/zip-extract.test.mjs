import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractZipArchive } from './zip-extract.mjs'

function makeZip(dir, entries) {
  const script = `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1],'w')
for name,data in json.loads(sys.argv[2]).items(): z.writestr(name,data)
z.close()`
  const file = path.join(dir, 'a.zip')
  execFileSync('python', ['-c', script, file, JSON.stringify(entries)])
  return file
}

test('extracts nested files from the validated directory', async () => {
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

test('refuses an entry that climbs out of the target', async () => {
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

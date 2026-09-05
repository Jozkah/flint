import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSensitiveName,
  looksBinary,
  readFileAsText,
  stripBom,
} from '@/lib/fileSafety'

const NUL = '\u0000'
const REPLACEMENT = '\uFFFD'
const BOM = '\uFEFF'

/**
 * A `File` whose bytes are exactly what the test says.
 *
 * jsdom's `File` has no `text()`, so it is supplied here with the same
 * behaviour a browser gives: a UTF-8 decode that substitutes U+FFFD for
 * undecodable bytes rather than throwing. That substitution is precisely what
 * `looksBinary` exists to notice, so faking it away would void the test.
 */
const fileOf = (name: string, bytes: Uint8Array | string): File => {
  const file = new File([bytes as BlobPart], name)
  const decoded =
    typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  Object.defineProperty(file, 'text', { value: async () => decoded })
  return file
}

describe('isSensitiveName', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.npmrc',
    '.netrc',
    '.pgpass',
    'credentials',
    'credentials.json',
    'service-account.json',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'id_ecdsa',
    'server.pem',
    'private.key',
    'bundle.p12',
    'cert.pfx',
    'debug.keystore',
    'release.jks',
    'sig.asc',
    'secrets.gpg',
    'vault.kdbx',
  ])('refuses %s', (name) => {
    expect(isSensitiveName(name)).toBe(true)
  })

  it.each([
    'index.ts',
    'README.md',
    'environment.ts',
    'keyboard.tsx',
    'package.json',
    '.env-example.md',
  ])('allows %s', (name) => {
    expect(isSensitiveName(name)).toBe(false)
  })

  it('ignores case, as the backend does', () => {
    expect(isSensitiveName('.ENV')).toBe(true)
    expect(isSensitiveName('Server.PEM')).toBe(true)
    expect(isSensitiveName('ID_RSA')).toBe(true)
  })

  it('judges the base name, not the directory it came from', () => {
    expect(isSensitiveName('.env/notes.txt')).toBe(false)
    expect(isSensitiveName('config/.env')).toBe(true)
    expect(isSensitiveName('config\\.env')).toBe(true)
  })
})

describe('parity with the backend rule', () => {
  // The two lists guard different doors and are deliberately not shared, so
  // this reads the Rust source and fails if one side gains a rule the other
  // never got.
  const rust = readFileSync(
    resolve(
      __dirname,
      '../../../../src-tauri/plugins/tauri-plugin-agent-tools/src/project_browse.rs'
    ),
    'utf8'
  )
  const body = rust.slice(
    rust.indexOf('pub fn is_sensitive_name'),
    rust.indexOf('fn canonical_root')
  )

  it('found the backend function to compare against', () => {
    expect(body).toContain('lower.starts_with("id_rsa")')
  })

  it('agrees on every literal the backend names', () => {
    for (const literal of body.match(/"([^"]+)"/g) ?? []) {
      const value = literal.slice(1, -1)
      // A literal is either a whole name (`.env`, `credentials.json`) or a
      // fragment the backend matches as a suffix (`.pem`) or prefix
      // (`id_rsa`). Covered means either reading of it is refused.
      const covered = isSensitiveName(value) || isSensitiveName(`file${value}`)
      expect({ value, sensitive: covered }).toEqual({
        value,
        sensitive: true,
      })
    }
  })
})

describe('looksBinary', () => {
  it('accepts ordinary text, including empty files', () => {
    expect(looksBinary('')).toBe(false)
    expect(looksBinary('hello\nworld\r\n')).toBe(false)
    expect(looksBinary('emoji and accents are text')).toBe(false)
  })

  it('rejects anything holding a NUL', () => {
    expect(looksBinary(`some text${NUL}more`)).toBe(true)
  })

  it('rejects a decode that was mostly guesswork', () => {
    expect(looksBinary(REPLACEMENT.repeat(50) + 'ok')).toBe(true)
  })

  it('tolerates a stray replacement character in real text', () => {
    expect(
      looksBinary(`a long line of ordinary prose ${REPLACEMENT} and more`)
    ).toBe(false)
  })
})

describe('stripBom', () => {
  it('removes a leading BOM and nothing else', () => {
    expect(stripBom(`${BOM}const a = 1`)).toBe('const a = 1')
    expect(stripBom('const a = 1')).toBe('const a = 1')
    expect(stripBom(`a${BOM}b`)).toBe(`a${BOM}b`)
  })
})

describe('readFileAsText', () => {
  it('reads a plain text file', async () => {
    await expect(readFileAsText(fileOf('notes.txt', 'hello'))).resolves.toEqual(
      {
        ok: true,
        text: 'hello',
      }
    )
  })

  it('strips a BOM so the first line is usable', async () => {
    const read = await readFileAsText(fileOf('a.csv', `${BOM}id,name`))
    expect(read).toEqual({ ok: true, text: 'id,name' })
  })

  it('keeps CRLF rather than rewriting the file', async () => {
    const read = await readFileAsText(fileOf('a.txt', 'one\r\ntwo'))
    expect(read).toEqual({ ok: true, text: 'one\r\ntwo' })
  })

  it('accepts an extensionless text file', async () => {
    const read = await readFileAsText(fileOf('Makefile', 'all:\n\techo hi'))
    expect(read).toEqual({ ok: true, text: 'all:\n\techo hi' })
  })

  it('refuses credentials before reading a byte', async () => {
    await expect(
      readFileAsText(fileOf('.env', 'TOKEN=hunter2'))
    ).resolves.toEqual({ ok: false, reason: 'sensitive' })
  })

  it('refuses a binary renamed to a text extension', async () => {
    // A PNG header: exactly the "extension beats MIME" case.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await expect(readFileAsText(fileOf('image.txt', png))).resolves.toEqual({
      ok: false,
      reason: 'binary',
    })
  })

  it('handles an empty file without throwing', async () => {
    await expect(readFileAsText(fileOf('empty.txt', ''))).resolves.toEqual({
      ok: true,
      text: '',
    })
  })
})

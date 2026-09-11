import { describe, it, expect } from 'vitest'
import {
  REDACTED,
  bashExitCode,
  bashSignalled,
  boundTail,
  redactSecrets,
} from '@/lib/redact'

describe('redactSecrets', () => {
  it('redacts KEY=value when the key names a secret', () => {
    expect(redactSecrets('PGPASSWORD=hunter2 psql -h db')).toBe(
      `PGPASSWORD=${REDACTED} psql -h db`
    )
    expect(redactSecrets('--api-key=abc123 run')).toBe(
      `--api-key=${REDACTED} run`
    )
    expect(redactSecrets('export GITHUB_TOKEN=x; make')).toBe(
      `export GITHUB_TOKEN=${REDACTED} make`
    )
  })

  it('redacts the credential after an auth scheme', () => {
    const out = redactSecrets(
      'curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com'
    )
    expect(out).not.toContain('abc.def.ghi')
    expect(out).toContain('https://api.example.com')
  })

  it('redacts well-known token prefixes and long mixed tokens', () => {
    expect(redactSecrets('key sk-proj1234567890abcdef')).toBe(
      `key ${REDACTED}`
    )
    expect(redactSecrets('ghp_ABCdef0123456789ABCdef0123456789ab')).toBe(
      REDACTED
    )
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP')).toBe(REDACTED)
    expect(redactSecrets('Zq8LmN3pQ7rS2tU9vW4xY1zA6bC5dE0fGh')).toBe(REDACTED)
  })

  it('leaves ordinary commands, paths and hashes alone', () => {
    for (const text of [
      'npm run build -- --watch',
      'cat src/components/VeryLongComponentNameForTesting.tsx',
      'git log 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'password prompt appeared',
      'KEY= empty',
    ]) {
      expect(redactSecrets(text)).toBe(text)
    }
  })

  it('keeps whitespace and line structure', () => {
    expect(redactSecrets('a\n  TOKEN=1\tb')).toBe(`a\n  TOKEN=${REDACTED}\tb`)
  })
})

describe('boundTail', () => {
  it('keeps the end of a long output and says it dropped the rest', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const { text: kept, truncated } = boundTail(text, 10_000, 3)
    expect(truncated).toBe(true)
    expect(kept).toBe('line 7\nline 8\nline 9')
  })

  it('bounds by characters too, keeping the final diagnostic', () => {
    const { text: kept, truncated } = boundTail(
      'x'.repeat(100) + '\n[exit 2]',
      20,
      1000
    )
    expect(truncated).toBe(true)
    expect(kept.endsWith('[exit 2]')).toBe(true)
    expect(kept.length).toBe(20)
  })

  it('reports nothing dropped for a short output', () => {
    expect(boundTail('ok', 10, 10)).toEqual({ text: 'ok', truncated: false })
  })
})

describe('bash result markers', () => {
  it('reads the last exit marker', () => {
    expect(bashExitCode('out\n[exit 0]')).toBe(0)
    expect(bashExitCode('a [exit 9] inline\nmore\n[exit 3]\n')).toBe(3)
    expect(bashExitCode('no marker')).toBeUndefined()
    expect(bashExitCode(undefined)).toBeUndefined()
  })

  it('recognises a signal termination', () => {
    expect(bashSignalled('x\n[terminated by signal]')).toBe(true)
    expect(bashSignalled('x\n[exit 1]')).toBe(false)
  })
})

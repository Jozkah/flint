import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  containsSecret,
  redactCommandLine,
  redactSecrets,
  redactSecretsDeep,
  scanSecrets,
} from '../secretRedaction'

/**
 * The shared corpus is the contract between this detector and the Rust one in
 * `src-tauri/harness/src/secrets.rs`. Both suites read this file, so a case added
 * to it fails in both until both handle it -- which is the only thing that keeps
 * two implementations of the same rules honest.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const CORPUS = JSON.parse(
  readFileSync(resolve(HERE, '../../../../docs/security/secret-corpus.json'), 'utf8')
) as {
  positive: { text: string; secret: string; kind: string; note?: string }[]
  negative: { text: string; note?: string }[]
}

describe('the shared credential corpus', () => {
  it('has cases on both sides, and does not shrink silently', () => {
    expect(CORPUS.positive.length).toBeGreaterThanOrEqual(15)
    expect(CORPUS.negative.length).toBeGreaterThanOrEqual(15)
  })

  it.each(CORPUS.positive)('detects $kind in $text', ({ text, secret, kind }) => {
    const findings = scanSecrets(text)
    expect(findings.length, `nothing detected in ${text}`).toBeGreaterThan(0)
    expect(findings.map((f) => f.kind)).toContain(kind)
    expect(redactSecrets(text)).not.toContain(secret)
  })

  it.each(CORPUS.negative)('reports nothing for $text', ({ text }) => {
    expect(scanSecrets(text)).toEqual([])
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('redaction behaviour', () => {
  it('keeps everything that is not a credential byte for byte', () => {
    const text = 'git status --porcelain\nfn main() {}\nsha=9fceb02d\n'
    expect(redactSecrets(text)).toBe(text)
  })

  it('is idempotent, so a second pass over stored text changes nothing', () => {
    const once = redactSecrets('API_KEY=aabbccddeeff00112233')
    expect(redactSecrets(once)).toBe(once)
  })

  it('never produces overlapping spans, even where two rules match', () => {
    const text = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'
    const findings = scanSecrets(text)
    for (let i = 1; i < findings.length; i += 1) {
      expect(findings[i - 1].end).toBeLessThanOrEqual(findings[i].start)
    }
    expect(redactSecrets(text)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('reports the line a finding is on', () => {
    const findings = scanSecrets('clean\nclean\nAPI_KEY=aabbccddeeff00112233\n')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
  })

  it('slices on character boundaries in multibyte text', () => {
    const out = redactSecrets('コメント API_KEY=aabbccddeeff00112233 終わり')
    expect(out.startsWith('コメント ')).toBe(true)
    expect(out.endsWith(' 終わり')).toBe(true)
    expect(out).not.toContain('aabbccddeeff00112233')
  })

  it('answers the yes/no question without a scan at the call site', () => {
    expect(containsSecret('API_KEY=aabbccddeeff00112233')).toBe(true)
    expect(containsSecret('max_tokens=4096')).toBe(false)
  })
})

describe('structured values', () => {
  it('redacts every string in an object and leaves the keys alone', () => {
    const input = {
      path: 'deploy/.env',
      content: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      nested: { api_key: ['sk-abcdefghijklmnopqrstuvwxyz012345'], count: 3 },
      ok: true,
    }
    const out = redactSecretsDeep(input)
    expect(Object.keys(out)).toEqual(['path', 'content', 'nested', 'ok'])
    expect(out.path).toBe('deploy/.env')
    expect(out.content).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out.nested.api_key[0]).not.toContain('sk-abcdefghij')
    expect(out.nested.count).toBe(3)
    expect(out.ok).toBe(true)
  })

  it('leaves a value with nothing secret in it structurally identical', () => {
    const input = { command: 'cargo test', max_tokens: 4096, args: ['-p', 'x'] }
    expect(redactSecretsDeep(input)).toEqual(input)
  })
})

describe('command lines', () => {
  it('takes the value of a secret-named flag', () => {
    const out = redactCommandLine('curl -X POST --token abcdef1234567890 https://example.com')
    expect(out).not.toContain('abcdef1234567890')
    expect(out).toContain('--token [redacted: secret]')
    expect(out).toContain('https://example.com')
  })

  it('leaves an ordinary flag and its value alone', () => {
    const command = 'cargo test -p jan-agent-harness --max-tokens 4096'
    expect(redactCommandLine(command)).toBe(command)
  })
})

import { describe, it, expect } from 'vitest'
import { REDACTED, redactSecrets } from '@/lib/redact'
import corpus from './fixtures/secretCorpus.json'

describe('redactSecrets corpus', () => {
  it.each(corpus.redact)('redacts $input', ({ input, absent }) => {
    const out = redactSecrets(input)
    expect(out).toContain(REDACTED)
    for (const secret of absent) expect(out).not.toContain(secret)
    expect(redactSecrets(out)).toBe(out)
  })

  it.each(corpus.unchanged)('leaves %s alone', (input) => {
    expect(redactSecrets(input)).toBe(input)
  })
})

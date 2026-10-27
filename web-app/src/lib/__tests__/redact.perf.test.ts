import { describe, it, expect } from 'vitest'
import { REDACTED, redactSecrets } from '@/lib/redact'

describe('redactSecrets performance', () => {
  it('handles a 90,000-character single word in linear time', () => {
    const word = 'a'.repeat(90_000)
    const start = performance.now()
    redactSecrets(word)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('still redacts a quoted secret value after a closing quote', () => {
    expect(redactSecrets('a="x" password="hunter2"')).toContain(
      `password=${REDACTED}`
    )
    expect(redactSecrets('x.password="hunter2"')).not.toContain('hunter2')
  })
})

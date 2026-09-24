import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #155: the docs "Is ChatGPT down?" widget reached OpenAI's status only through
 * free public CORS proxies (one of them dead) and, when they failed, showed a
 * hardcoded "operational". The docs site has no test runner, so the component
 * is checked as text. Paths are resolved from this file.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const source = readFileSync(
  resolve(HERE, '../../../docs/src/components/OpenAIStatusChecker.tsx'),
  'utf8'
)

describe('OpenAIStatusChecker', () => {
  it('uses no third-party CORS proxy', () => {
    expect(source).not.toContain('allorigins')
    expect(source).not.toContain('cors-anywhere')
  })

  it('fetches the status page API directly', () => {
    expect(source).toContain(
      "OPENAI_STATUS_URL = 'https://status.openai.com/api/v2/status.json'"
    )
    expect(source).toContain('fetch(OPENAI_STATUS_URL)')
  })

  it('never reports "operational" without live data', () => {
    expect(source).not.toMatch(/status:\s*'operational'/)
    expect(source).not.toContain("|| 'operational'")
  })
})

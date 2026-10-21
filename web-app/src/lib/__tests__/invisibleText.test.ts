import { describe, expect, it } from 'vitest'
import { stripInvisible } from '../invisibleText'
import cases from '../../../../src-tauri/plugins/tauri-plugin-agent-tools/tests/fixtures/invisible-unicode.json'

type Case = { name: string; input: string; expected: string }

describe('stripInvisible', () => {
  it('strips exactly what the Rust helper strips (shared fixture)', () => {
    expect((cases as Case[]).length).toBeGreaterThanOrEqual(10)
    for (const c of cases as Case[]) {
      const { text, removed } = stripInvisible(c.input)
      expect(text, c.name).toBe(c.expected)
      expect(removed, c.name).toBe(
        Array.from(c.input).length - Array.from(c.expected).length
      )
    }
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BROWSER_TOOL_NAMES } from '@/lib/browserAgent'

/**
 * The Rust loop (CLI, durable jobs) registers the same browser tool names so it
 * can answer them with "needs the desktop app". The two lists must not drift.
 */
describe('browser tool names', () => {
  it('match the Rust registry', () => {
    const src = readFileSync(
      resolve(
        __dirname,
        '../../../../src-tauri/plugins/tauri-plugin-agent-tools/src/tools/mod.rs'
      ),
      'utf8'
    )
    const block = /pub const BROWSER_TOOL_NAMES: &\[&str\] = &\[([^\]]*)\]/.exec(
      src
    )
    expect(block).not.toBeNull()
    const rust = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
    expect(rust).toEqual([...BROWSER_TOOL_NAMES].sort())
  })
})

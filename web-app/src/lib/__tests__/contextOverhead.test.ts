import { describe, expect, it, vi } from 'vitest'

vi.mock('@janhq/tauri-plugin-websearch-api', () => ({
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imageSearch: vi.fn(),
}))

import { estimateToolTokens } from '@/lib/context-manager'
import {
  IMAGE_SEARCH_DESCRIPTION,
  IMAGE_SEARCH_INPUT_SCHEMA,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_INPUT_SCHEMA,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_INPUT_SCHEMA,
} from '@/lib/webSearchTool'
import { visualizeSchemas } from '@/lib/visualize/tools'

/**
 * What a clean chat (no MCP, no Agent tools) carries on every request from the
 * web layer: the native web tools and the two widget tools. Static, so it needs
 * no data folder. Run with `yarn vitest run contextOverhead` for the figures;
 * the Rust-side tools are measured by `context_cost_report` in
 * tauri-plugin-agent-tools (`cargo test --no-default-features context_cost_report -- --nocapture`).
 */
describe('fixed context overhead of a clean chat', () => {
  const rows: Array<[string, number]> = [
    ['web_search', estimateToolTokens('web_search', { description: WEB_SEARCH_DESCRIPTION, inputSchema: WEB_SEARCH_INPUT_SCHEMA })],
    ['web_fetch', estimateToolTokens('web_fetch', { description: WEB_FETCH_DESCRIPTION, inputSchema: WEB_FETCH_INPUT_SCHEMA })],
    ['image_search', estimateToolTokens('image_search', { description: IMAGE_SEARCH_DESCRIPTION, inputSchema: IMAGE_SEARCH_INPUT_SCHEMA })],
    ...visualizeSchemas().map((s): [string, number] => [
      s.function.name,
      estimateToolTokens(s.function.name, s.function),
    ]),
  ]

  it('stays within budget', () => {
    const total = rows.reduce((n, r) => n + r[1], 0)
    console.log(
      rows.map(([n, t]) => `${String(t).padStart(6)}  ${n}`).join('\n') +
        `\n${String(total).padStart(6)}  TOTAL (web-layer tools)`
    )
    expect(total).toBeLessThan(2500)
  })
})

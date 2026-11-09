import { describe, it, expect } from 'vitest'

// English stays bundled and parsed before the first render on purpose: it is
// the fallback every `t()` call reads synchronously, so loading namespaces on
// demand would render raw keys until they arrive (every screen would need a
// loading state). Measured 2026-11: 39 files, ~560 KB, about 4 ms to parse
// cold and ~1 ms warm in V8, and Vite 6 already emits large JSON as
// `JSON.parse(...)`. That is cheap enough to keep, but only while it stays
// that size, so this budget fails when the English strings grow past it and
// the trade-off has to be looked at again (split per route, or lazy load the
// rarely used namespaces).
const BUDGET_BYTES = 650 * 1024

const english = import.meta.glob('../../locales/en/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('bundled English strings', () => {
  it('stay within the startup parse budget', () => {
    const files = Object.keys(english)
    expect(files.length).toBeGreaterThan(30)
    const bytes = Object.values(english).reduce(
      (sum, text) => sum + new TextEncoder().encode(text).length,
      0
    )
    expect(bytes, `English locale is ${bytes} bytes over ${files.length} files`).toBeLessThanOrEqual(
      BUDGET_BYTES
    )
  })

  it('parse well inside a frame', () => {
    const started = performance.now()
    for (const text of Object.values(english)) JSON.parse(text)
    // Generous for a slow CI machine; a regression to an eager parse of many
    // megabytes would blow through it.
    expect(performance.now() - started).toBeLessThan(250)
  })
})

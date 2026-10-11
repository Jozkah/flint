import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../..', rel), 'utf8')

/** Module specifiers a file imports statically (not `import()` calls). */
const staticImports = (code: string) =>
  [...code.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('a "New window" does not load the main window shell', () => {
  it('has a solo root that imports none of the shell or one-time providers', () => {
    const imports = staticImports(src('components/solo/SoloRoot.tsx'))
    const heavy = [
      '@/components/shell/AppSidebar',
      '@/components/shell/TopHeader',
      '@/providers/KeyboardShortcuts',
      '@/providers/GlobalEventHandler',
      '@/providers/UsageActivityRecorder',
      '@/containers/CommandPalette',
      '@/containers/dialogs/SearchDialog',
      '@/containers/MigrationAssistant',
      '@/shell/MainRoot',
    ]
    for (const mod of heavy) expect(imports).not.toContain(mod)
  })

  it('keeps both roots behind dynamic imports in the route root', () => {
    const code = src('routes/__root.tsx')
    const imports = staticImports(code)
    expect(imports).not.toContain('@/shell/MainRoot')
    expect(imports).not.toContain('@/components/solo/SoloRoot')
    expect(code).toMatch(/import\('@\/shell\/MainRoot'\)/)
    expect(code).toMatch(/import\('@\/components\/solo\/SoloRoot'\)/)
  })

  it('keeps the shell out of the window entry', () => {
    const imports = staticImports(src('main.tsx'))
    expect(imports.some((m) => /shell|AppSidebar|TopHeader/.test(m))).toBe(false)
  })
})

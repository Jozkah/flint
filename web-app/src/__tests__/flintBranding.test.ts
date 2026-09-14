import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const EN = resolve(HERE, '../locales/en')
const REPO = resolve(HERE, '../../..')

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

const intentionalLegacyReference = (text: string) =>
  /(?:\.jan(?:\/|\b)|JAN\.md|existing JAN|from JAN|JAN installation|JAN data)/.test(text)

describe('Flint branding', () => {
  it('never presents the current product as JAN in English UI copy', () => {
    const stale: string[] = []
    for (const name of readdirSync(EN).filter((file) => file.endsWith('.json'))) {
      const values = strings(JSON.parse(readFileSync(join(EN, name), 'utf8')))
      for (const text of values) {
        if (/\bJAN(?:'s)?\b/.test(text) && !intentionalLegacyReference(text)) {
          stale.push(`${name}: ${text}`)
        }
      }
    }
    expect(stale).toEqual([])
  })

  it('has no known stale Jan product phrases in runtime surfaces', () => {
    const files = [
      'web-app/src/containers/CoworkProjectInit.tsx',
      'web-app/src/containers/GlobalError.tsx',
      'web-app/src/containers/MessageItem.tsx',
      'web-app/src/containers/ThreadConversation.tsx',
      'web-app/src/lib/agentTools.ts',
      'web-app/src/lib/agentWorkspace.ts',
      'web-app/src/lib/sessionBundle.ts',
      'web-app/src/lib/sessionMailbox.ts',
      'web-app/src/lib/skillStore.ts',
      'web-app/src/lib/rooms/availability.ts',
      'web-app/src/lib/rooms/participantModel.ts',
      'web-app/src/lib/rooms/recovery.ts',
      'web-app/src/lib/backendDependencies.ts',
      'web-app/src/lib/claudeCompatMcp.ts',
      'web-app/src/lib/coworkInflight.ts',
      'web-app/src/services/core/bundled-extensions.ts',
      'web-app/src/services/window/tauri.ts',
      'src-tauri/src/core/setup.rs',
      'src-tauri/src/core/system/commands.rs',
      'src-tauri/src/core/server/proxy.rs',
      'src-tauri/static/openapi.json',
      'src-tauri/src/core/agent/lsp.rs',
    ]
    const stalePhrases = [
      'Open Jan',
      'JAN hit',
      '>JAN<',
      'Jan read',
      'Jan restarted',
      'configured in Jan',
      'version of Jan',
      'Jan data folder is unavailable',
      'Jan session export',
      'previous Jan process',
      'Jan API server',
      'so Jan cannot',
      'from Jan settings',
      'Jan can represent',
      'Note from Jan',
      "productName: 'Jan Assistant'",
      ' - Jan',
      '"name": "Jan"',
    ]
    const stale = files.flatMap((file) => {
      const text = readFileSync(join(REPO, file), 'utf8')
      return stalePhrases.filter((phrase) => text.includes(phrase)).map((phrase) => `${file}: ${phrase}`)
    })
    expect(stale).toEqual([])
  })

  it('uses the canonical Flint artwork for every legacy product-logo source', () => {
    const digest = (file: string) =>
      createHash('sha256').update(readFileSync(join(REPO, file))).digest('hex')
    const canonical = digest('src-tauri/icons/icon.png')
    for (const file of [
      '.github/scripts/icon-beta.png',
      '.github/scripts/icon-nightly.png',
      'web-app/public/images/model-provider/jan.png',
    ]) {
      expect(digest(file), file).toBe(canonical)
    }
  })

  it('renders product marks from the canonical Flint PNG', () => {
    for (const file of [
      'web-app/src/components/MermaidError.tsx',
      'web-app/src/routes/settings/mcp-servers.tsx',
    ]) {
      const source = readFileSync(join(REPO, file), 'utf8')
      expect(source, file).toContain('/images/flint-logo.png')
      expect(source, file).not.toContain('/images/flint-logo.svg')
    }
  })
})

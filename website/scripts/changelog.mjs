// Reads the repo's CHANGELOG.md at build time so the changelog page never drifts from the source.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(site, '../CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim()

const title = plain((src.match(/^# (.+)$/m) ?? [, 'Changelog'])[1])
const intro = plain(src.split('\n').slice(1).join('\n').split(/\n## /)[0].split('\n\n').find((p) => p.trim() && !p.startsWith('#')) ?? '')
const hl = (src.split(/\n## Highlights\n/)[1] ?? '').split(/\n## /)[0]
const highlights = [...hl.matchAll(/^- \*\*(.+?)\*\*\s*(.+)$/gm)].map((m) => ({ title: plain(m[1]).replace(/\.$/, '').replace(/ and private$/i, ''), text: plain(m[2]) }))
const additions = (src.split(/\n## Final 0\.9\.0 additions\n/)[1] ?? '').split(/\n## /)[0]
const finals = [...additions.matchAll(/^### (.+)$/gm)].map((m) => plain(m[1]))

if (!highlights.length) throw new Error('changelog: no highlights parsed from CHANGELOG.md')
fs.mkdirSync(path.join(site, 'src/generated'), { recursive: true })
fs.writeFileSync(path.join(site, 'src/generated/changelog.json'), JSON.stringify({ title, intro, highlights, finals }, null, 2))
console.log(`changelog: ${title}, ${highlights.length} highlights`)

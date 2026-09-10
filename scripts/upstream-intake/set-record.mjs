/**
 * Record a triage decision against docs/upstream-issues-prs.json.
 *
 * Usage:
 *   node scripts/upstream-intake/set-record.mjs <number> '<json patch>'
 *   node scripts/upstream-intake/set-record.mjs --meta '<json patch>'
 *
 * The patch is merged into the item's triage-owned fields, so the ledger stays
 * the single place a later session has to read to resume.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const queuePath = path.resolve(here, '..', '..', 'docs', 'upstream-issues-prs.json')

const [target, rawPatch] = process.argv.slice(2)
if (!target || !rawPatch) {
  console.error('usage: set-record.mjs <number|--meta> <json patch>')
  process.exit(2)
}

const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'))
const patch = JSON.parse(rawPatch)

if (target === '--meta') {
  Object.assign(queue, patch)
} else {
  const numbers = target.split(',').map((n) => Number(n.trim()))
  for (const number of numbers) {
    const item = queue.items.find((i) => i.number === number)
    if (!item) {
      console.error(`no queue record for #${number}`)
      process.exit(1)
    }
    Object.assign(item, patch)
  }
}

queue.counts.byStatus = queue.items.reduce((acc, i) => {
  acc[i.implementationStatus] = (acc[i.implementationStatus] || 0) + 1
  return acc
}, {})

fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n')
console.log(`updated ${target}`)

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Starter-assistant icons render at 20-72 px. A full-size source image once
 * shipped here at over 10x the needed size, so keep every PNG small.
 */
const DIR = resolve(fileURLToPath(import.meta.url), '../../../public/images/assistants')
const LIMIT = 30 * 1024

describe('starter assistant icons', () => {
  const pngs = readdirSync(DIR).filter((f) => f.endsWith('.png'))

  it('finds the icons', () => {
    expect(pngs.length).toBeGreaterThan(0)
  })

  it.each(pngs)('%s is at most 30 KB', (name) => {
    expect(statSync(join(DIR, name)).size).toBeLessThanOrEqual(LIMIT)
  })
})

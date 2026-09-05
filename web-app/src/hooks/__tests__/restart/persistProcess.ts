import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { StateStorage } from 'zustand/middleware'

/**
 * The persisted blob, on disk, shared between two processes.
 *
 * The restart claim — that MCP consent and direct-edit authority do not come
 * back — cannot be proved by clearing a store inside one process: that tests
 * the clearing, not the restart. So one process writes what Jan would persist,
 * a second process starts fresh and reads it, and the assertions are about
 * what the second process finds.
 */
export const storeFile = (): string => {
  const path = process.env.JAN_RESTART_FIXTURE
  if (!path) throw new Error('JAN_RESTART_FIXTURE must name the shared file')
  return path
}

/** A storage backed by that file, standing in for Jan's settings store. */
export const fileStorage: StateStorage = {
  getItem: (name) => {
    const path = storeFile()
    if (!existsSync(path)) return null
    const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    return all[name] ?? null
  },
  setItem: (name, value) => {
    const path = storeFile()
    const all = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
      : {}
    all[name] = value
    writeFileSync(path, JSON.stringify(all))
  },
  removeItem: (name) => {
    const path = storeFile()
    if (!existsSync(path)) return
    const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    delete all[name]
    writeFileSync(path, JSON.stringify(all))
  },
}

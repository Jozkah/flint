/**
 * Names for references, reusable across turns and sessions. AH-205.
 *
 * An alias is a name for a path inside one attached folder: `@alias:spec`
 * instead of `@docs/specs/2026/api.md`. Only the relative path is stored, and
 * it is resolved again every time the alias is used -- through the same
 * confined reader as a typed reference -- so an alias that has come to point
 * outside the folder (a symlink swapped underneath it) is refused at use time,
 * and one whose file has gone reports the path it can no longer find rather
 * than resolving to nothing.
 *
 * Aliases belong to a folder: the same name in two projects is two aliases.
 * Persisted through the backend settings store, so they survive a restart.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  normalizeReference,
  resolveExcerpt,
  resolveReference,
} from '@/lib/safeReferences'
import { lineRangeOf } from '@/lib/path-references'

export type ReferenceAlias = {
  name: string
  /**
   * Relative to the folder the alias belongs to. Never absolute. A selection
   * carries its lines: `src/a.ts:12-20`.
   */
  target: string
  createdAt: number
}

/** `12` or `12-20`: which lines of a file a selection names. */
export function parseLines(
  lines: string
): { start: number; end: number } | null {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(lines)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  return start >= 1 && end >= start ? { start, end } : null
}

/** What an alias may be called: one token that `@alias:` can carry. */
export const ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export type AliasRefusal = 'no-folder' | 'name' | 'target' | 'taken' | 'unknown'

export type AliasResult =
  | { ok: true; alias: ReferenceAlias }
  | { ok: false; reason: AliasRefusal; message: string }

/**
 * One key per folder, however the path was spelled: separators unified, no
 * trailing slash, and a Windows drive path compared without case.
 */
export function folderKey(root: string): string {
  const unified = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified
}

type AliasState = {
  byFolder: Record<string, Record<string, ReferenceAlias>>
  /** The folder's aliases, by name. */
  list: (root: string | null | undefined) => ReferenceAlias[]
  add: (
    root: string | null | undefined,
    name: string,
    target: string,
    /** Name a selection rather than the whole file: `12` or `12-20`. */
    lines?: string
  ) => AliasResult
  remove: (root: string | null | undefined, name: string) => AliasResult
}

export const useReferenceAliases = create<AliasState>()(
  persist(
    (set, get) => ({
      byFolder: {},
      list: (root) => {
        if (!root) return []
        const found = get().byFolder[folderKey(root)] ?? {}
        return Object.values(found).sort((a, b) => a.name.localeCompare(b.name))
      },
      add: (root, rawName, rawTarget, rawLines) => {
        if (!root) {
          return {
            ok: false,
            reason: 'no-folder',
            message: 'no folder is attached, so there is nothing to name',
          }
        }
        const name = rawName.trim()
        if (!ALIAS_NAME.test(name)) {
          return {
            ok: false,
            reason: 'name',
            message:
              'an alias name is letters, digits, dot, dash or underscore, starting with a letter or digit',
          }
        }
        const target = normalizeReference(rawTarget)
        if (!target.ok) {
          return {
            ok: false,
            reason: 'target',
            message: 'an alias can only name a path inside the attached folder',
          }
        }
        let stored = target.rel
        if (rawLines && rawLines.trim()) {
          const range = parseLines(rawLines)
          if (!range) {
            return {
              ok: false,
              reason: 'target',
              message:
                'lines are a number or a range such as 12-20, starting at 1',
            }
          }
          stored = `${target.rel}:${range.start}-${range.end}`
        }
        const key = folderKey(root)
        const existing = get().byFolder[key]?.[name]
        if (existing && existing.target !== stored) {
          return {
            ok: false,
            reason: 'taken',
            message: `@alias:${name} already names ${existing.target}`,
          }
        }
        const alias: ReferenceAlias = {
          name,
          target: stored,
          createdAt: existing?.createdAt ?? Date.now(),
        }
        set((s) => ({
          byFolder: {
            ...s.byFolder,
            [key]: { ...(s.byFolder[key] ?? {}), [name]: alias },
          },
        }))
        return { ok: true, alias }
      },
      remove: (root, name) => {
        const key = root ? folderKey(root) : ''
        const existing = root ? get().byFolder[key]?.[name] : undefined
        if (!root || !existing) {
          return {
            ok: false,
            reason: 'unknown',
            message: `there is no alias named ${name} in this folder`,
          }
        }
        set((s) => {
          const next = { ...(s.byFolder[key] ?? {}) }
          delete next[name]
          return { byFolder: { ...s.byFolder, [key]: next } }
        })
        return { ok: true, alias: existing }
      },
    }),
    {
      name: localStorageKey.referenceAliases,
      storage: createJSONStorage(() => backendStorage),
      partialize: (s) => ({ byFolder: s.byFolder }),
      skipHydration: true,
    }
  )
)

export type ResolvedAlias =
  | { ok: true; alias: ReferenceAlias; content: string }
  | { ok: false; message: string }

/**
 * Read what an alias names, now. Checked at use time, not trusted from when
 * it was saved: the folder's contents may have changed since.
 */
export async function resolveAlias(
  dataFolder: string,
  root: string | null | undefined,
  name: string
): Promise<ResolvedAlias> {
  const alias = root
    ? useReferenceAliases.getState().byFolder[folderKey(root)]?.[name]
    : undefined
  if (!root || !alias) {
    return {
      ok: false,
      message: `there is no alias named ${name} in this folder`,
    }
  }
  // A selection is read as the lines it names, checked against the file as
  // it is now.
  const range = lineRangeOf(alias.target)
  const resolved = range
    ? await resolveExcerpt(
        dataFolder,
        root,
        range.path,
        range.startLine,
        range.endLine
      )
    : await resolveReference(dataFolder, root, alias.target)
  if (!resolved.ok) {
    return {
      ok: false,
      message: `@alias:${name} names ${alias.target}, which could not be used: ${resolved.message}`,
    }
  }
  return {
    ok: true,
    alias,
    content: `(@alias:${name} is ${alias.target})\n${resolved.content}`,
  }
}

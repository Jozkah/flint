/**
 * The prompt library: named, reusable prompt bodies you insert from the `@`
 * menu or the `/` list. Unlike a `@alias` (a name for a file) or a skill (a
 * packaged instruction run by the agent), a library prompt is plain text you
 * own: it is pasted into the composer, edited if you like, and sent as an
 * ordinary message. Nothing is hidden or expanded at send time.
 *
 * A body may hold variables: `{{topic}}`, or `{{tone:friendly}}` with a
 * default. The same name used twice is asked for once. `\{{` writes a literal
 * `{{`. Persisted through the backend settings store like reference aliases.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

export type LibraryPrompt = {
  id: string
  name: string
  body: string
  /** One optional folder name, for grouping in the settings list. */
  folder?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export type PromptVar = { name: string; default?: string }

/** `{{name}}` / `{{name:default}}`, optionally escaped as `\{{`. */
const VAR = /(\\)?\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?::([^}]*))?\}\}/g

/**
 * The variables a body asks for, once each, in order of first use. When a name
 * repeats, the first occurrence that has a default supplies it.
 */
export function parseVars(body: string): PromptVar[] {
  const found = new Map<string, PromptVar>()
  for (const m of body.matchAll(VAR)) {
    if (m[1]) continue // escaped: literal text
    const name = m[2]
    const def = m[3]?.trim()
    const seen = found.get(name)
    if (!seen) found.set(name, def === undefined ? { name } : { name, default: def })
    else if (seen.default === undefined && def !== undefined) seen.default = def
  }
  return [...found.values()]
}

/**
 * The body with every variable replaced: the value given, else the default,
 * else nothing. Escaped `\{{` becomes a literal `{{`. A value is inserted as
 * is -- never itself re-read as a variable.
 */
export function fillPrompt(body: string, values: Record<string, string>): string {
  const defaults = new Map(parseVars(body).map((v) => [v.name, v.default]))
  return body.replace(VAR, (match, esc: string | undefined, name: string) => {
    if (esc) return match.slice(1)
    const given = values[name]
    if (given !== undefined && given !== '') return given
    return defaults.get(name) ?? ''
  })
}

/** Variables with no default whose value is empty: the form asks for these. */
export function missingVars(body: string, values: Record<string, string>): string[] {
  return parseVars(body)
    .filter((v) => v.default === undefined && !(values[v.name] ?? '').trim())
    .map((v) => v.name)
}

export const MAX_PROMPT_NAME = 80
export const MAX_PROMPT_BODY = 20000

export type PromptInput = {
  name: string
  body: string
  folder?: string
  tags?: string[]
}

/** Why a save or import was refused. The card turns it into the user's language. */
export type PromptErrorCode =
  | 'nameRequired'
  | 'nameTooLong'
  | 'bodyRequired'
  | 'bodyTooLong'
  | 'gone'
  | 'invalidJson'
  | 'noPrompts'

export type PromptResult =
  | { ok: true; prompt: LibraryPrompt }
  | { ok: false; code: PromptErrorCode }

const cleanTags = (tags?: string[]) =>
  [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12)

function validate(input: PromptInput): { ok: true; value: PromptInput } | { ok: false; code: PromptErrorCode } {
  const name = input.name.replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, code: 'nameRequired' }
  if (name.length > MAX_PROMPT_NAME) return { ok: false, code: 'nameTooLong' }
  if (!input.body.trim()) return { ok: false, code: 'bodyRequired' }
  if (input.body.length > MAX_PROMPT_BODY) return { ok: false, code: 'bodyTooLong' }
  const folder = input.folder?.replace(/\s+/g, ' ').trim()
  const tags = cleanTags(input.tags)
  return {
    ok: true,
    value: {
      name,
      body: input.body,
      ...(folder ? { folder: folder.slice(0, 60) } : {}),
      ...(tags.length ? { tags } : {}),
    },
  }
}

const newId = () =>
  `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

type PromptState = {
  prompts: LibraryPrompt[]
  add: (input: PromptInput) => PromptResult
  update: (id: string, input: PromptInput) => PromptResult
  remove: (id: string) => void
  /** Put a removed prompt back at its old position (the Undo of a delete). */
  restore: (prompt: LibraryPrompt, index: number) => void
  /** Merge prompts from an exported file. Returns how many were added. */
  importJson: (raw: string) => { ok: true; added: number } | { ok: false; code: PromptErrorCode }
  exportJson: () => string
}

export const usePromptLibrary = create<PromptState>()(
  persist(
    (set, get) => ({
      prompts: [],
      add: (input) => {
        const v = validate(input)
        if (!v.ok) return v
        const now = Date.now()
        const prompt: LibraryPrompt = { id: newId(), ...v.value, createdAt: now, updatedAt: now }
        set((s) => ({ prompts: [...s.prompts, prompt] }))
        return { ok: true, prompt }
      },
      update: (id, input) => {
        const existing = get().prompts.find((p) => p.id === id)
        if (!existing) return { ok: false, code: 'gone' }
        const v = validate(input)
        if (!v.ok) return v
        const prompt: LibraryPrompt = {
          id,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          ...v.value,
        }
        set((s) => ({ prompts: s.prompts.map((p) => (p.id === id ? prompt : p)) }))
        return { ok: true, prompt }
      },
      remove: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),
      restore: (prompt, index) =>
        set((s) => {
          if (s.prompts.some((p) => p.id === prompt.id)) return s
          const next = [...s.prompts]
          next.splice(Math.min(Math.max(index, 0), next.length), 0, prompt)
          return { prompts: next }
        }),
      importJson: (raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { ok: false, code: 'invalidJson' }
        }
        const list = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { prompts?: unknown }).prompts)
            ? (parsed as { prompts: unknown[] }).prompts
            : null
        if (!list) return { ok: false, code: 'noPrompts' }
        const have = new Set(get().prompts.map((p) => `${p.name}\u0000${p.body}`))
        const next: LibraryPrompt[] = []
        const now = Date.now()
        for (const item of list) {
          if (!item || typeof item !== 'object') continue
          const o = item as Record<string, unknown>
          if (typeof o.name !== 'string' || typeof o.body !== 'string') continue
          const v = validate({
            name: o.name,
            body: o.body,
            folder: typeof o.folder === 'string' ? o.folder : undefined,
            tags: Array.isArray(o.tags)
              ? o.tags.filter((t): t is string => typeof t === 'string')
              : undefined,
          })
          if (!v.ok) continue
          const key = `${v.value.name}\u0000${v.value.body}`
          if (have.has(key)) continue
          have.add(key)
          // A fresh id: an imported file never overwrites an existing prompt.
          next.push({ id: newId(), ...v.value, createdAt: now, updatedAt: now })
        }
        if (next.length) set((s) => ({ prompts: [...s.prompts, ...next] }))
        return { ok: true, added: next.length }
      },
      exportJson: () =>
        JSON.stringify(
          {
            version: 1,
            prompts: get().prompts.map(({ name, body, folder, tags }) => ({
              name,
              body,
              ...(folder ? { folder } : {}),
              ...(tags?.length ? { tags } : {}),
            })),
          },
          null,
          2
        ),
    }),
    {
      name: localStorageKey.promptLibrary,
      storage: createJSONStorage(() => backendStorage),
      partialize: (s) => ({ prompts: s.prompts }),
      skipHydration: true,
    }
  )
)

/** Lowercase slug for the `/prompt:<slug>` trigger. */
export function promptSlug(name: string): string {
  // Letters and digits of any script count, so a Japanese or Russian name keeps
  // its own slug. Accents on Latin letters are dropped (Café -> cafe); other scripts keep theirs (й, ё).
  const slug = name
    .normalize('NFD')
    .replace(/([A-Za-z])[̀-ͯ]+/g, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'prompt'
}

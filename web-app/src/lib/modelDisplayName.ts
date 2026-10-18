/**
 * Renaming a model.
 *
 * A model's `id` is what the provider is actually called with, so a rename
 * never touches it: the custom name is stored alongside as `displayName` and
 * the id keeps addressing the API. Everything here decides whether a proposed
 * name is usable; the store is what makes it stick.
 */

import { getModelDisplayName } from '@/lib/utils'

/** Why a proposed name was rejected. Each maps to a message under the field. */
export type DisplayNameError =
  /** Nothing but whitespace: a model with no name at all cannot be picked. */
  | 'empty'
  /** Another model in the same provider already answers to this. */
  | 'duplicate'

export type DisplayNameValidation =
  /**
   * `displayName` is what to store — `undefined` when the user typed the
   * model's own id back in, which means "stop overriding" rather than "call it
   * the same thing twice".
   */
  | { ok: true; displayName: string | undefined }
  | { ok: false; error: DisplayNameError }

/**
 * The name as it will be stored: surrounding space removed and runs of
 * whitespace collapsed, so "gpt   5 " and "gpt 5" cannot both exist and look
 * identical in a list.
 */
export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * Everything the given model may not be renamed to, lowercased.
 *
 * Both halves of every *other* model matter: its current name, because two
 * identically named rows are indistinguishable, and its id, because a name
 * that impersonates another model's real identifier is worse than a duplicate.
 */
export function takenNames(
  models: readonly Model[],
  modelId: string
): Set<string> {
  const taken = new Set<string>()
  for (const other of models) {
    if (other.id === modelId) continue
    taken.add(getModelDisplayName(other).toLowerCase())
    taken.add(other.id.toLowerCase())
  }
  return taken
}

/**
 * Is this rename allowed, and what should be stored for it?
 *
 * `models` is the provider's own list: names only have to be unique within the
 * provider that resolves them, and two providers legitimately offer models of
 * the same name.
 */
export function validateDisplayName(input: {
  raw: string
  modelId: string
  models: readonly Model[]
}): DisplayNameValidation {
  const name = normalizeDisplayName(input.raw)
  if (!name) return { ok: false, error: 'empty' }

  // Typing the id back in is how a model goes back to its own name.
  if (name === input.modelId) return { ok: true, displayName: undefined }

  if (takenNames(input.models, input.modelId).has(name.toLowerCase())) {
    return { ok: false, error: 'duplicate' }
  }

  return { ok: true, displayName: name }
}

/**
 * Reading a model's quantization off its name.
 *
 * Two files of the same model differ only in their tail (`…-IQ4_XS` against
 * `…-Q4_K_M`), which is exactly the part a name cut at the end loses.
 */
const QUANT_RE =
  /(?:^|[-_.\s])((?:UD-)?(?:IQ\d(?:_[A-Z]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|MXFP4|NVFP4))(?=$|[-_.\s])/i

export type ParsedModelName = {
  /** The name without the quantization (and the `.gguf` extension). */
  base: string
  /** `IQ4_XS`, `Q4_K_M`, `BF16`…, or undefined when none is recognised. */
  quant?: string
}

/** Split `Qwen3.6-27B-IQ4_XS.gguf` into its base name and quantization. */
export function parseModelName(raw: string): ParsedModelName {
  const name = raw.replace(/\.gguf$/i, '')
  // The last match wins: a quant sits at the tail, a size like `Q8` earlier
  // in a name should not.
  let found: RegExpExecArray | undefined
  const re = new RegExp(QUANT_RE.source, 'gi')
  for (let m = re.exec(name); m; m = re.exec(name)) {
    found = m
    re.lastIndex = m.index + m[0].length - 1
  }
  if (!found) return { base: name }
  const quant = found[1].toUpperCase()
  const start = found.index + found[0].indexOf(found[1])
  const base = (name.slice(0, start) + name.slice(start + found[1].length))
    .replace(/[-_.\s]+$/, '')
    .replace(/[-_.\s]{2,}/g, '-')
  return { base: base || name, quant }
}

/**
 * Shorten `text` to at most `max` characters by cutting out the middle, so the
 * start (which model) and the end (which quant, which extension) both stay.
 */
export function middleTruncate(text: string, max: number, tail = 0): string {
  if (max < 5 || text.length <= max) return text
  const keepTail = Math.min(
    Math.max(tail, Math.ceil((max - 1) * 0.4)),
    max - 2
  )
  const keepHead = max - 1 - keepTail
  return `${text.slice(0, keepHead).trimEnd()}…${text.slice(text.length - keepTail)}`
}

/**
 * Middle-truncate a list of names so no two entries look the same. Names that
 * still collide at `max` keep more of their tail until they differ.
 */
export function truncateDistinct(names: readonly string[], max: number) {
  const out = names.map((n) => middleTruncate(n, max))
  for (let extra = 1; extra <= 8; extra++) {
    const seen = new Map<string, number[]>()
    out.forEach((v, i) => seen.set(v, [...(seen.get(v) ?? []), i]))
    let changed = false
    for (const idxs of seen.values()) {
      if (idxs.length < 2) continue
      if (new Set(idxs.map((i) => names[i])).size < 2) continue
      for (const i of idxs) {
        out[i] = middleTruncate(
          names[i],
          max,
          Math.ceil((max - 1) * 0.4) + extra * 4
        )
      }
      changed = true
    }
    if (!changed) break
  }
  return out
}

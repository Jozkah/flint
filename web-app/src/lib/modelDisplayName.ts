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

/** What one model needs to be told apart from its look-alikes. */
export type DisambiguationInput = {
  /** Stable key the result is returned under (the model id). */
  key: string
  /** The name on screen (a custom name, else the id). */
  name: string
  /** The file it comes from, when known; read for the differing segments. */
  fileName?: string
  sizeBytes?: number
  contextLength?: number
}

export type Disambiguation = {
  label: string
  /** What the label was read from; a `quant` label repeats the quant chip. */
  kind: 'quant' | 'segment' | 'size' | 'context' | 'index'
}

/** Longest distinguishing label; longer ones are cut in the middle. */
export const DISAMBIGUATION_MAX = 18

/** How much of a name a narrow list still shows before it cuts it. */
const VISIBLE_PREFIX = 17

const sizeLabel = (bytes: number) => {
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

const contextText = (n: number) =>
  `${n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : n} ctx`

/** Is every value present and no two equal? */
const allDistinct = (values: (string | undefined)[]): values is string[] =>
  values.every((v) => !!v) && new Set(values).size === values.length

/**
 * Short labels for models that would be hard to tell apart in a list.
 *
 * Models collide when their names (quantization removed) are identical or
 * agree on the first characters a narrow list shows. Each colliding model gets
 * the smallest thing that differs, in this order: its quant, the file-name
 * segments left after the siblings' shared head and tail, its size, its
 * context length, and finally its place (`#2`). Text is only ever read from the
 * file name, size or context; unique names get nothing. The result does not
 * depend on the order of `models`.
 */
export function disambiguateModels(
  models: readonly DisambiguationInput[]
): Map<string, Disambiguation> {
  const out = new Map<string, Disambiguation>()
  const items = [...models]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((m) => {
      const parsedName = parseModelName(m.name)
      const full = (m.fileName ?? m.name).replace(/\.gguf$/i, '')
      const quant = parsedName.quant ?? parseModelName(m.fileName ?? '').quant
      const lower = parsedName.base.toLowerCase()
      return {
        m,
        quant,
        base: parsedName.base,
        stem: parseModelName(full).base.toLowerCase(),
        full,
        group:
          lower.length > VISIBLE_PREFIX ? lower.slice(0, VISIBLE_PREFIX) : lower,
      }
    })

  const groups = new Map<string, typeof items>()
  for (const it of items)
    groups.set(it.group, [...(groups.get(it.group) ?? []), it])

  for (const members of groups.values()) {
    if (members.length < 2) continue
    const put = (i: number, label: string, kind: Disambiguation['kind']) =>
      out.set(members[i].m.key, {
        label: middleTruncate(label, DISAMBIGUATION_MAX),
        kind,
      })

    // 1. Same name and same file apart from the quant: the quant says it.
    if (
      new Set(members.map((x) => x.base)).size === 1 &&
      new Set(members.map((x) => x.stem)).size === 1 &&
      allDistinct(members.map((x) => x.quant))
    ) {
      members.forEach((x, i) => put(i, x.quant!, 'quant'))
      continue
    }

    // 2. Segments that differ once the shared head and tail are stripped.
    const tokens = members.map((x) => x.full.split('-'))
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    const shortest = Math.min(...tokens.map((t) => t.length))
    let head = 0
    while (
      head < shortest &&
      tokens.every((t) => same(t[head], tokens[0][head]))
    )
      head++
    let tail = 0
    while (
      tail < shortest - head &&
      tokens.every((t) =>
        same(t[t.length - 1 - tail], tokens[0][tokens[0].length - 1 - tail])
      )
    )
      tail++
    const segments = tokens.map((t) => t.slice(head, t.length - tail).join('-'))
    if (allDistinct(segments)) {
      segments.forEach((s, i) => put(i, s, 'segment'))
      continue
    }

    // 3. Size, 4. context length.
    const sizes = members.map((x) =>
      x.m.sizeBytes ? sizeLabel(x.m.sizeBytes) : undefined
    )
    if (allDistinct(sizes)) {
      sizes.forEach((s, i) => put(i, s, 'size'))
      continue
    }
    const ctxs = members.map((x) =>
      x.m.contextLength ? contextText(x.m.contextLength) : undefined
    )
    if (allDistinct(ctxs)) {
      ctxs.forEach((s, i) => put(i, s, 'context'))
      continue
    }

    // 5. Nothing differs: number them in key order, which is stable.
    members.forEach((_, i) => put(i, `#${i + 1}`, 'index'))
  }
  return out
}

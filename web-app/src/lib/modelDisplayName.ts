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

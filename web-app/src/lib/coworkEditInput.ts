/**
 * Accept `edit` with a single top-level `old_string`/`new_string` pair.
 *
 * The tool takes an `edits` list, but models often send the one-edit
 * shorthand instead, and the backend refused it with "missing required
 * argument 'edits'". The shorthand is rewritten as a one-item list. Input that
 * already has `edits`, or does not have both strings, is returned unchanged so
 * the backend still reports what is really missing.
 */
export function normalizeEditInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  if (record.edits !== undefined) return input
  const { old_string, new_string, replace_all, ...rest } = record
  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    return input
  }
  const edit: Record<string, unknown> = { old_string, new_string }
  if (typeof replace_all === 'boolean') edit.replace_all = replace_all
  return { ...rest, edits: [edit] }
}

export const OTHER_GROUP = 'other'

/**
 * The family a model belongs to, from the leading letters of its name:
 * `bartowski/Qwen3-8B-Q4_K_M` and `qwen2.5-7b` are both `qwen`.
 */
export function modelFamily(model: { id: string; name?: string }): string {
  const raw = (model.name || model.id).split('/').pop() ?? ''
  const match = raw.toLowerCase().match(/[a-z]+/)
  return match ? match[0] : OTHER_GROUP
}

export interface ModelGroup<T> {
  family: string
  models: T[]
}

/**
 * Bucket models by family. A family with a single model is folded into
 * `other` so a long list does not turn into a long list of one-row groups.
 * Families sort alphabetically with `other` last; model order is kept.
 */
export function groupModelsByFamily<T extends { id: string; name?: string }>(
  models: T[]
): ModelGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const model of models) {
    const family = modelFamily(model)
    const list = buckets.get(family)
    if (list) list.push(model)
    else buckets.set(family, [model])
  }
  const other: T[] = buckets.get(OTHER_GROUP) ?? []
  const groups: ModelGroup<T>[] = []
  for (const [family, list] of buckets) {
    if (family === OTHER_GROUP) continue
    if (list.length === 1) other.push(list[0])
    else groups.push({ family, models: list })
  }
  groups.sort((a, b) => a.family.localeCompare(b.family))
  if (other.length > 0) groups.push({ family: OTHER_GROUP, models: other })
  return groups
}

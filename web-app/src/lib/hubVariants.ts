import type { HuggingFaceFileGroup } from '@/lib/huggingface'

/** Quants worth showing first, in order, after the one that fits this device. */
const COMMON_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'Q6_K', 'Q4_K_S']

export const SHORT_LIST_SIZE = 4
/** Past this many variants the full list gets family headings. */
export const GROUP_THRESHOLD = 12
/** Rows rendered at once inside the scroll area; the rest load on request. */
export const WINDOW_SIZE = 50

/**
 * The few variants to show before "Show all": the recommended one first, then
 * the most common quantizations, then the smallest remaining, up to `limit`.
 */
export function selectShortList(
  variants: HuggingFaceFileGroup[],
  recommendedId: string | null | undefined,
  limit = SHORT_LIST_SIZE
): HuggingFaceFileGroup[] {
  const out: HuggingFaceFileGroup[] = []
  const add = (group?: HuggingFaceFileGroup) => {
    if (group && !out.includes(group) && out.length < limit) out.push(group)
  }
  add(variants.find((group) => group.id === recommendedId))
  for (const quant of COMMON_QUANTS) {
    add(
      variants.find((group) => group.quantization?.toUpperCase() === quant)
    )
  }
  const bySize = [...variants].sort(
    (a, b) => (a.totalSize ?? Infinity) - (b.totalSize ?? Infinity)
  )
  for (const group of bySize) add(group)
  return out
}

/**
 * A variant's quant family as a stable key (`full`, `compact`, `bit-4`,
 * `other`); `quantFamilyLabel` words it. The keys sort in the order the
 * headings are shown.
 */
export function quantFamily(quantization: string | null): string {
  if (!quantization) return 'other'
  const q = quantization.toUpperCase()
  if (/^(BF16|F16|F32|FP16)/.test(q)) return 'full'
  if (/^IQ/.test(q)) return 'compact'
  const match = q.match(/^Q(\d)/)
  if (match) return `bit-${match[1]}`
  return 'other'
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The heading for a `quantFamily` key, in the person's language. */
export function quantFamilyLabel(key: string, t: Translate): string {
  const bits = /^bit-(\d)$/.exec(key)
  if (bits) return t('hub:quant.family.bits', { bits: bits[1] })
  return t(`hub:quant.family.${key === 'full' || key === 'compact' ? key : 'other'}`)
}

export type VariantSection = {
  title: string | null
  items: HuggingFaceFileGroup[]
}

/** Headings only when there are more than GROUP_THRESHOLD variants. */
export function groupVariants(
  variants: HuggingFaceFileGroup[]
): VariantSection[] {
  if (variants.length <= GROUP_THRESHOLD) {
    return [{ title: null, items: variants }]
  }
  const map = new Map<string, HuggingFaceFileGroup[]>()
  for (const group of variants) {
    const key = quantFamily(group.quantization)
    map.set(key, [...(map.get(key) ?? []), group])
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([title, items]) => ({ title, items }))
}

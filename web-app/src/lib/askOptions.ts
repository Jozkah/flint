import type { AskOption, AskQuestion } from '@/types/coworkSession'

/**
 * One list of choices for a question, with exactly one custom-answer row.
 *
 * The agent core frequently supplies its own "Something else" (or "Other", or
 * "None of these") among the options, and the card used to add its own on top,
 * so the same choice appeared twice. Deciding that here rather than in the
 * component means the rule is one function with one answer, and the same
 * decision is reached whether the question arrives fresh, is restored from
 * disk, or is updated mid-stream.
 *
 * Identity is the option's id, never its display text. Two options can share a
 * label after normalization and still be different answers; and a label that
 * changes between streamed updates must not silently change what is selected.
 */

/** The id of the custom-answer row when the card supplies it. */
export const CUSTOM_OPTION_ID = 'custom-answer'

export type NormalizedOption = {
  /** Stable within a question. Used for selection, never the label. */
  id: string
  label: string
  description?: string
  /** True for the one row that reveals a free-text input. */
  isCustom: boolean
  /** True when the model supplied it, false when the card injected it. */
  fromModel: boolean
}

/**
 * Compare labels the way a reader would: case, surrounding whitespace, and a
 * trailing ellipsis or full stop do not make two labels different.
 */
export function normalizeLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/[‘’“”]/g, "'")
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\s.…!?"'`…]+$/u, '')
    .replace(/^["'`]+/u, '')
    .toLocaleLowerCase()
}

/**
 * Labels that mean "let me write my own answer".
 *
 * Deliberately short: a wrong match here would swallow a real option the model
 * offered, which is worse than showing one extra row. A translated UI is
 * covered by passing the translated fallback label in, so the card's own wording
 * always matches whatever the model echoed back.
 */
const CUSTOM_EQUIVALENTS = [
  'something else',
  'other',
  'none of these',
  'none of the above',
  'custom',
  'custom answer',
  'write my own',
  'type my own',
  'type your own answer',
  'let me type my own',
]

/**
 * Whether `label` is the custom-answer choice.
 *
 * `fallbackLabel` is the card's own wording in the active language, so a model
 * that answered in that language is recognised without a translation table.
 */
export function isCustomLabel(label: string, fallbackLabel?: string): boolean {
  const normalized = normalizeLabel(label)
  if (!normalized) return false
  if (fallbackLabel && normalized === normalizeLabel(fallbackLabel)) return true
  return CUSTOM_EQUIVALENTS.includes(normalized)
}

/**
 * The rows to render for a question: the model's options untouched, plus a
 * custom-answer row only when the model did not already offer one.
 */
export function buildOptions(
  options: readonly AskOption[] | undefined,
  fallbackLabel: string
): NormalizedOption[] {
  const rows: NormalizedOption[] = []
  const seen = new Set<string>()
  let custom: NormalizedOption | null = null

  ;(options ?? []).forEach((option, index) => {
    const label = option.label ?? ''
    const key = normalizeLabel(label)
    // A model that repeats itself should not produce two identical rows, but a
    // genuinely blank label is left alone rather than folded into the first.
    if (key && seen.has(key)) return
    if (key) seen.add(key)

    const isCustom = custom === null && isCustomLabel(label, fallbackLabel)
    const row: NormalizedOption = {
      // Positional and stable for a given question: the model does not send ids.
      id: `option-${index}`,
      // The model's own wording, exactly as it sent it. Recognising a label as
      // the custom row never rewrites it.
      label,
      description: option.description,
      isCustom,
      fromModel: true,
    }
    if (isCustom) custom = row
    rows.push(row)
  })

  if (!custom) {
    rows.push({
      id: CUSTOM_OPTION_ID,
      label: fallbackLabel,
      isCustom: true,
      fromModel: false,
    })
  }
  return rows
}

/** The row that reveals the free-text input, if the list has one. */
export function customOption(
  rows: readonly NormalizedOption[]
): NormalizedOption | undefined {
  return rows.find((r) => r.isCustom)
}

/**
 * Turn selected ids back into the labels the core expects.
 *
 * `QuestionResult` (interaction.rs) takes option labels, or free text, never
 * both -- so a custom answer replaces the selection rather than joining it.
 */
export function answerFor(
  question: AskQuestion,
  rows: readonly NormalizedOption[],
  selectedIds: readonly string[],
  customText: string
): { id: string; selected: string[]; custom_input?: string } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const chosen = selectedIds
    .map((id) => byId.get(id))
    .filter((r): r is NormalizedOption => Boolean(r))

  if (chosen.some((r) => r.isCustom)) {
    return { id: question.id, selected: [], custom_input: customText.trim() }
  }
  return { id: question.id, selected: chosen.map((r) => r.label) }
}

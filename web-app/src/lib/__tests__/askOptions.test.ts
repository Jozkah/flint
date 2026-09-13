import { describe, it, expect } from 'vitest'
import {
  CUSTOM_OPTION_ID,
  answerFor,
  buildOptions,
  customOption,
  isCustomLabel,
  normalizeLabel,
} from '@/lib/askOptions'
import type { AskQuestion } from '@/types/coworkSession'

const FALLBACK = 'Something else'
const opts = (...labels: string[]) => labels.map((label) => ({ label }))

describe('askOptions', () => {
  it('adds the custom row when the model offered no equivalent', () => {
    const rows = buildOptions(opts('Rebase', 'Merge'), FALLBACK)
    expect(rows.map((r) => r.label)).toEqual(['Rebase', 'Merge', FALLBACK])
    expect(rows.filter((r) => r.isCustom)).toHaveLength(1)
    expect(customOption(rows)?.id).toBe(CUSTOM_OPTION_ID)
    expect(customOption(rows)?.fromModel).toBe(false)
  })

  it('does not add a second one when the model already supplied it', () => {
    // The duplicate that was on screen: the model's own "Something else" plus
    // the card's injected row.
    const rows = buildOptions(opts('Rebase', 'Something else'), FALLBACK)
    expect(rows.map((r) => r.label)).toEqual(['Rebase', 'Something else'])
    expect(rows.filter((r) => r.isCustom)).toHaveLength(1)
    expect(customOption(rows)?.fromModel).toBe(true)
  })

  it('recognises the model option whatever its case, padding or punctuation', () => {
    for (const label of ['  SOMETHING ELSE  ', 'something else.', 'Something Else…']) {
      const rows = buildOptions(opts('Rebase', label), FALLBACK)
      expect(rows).toHaveLength(2)
      // The model's wording is never rewritten to the card's.
      expect(rows[1].label).toBe(label)
      expect(rows[1].isCustom).toBe(true)
    }
  })

  it('recognises the equivalents a model reaches for instead', () => {
    for (const label of ['Other', 'None of these', 'Write my own']) {
      const rows = buildOptions(opts('Rebase', label), FALLBACK)
      expect(rows.filter((r) => r.isCustom)).toHaveLength(1)
      expect(rows).toHaveLength(2)
    }
  })

  it('recognises the card own wording in a translated interface', () => {
    // The injected label is whatever the active language says; a model that
    // answered in that language matches it without a translation table.
    const rows = buildOptions(opts('Rebase', 'Otra cosa'), 'Otra cosa')
    expect(rows).toHaveLength(2)
    expect(rows[1].isCustom).toBe(true)
  })

  it('leaves a real option that merely sounds similar alone', () => {
    const rows = buildOptions(
      opts('Something else entirely', 'Other branches'),
      FALLBACK
    )
    expect(rows.map((r) => r.label)).toEqual([
      'Something else entirely',
      'Other branches',
      FALLBACK,
    ])
  })

  it('keeps exactly one custom row when the model sends two equivalents', () => {
    const rows = buildOptions(opts('Rebase', 'Other', 'Something else'), FALLBACK)
    expect(rows.filter((r) => r.isCustom)).toHaveLength(1)
    // The first one wins; the second is still a selectable option, not a
    // second free-text row.
    expect(rows[1].isCustom).toBe(true)
    expect(rows[2].isCustom).toBe(false)
  })

  it('collapses a repeated option instead of rendering it twice', () => {
    const rows = buildOptions(opts('Rebase', 'rebase '), FALLBACK)
    expect(rows.map((r) => r.label)).toEqual(['Rebase', FALLBACK])
  })

  it('gives every row a stable id that is not its label', () => {
    // A streamed update can rewrite a label; the selection must survive it.
    const first = buildOptions(opts('Rebase', 'Merge'), FALLBACK)
    const updated = buildOptions(opts('Rebase onto main', 'Merge'), FALLBACK)
    expect(first[0].id).toBe(updated[0].id)
    expect(first[0].id).not.toBe(first[0].label)
    expect(new Set(first.map((r) => r.id)).size).toBe(first.length)
  })

  it('rebuilds identically from persisted questions', () => {
    const restored = JSON.parse(
      JSON.stringify(opts('Rebase', 'Something else'))
    )
    expect(buildOptions(restored, FALLBACK)).toEqual(
      buildOptions(opts('Rebase', 'Something else'), FALLBACK)
    )
  })

  it('handles a question with no options at all', () => {
    const rows = buildOptions(undefined, FALLBACK)
    expect(rows).toHaveLength(1)
    expect(rows[0].isCustom).toBe(true)
  })

  it('normalizes labels the way a reader compares them', () => {
    expect(normalizeLabel('  Something   Else. ')).toBe('something else')
    expect(normalizeLabel('“Other”')).toBe('other')
    expect(normalizeLabel('')).toBe('')
    expect(isCustomLabel('', FALLBACK)).toBe(false)
  })

  const question: AskQuestion = {
    id: 'q1',
    question: 'How should this land?',
    options: opts('Rebase', 'Merge'),
  }

  it('answers with the labels the core expects, from the ids the card holds', () => {
    const rows = buildOptions(question.options, FALLBACK)
    expect(answerFor(question, rows, [rows[0].id], '')).toEqual({
      id: 'q1',
      selected: ['Rebase'],
    })
  })

  it('sends free text instead of a selection, never both', () => {
    const rows = buildOptions(question.options, FALLBACK)
    expect(answerFor(question, rows, [CUSTOM_OPTION_ID], '  squash it  ')).toEqual({
      id: 'q1',
      selected: [],
      custom_input: 'squash it',
    })
  })

  it('drops an id that no longer matches a row rather than inventing a label', () => {
    const rows = buildOptions(question.options, FALLBACK)
    expect(answerFor(question, rows, ['option-99'], '')).toEqual({
      id: 'q1',
      selected: [],
    })
  })
})

import { describe, it, expect } from 'vitest'
import {
  chatSafetyGuidelines,
  DESTRUCTIVE_ACTION_RULE,
  todayLine,
  UNTRUSTED_CONTENT_RULE,
} from '../promptSafety'
import { buildSubagentSystemPrompt, buildCoworkSystemPrompt } from '../coworkPrompt'
import {
  defaultAssistant,
  LEGACY_DEFAULT_ASSISTANT_INSTRUCTIONS,
  migrateLegacyDefaultAssistant,
} from '@/hooks/useAssistant'

describe('shared prompt safety rules', () => {
  it('says nothing to a chat that reads nothing and can change nothing', () => {
    expect(chatSafetyGuidelines({ readsExternalContent: false, canChangeThings: false })).toBeUndefined()
  })

  it('gives the data rule to a chat that reads outside content, and the confirm rule only with tools', () => {
    const reads = chatSafetyGuidelines({ readsExternalContent: true, canChangeThings: false })!
    expect(reads).toContain(UNTRUSTED_CONTENT_RULE)
    expect(reads).not.toContain(DESTRUCTIVE_ACTION_RULE)
    const acts = chatSafetyGuidelines({ readsExternalContent: true, canChangeThings: true })!
    expect(acts).toContain(DESTRUCTIVE_ACTION_RULE)
  })

  it('formats the date line as YYYY-MM-DD', () => {
    expect(todayLine(new Date(2026, 8, 4))).toBe("Today's date is 2026-09-04.")
  })

  it('gives a Cowork subagent the rules but not guidance for tools it lacks', () => {
    const p = buildSubagentSystemPrompt('You review code.', {
      workspacePath: '/w',
      readOnlyFolder: null,
      bashAvailable: true,
      webSearch: false,
    })
    expect(p).toContain(UNTRUSTED_CONTENT_RULE)
    expect(p).toContain(DESTRUCTIVE_ACTION_RULE)
    expect(p).not.toContain('`todo`')
    expect(p).not.toContain('`ask`')
    expect(p).toMatch(/Today's date is \d{4}-\d{2}-\d{2}\.$/)
  })

  it('puts the Cowork branch in the session block at the end, not in the workspace block', () => {
    const p = buildCoworkSystemPrompt({
      workspacePath: '/w',
      readOnlyFolder: '/proj',
      gitBranch: 'feature-x',
      planMode: false,
      bashAvailable: true,
      subagentNames: [],
      webSearch: false,
    })
    const session = p.lastIndexOf('# Session')
    expect(p.indexOf('feature-x')).toBeGreaterThan(session)
    expect(p).toContain('# Other sessions')
  })
})

describe('default assistant instructions', () => {
  it('replaces the old default instructions only when untouched', () => {
    const old = { ...defaultAssistant, instructions: LEGACY_DEFAULT_ASSISTANT_INSTRUCTIONS }
    expect(migrateLegacyDefaultAssistant(old).instructions).toBe(defaultAssistant.instructions)
    const edited = { ...defaultAssistant, instructions: 'my own rules' }
    expect(migrateLegacyDefaultAssistant(edited).instructions).toBe('my own rules')
  })

  it('no longer puts the date or a search promise in the instructions', () => {
    expect(defaultAssistant.instructions).not.toContain('{{current_date}}')
    expect(defaultAssistant.instructions).not.toContain('Search before stating')
  })
})

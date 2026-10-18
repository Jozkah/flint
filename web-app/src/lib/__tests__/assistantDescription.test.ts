import { describe, it, expect } from 'vitest'
import { shownAssistantDescription } from '../assistantDescription'

const t = (key: string) => `T(${key})`

// C059: the starter assistants' descriptions stayed English in every locale.
describe('shownAssistantDescription', () => {
  it('translates a starter whose description is the shipped one', () => {
    expect(
      shownAssistantDescription(
        {
          id: 'quartz',
          description:
            'A precise research and analysis specialist for evidence, comparisons, calculations, and decision-ready conclusions.',
        },
        t
      )
    ).toBe('T(assistants:starterDescriptions.quartz)')
  })

  it('knows every shipped starter description verbatim', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const builtIns = readFileSync(
      resolve(__dirname, '../../../../extensions/assistant-extension/src/builtInAssistants.ts'),
      'utf8'
    )
    const en = (await import('@/locales/en/assistants.json')).default.starterDescriptions
    const { defaultAssistant } = await import('@/hooks/useAssistant')
    expect(en.jan).toBe(defaultAssistant.description)
    for (const [id, text] of Object.entries(en)) {
      if (id === 'jan') continue
      expect(builtIns, id).toContain(`'${id}'`)
      expect(builtIns, id).toContain(`'${text}'`)
    }
  })

  it('keeps a description the user wrote, and a custom assistant’s', () => {
    expect(shownAssistantDescription({ id: 'quartz', description: 'Mine' }, t)).toBe('Mine')
    expect(shownAssistantDescription({ id: 'x1', description: 'Custom' }, t)).toBe('Custom')
    expect(shownAssistantDescription({ id: 'quartz', description: '' }, t)).toBe('')
  })
})

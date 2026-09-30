import { beforeEach, describe, expect, it } from 'vitest'
import { useAssistant } from '@/hooks/useAssistant'
import { participantPersona } from '../persona'

const quartz = {
  id: 'quartz',
  name: 'Quartz',
  instructions: 'Weigh the evidence before you answer.',
} as never

beforeEach(() => {
  useAssistant.setState({ assistants: [quartz] } as never)
})

describe('participantPersona', () => {
  it('adds the assistant personality and the work profile, in that order', () => {
    const out = participantPersona({ name: 'Ada', assistantId: 'quartz', workProfile: 'review' })
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('as Ada')
    expect(out[0]).toContain('Weigh the evidence')
    expect(out[1]).toContain('(Review)')
  })

  it('adds nothing for a participant with neither', () => {
    expect(participantPersona({ name: 'Ada' })).toEqual([])
  })

  it('skips an assistant that has since been deleted, and keeps the work profile', () => {
    const out = participantPersona({ name: 'Ada', assistantId: 'gone', workProfile: 'plan' })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('(Plan)')
  })
})

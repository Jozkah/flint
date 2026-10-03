import { describe, expect, it } from 'vitest'
import { withSettings } from '@/lib/modelOverrides'

const model = (settings?: Record<string, unknown>) =>
  ({ id: 'm', settings }) as unknown as Model

const value = (m: Model, key: string) =>
  (m.settings as Record<string, { controller_props: { value: unknown } }>)[key]
    .controller_props.value

describe('withSettings', () => {
  it('writes several settings into one model, none undoing another', () => {
    // Leaving Off writes `reasoning` and the effort together. Written one after
    // the other from the same snapshot, the second erased the first and the bar
    // stayed on Off.
    const before = model({
      reasoning: {
        key: 'reasoning',
        title: 'Reasoning',
        description: '',
        controller_type: 'dropdown',
        controller_props: { value: 'off' },
      },
    })
    const after = withSettings(before, [
      { key: 'reasoning', title: 'Reasoning', controllerType: 'dropdown', value: 'auto' },
      {
        key: 'thinking_budget_tokens',
        title: 'Reasoning Effort',
        controllerType: 'dropdown',
        value: 'high',
      },
    ])
    expect(value(after, 'reasoning')).toBe('auto')
    expect(value(after, 'thinking_budget_tokens')).toBe('high')
  })

  it('creates a setting the model does not define yet', () => {
    const after = withSettings(model(), [
      { key: 'reasoning', title: 'Reasoning', controllerType: 'dropdown', value: 'off' },
    ])
    expect(value(after, 'reasoning')).toBe('off')
  })

  it('leaves the model it was given untouched', () => {
    const before = model({
      reasoning: {
        key: 'reasoning',
        title: 'Reasoning',
        description: '',
        controller_type: 'dropdown',
        controller_props: { value: 'off' },
      },
    })
    withSettings(before, [
      { key: 'reasoning', title: 'Reasoning', controllerType: 'dropdown', value: 'on' },
    ])
    expect(value(before, 'reasoning')).toBe('off')
  })
})

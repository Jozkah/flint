import { describe, expect, it } from 'vitest'
import {
  NO_OVERRIDES,
  clearAllOverrides,
  clearOverride,
  effectiveValue,
  hasOverrides,
  isOverridden,
  overriddenKeys,
  pruneOverrides,
  resolveModel,
  setOverride,
  type ModelOverrides,
} from '@/lib/modelOverrides'

/** A global model configuration, as the provider store holds one. */
const model = (settings: Record<string, unknown> = {}): Model =>
  ({
    id: 'gpt-5',
    settings: Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [
        key,
        {
          key,
          title: key,
          description: '',
          controller_type: 'dropdown',
          controller_props: { value },
        },
      ])
    ),
  }) as unknown as Model

describe('precedence between a chat and the global configuration', () => {
  it('uses the global value for a setting the chat has not touched', () => {
    const global = model({ thinking_budget_tokens: 'low', temperature: 0.7 })
    expect(effectiveValue(global, NO_OVERRIDES, 'temperature')).toBe(0.7)
    expect(effectiveValue(global, NO_OVERRIDES, 'thinking_budget_tokens')).toBe(
      'low'
    )
  })

  it('uses the chat’s value for a setting it has overridden', () => {
    const global = model({ thinking_budget_tokens: 'low' })
    const overrides = setOverride(undefined, 'thinking_budget_tokens', 'high')
    expect(effectiveValue(global, overrides, 'thinking_budget_tokens')).toBe(
      'high'
    )
  })

  it('follows the global default as it changes, for untouched settings', () => {
    // The whole point of storing overrides sparsely: a chat opened months ago
    // still tracks Settings for everything it did not deliberately change.
    const overrides = setOverride(undefined, 'thinking_budget_tokens', 'high')
    const before = model({ thinking_budget_tokens: 'low', temperature: 0.7 })
    const after = model({ thinking_budget_tokens: 'low', temperature: 0.2 })

    expect(effectiveValue(before, overrides, 'temperature')).toBe(0.7)
    expect(effectiveValue(after, overrides, 'temperature')).toBe(0.2)
    // …while the overridden one stays put.
    expect(effectiveValue(after, overrides, 'thinking_budget_tokens')).toBe(
      'high'
    )
  })

  it('keeps an override that happens to equal the global value', () => {
    // The user asked this chat for that value; it must hold even after the
    // global default moves away from it.
    const overrides = setOverride(undefined, 'thinking_budget_tokens', 'low')
    expect(isOverridden(overrides, 'thinking_budget_tokens')).toBe(true)
    const moved = model({ thinking_budget_tokens: 'xhigh' })
    expect(effectiveValue(moved, overrides, 'thinking_budget_tokens')).toBe(
      'low'
    )
  })

  it('reports nothing for a setting neither side defines', () => {
    expect(effectiveValue(model(), NO_OVERRIDES, 'nope')).toBeUndefined()
  })
})

describe('resolving the model a chat actually sends', () => {
  it('applies the chat’s values over the global ones', () => {
    const global = model({ thinking_budget_tokens: 'low', temperature: 0.7 })
    const resolved = resolveModel(
      global,
      setOverride(undefined, 'thinking_budget_tokens', 'xhigh')
    )
    expect(
      resolved.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('xhigh')
    // Untouched settings come through unchanged.
    expect(resolved.settings?.temperature?.controller_props?.value).toBe(0.7)
  })

  it('keeps everything about a setting except its value', () => {
    // Title, controller type and bounds belong to the model's own definition;
    // a chat has no business carrying a stale copy of them.
    const global = model({ thinking_budget_tokens: 'low' })
    const resolved = resolveModel(
      global,
      setOverride(undefined, 'thinking_budget_tokens', 'high')
    )
    expect(resolved.settings?.thinking_budget_tokens).toMatchObject({
      key: 'thinking_budget_tokens',
      controller_type: 'dropdown',
    })
  })

  it('returns the very same model when the chat overrides nothing', () => {
    // The common case must allocate nothing, so callers can compare by
    // identity and skip work.
    const global = model({ thinking_budget_tokens: 'low' })
    expect(resolveModel(global, NO_OVERRIDES)).toBe(global)
    expect(resolveModel(global, undefined)).toBe(global)
    expect(resolveModel(global, {})).toBe(global)
  })

  it('returns the same model when every override already matches', () => {
    const global = model({ thinking_budget_tokens: 'low' })
    const same = setOverride(undefined, 'thinking_budget_tokens', 'low')
    expect(resolveModel(global, same)).toBe(global)
  })

  it('never mutates the global configuration', () => {
    const global = model({ thinking_budget_tokens: 'low' })
    resolveModel(
      global,
      setOverride(undefined, 'thinking_budget_tokens', 'high')
    )
    expect(
      global.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('low')
  })

  it('creates a setting the model has no entry for yet', () => {
    // Absent does not mean unsupported: a model that has never had a setting
    // touched simply has no entry for it, which is every model out of the box.
    // Skipping those made the override silently do nothing.
    const global = model({ temperature: 0.7 })
    const resolved = resolveModel(
      global,
      setOverride(undefined, 'thinking_budget_tokens', 'high')
    )
    expect(
      resolved.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('high')
    expect(resolved).not.toBe(global)
    // The global configuration is untouched.
    expect(global.settings?.thinking_budget_tokens).toBeUndefined()
  })

  it('reaches the request for a model that defined no settings at all', () => {
    // The end the previous behaviour broke: a cloud model out of the box.
    const bare = { id: 'gpt-5', settings: {} } as unknown as Model
    const resolved = resolveModel(
      bare,
      setOverride(undefined, 'thinking_budget_tokens', 'xhigh')
    )
    expect(
      resolved.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('xhigh')
  })

  it('gives a model with no settings object the chat’s values', () => {
    // Remote models are listed without one; see the block at the end.
    const bare = { id: 'x' } as unknown as Model
    const resolved = resolveModel(bare, setOverride(undefined, 'anything', 'v'))
    expect(resolved).not.toBe(bare)
    expect(resolved.settings?.anything?.controller_props?.value).toBe('v')
  })

  it('passes a missing model straight through', () => {
    expect(resolveModel(null, setOverride(undefined, 'a', 'b'))).toBeNull()
    expect(resolveModel(undefined, undefined)).toBeUndefined()
  })
})

describe('resetting to the global defaults', () => {
  it('gives one setting back', () => {
    const overrides = setOverride(
      setOverride(undefined, 'thinking_budget_tokens', 'high'),
      'temperature',
      0.1
    )
    const next = clearOverride(overrides, 'thinking_budget_tokens')
    expect(isOverridden(next, 'thinking_budget_tokens')).toBe(false)
    expect(isOverridden(next, 'temperature')).toBe(true)
  })

  it('gives every setting back', () => {
    const overrides = setOverride(undefined, 'thinking_budget_tokens', 'high')
    expect(hasOverrides(clearAllOverrides())).toBe(false)
    expect(hasOverrides(overrides)).toBe(true)
  })

  it('leaves the record alone when there was nothing to clear', () => {
    const overrides = setOverride(undefined, 'temperature', 0.1)
    expect(clearOverride(overrides, 'thinking_budget_tokens')).toBe(overrides)
  })

  it('never mutates the set it was given', () => {
    const overrides = setOverride(undefined, 'temperature', 0.1)
    clearOverride(overrides, 'temperature')
    expect(isOverridden(overrides, 'temperature')).toBe(true)
  })

  it('falls back to the global value once cleared', () => {
    const global = model({ thinking_budget_tokens: 'medium' })
    const overridden = setOverride(undefined, 'thinking_budget_tokens', 'high')
    const cleared = clearOverride(overridden, 'thinking_budget_tokens')
    expect(effectiveValue(global, cleared, 'thinking_budget_tokens')).toBe(
      'medium'
    )
  })
})

describe('pruning overrides the new model cannot act on', () => {
  it('drops what the caller says is unsupported', () => {
    const overrides: ModelOverrides = {
      thinking_budget_tokens: 'high',
      temperature: 0.1,
    }
    const pruned = pruneOverrides(
      overrides,
      (key) => key === 'thinking_budget_tokens'
    )
    expect(overriddenKeys(pruned)).toEqual(['temperature'])
  })

  it('returns the same set when everything still applies', () => {
    const overrides = setOverride(undefined, 'temperature', 0.1)
    expect(pruneOverrides(overrides, () => false)).toBe(overrides)
  })

  it('does not use "the model has no entry" as the test', () => {
    // A model that has never had a setting touched has no entry for it —
    // which is every model out of the box — so presence says nothing about
    // support. Pruning on it would discard a good override on almost every
    // model change.
    const overrides = setOverride(undefined, 'thinking_budget_tokens', 'high')
    expect(pruneOverrides(overrides, () => false)).toBe(overrides)
  })

  it('has nothing to do for a chat that overrides nothing', () => {
    expect(hasOverrides(pruneOverrides(undefined, () => true))).toBe(false)
  })
})

describe('small helpers', () => {
  it('reports what a chat has an opinion about, in a stable order', () => {
    const overrides: ModelOverrides = { temperature: 0.1, ctx_len: 4096 }
    expect(overriddenKeys(overrides)).toEqual(['ctx_len', 'temperature'])
    expect(overriddenKeys(undefined)).toEqual([])
  })

  it('treats an absent key as no opinion, not as a stored undefined', () => {
    expect(isOverridden({ a: undefined }, 'a')).toBe(true)
    expect(isOverridden({ a: undefined }, 'b')).toBe(false)
  })
})

describe('a model with no settings at all', () => {
  // A model a provider listed over the wire carries an id and a name and
  // nothing else. The chat's own value for a setting still has to reach it, or
  // the effort bar stores a choice that is never shown and never sent.
  const bare = { id: 'pxa-qwen3.8-27b', capabilities: ['completion'] } as Model

  it('still takes the chat’s overrides', () => {
    const resolved = resolveModel(bare, { thinking_budget_tokens: 'high' })
    expect(
      resolved.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('high')
  })

  it('is returned as it is when the chat overrides nothing', () => {
    expect(resolveModel(bare, undefined)).toBe(bare)
    expect(resolveModel(bare, {})).toBe(bare)
  })
})

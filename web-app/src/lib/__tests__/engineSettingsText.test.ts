import { describe, it, expect } from 'vitest'
import { localizeEngineSetting } from '../engineSettingsText'
import ru from '@/locales/ru/engineSettings.json'
import en from '@/locales/en/engineSettings.json'

const table = (dict: Record<string, unknown>) => (key: string, o?: Record<string, unknown>) => {
  const path = key.split(':')[1].split('.')
  let v: unknown = dict
  for (const p of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined
  return typeof v === 'string' ? v : String(o?.defaultValue ?? key)
}

const splitMode: ProviderSetting = {
  key: 'split_mode',
  title: 'GPU Split Mode',
  description: 'How to split the model across multiple GPUs.',
  controller_type: 'dropdown',
  controller_props: { value: 'layer', options: [{ value: 'none', name: 'None' }, { value: 'layer', name: 'Layer' }] },
}

describe('engine settings copy', () => {
  it('localizes title, description and option names for llama.cpp', () => {
    const out = localizeEngineSetting(table(ru), 'llamacpp', splitMode)
    expect(out.title).not.toBe('GPU Split Mode')
    expect(out.controller_props.options?.[0].name).not.toBe('None')
    expect(out.controller_props.options?.[0].value).toBe('none')
  })
  it('falls back to the English text for a setting it has no entry for', () => {
    const s = { ...splitMode, key: 'brand_new', title: 'Brand new' }
    expect(localizeEngineSetting(table(ru), 'llamacpp', s).title).toBe('Brand new')
  })
  it('leaves other providers alone', () => {
    const s = { ...splitMode, key: 'api-key', title: 'API Key' }
    expect(localizeEngineSetting(table(ru), 'openai', s)).toBe(s)
  })
  it('has English for every llama.cpp setting', async () => {
    const settings = (await import('../../../../extensions/llamacpp-extension/settings.json')).default as { key: string; title: string }[]
    for (const s of settings) expect((en as Record<string, { title: string }>)[s.key]?.title).toBe(s.title)
  })
})

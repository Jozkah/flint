import { describe, expect, it } from 'vitest'
import {
  groupBySource,
  modelsOutsideFolder,
  type ScannedModel,
} from '@/lib/localModelScan'

const model = (name: string, source: string): ScannedModel => ({
  path: `/m/${name}`,
  name,
  source,
  size_bytes: 1,
})

describe('groupBySource', () => {
  it('groups models under the app they came from, in first-seen order', () => {
    const groups = groupBySource([
      model('a', 'Ollama'),
      model('b', 'LM Studio'),
      model('c', 'Ollama'),
    ])
    expect(groups.map((g) => g.source)).toEqual(['Ollama', 'LM Studio'])
    expect(groups[0].models.map((m) => m.name)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty scan', () => {
    expect(groupBySource([])).toEqual([])
  })
})

describe('modelsOutsideFolder', () => {
  const at = (path: string): ScannedModel => ({ path, name: path, source: 'Custom folder', size_bytes: 1 })

  it('drops what lives under the folder, at any depth', () => {
    const out = modelsOutsideFolder(
      [at('C:/models/a.gguf'), at('C:/models/sub/b.gguf'), at('C:/other/c.gguf')],
      'C:/models'
    )
    expect(out.map((m) => m.path)).toEqual(['C:/other/c.gguf'])
  })

  it('matches across slash styles, case and a trailing separator', () => {
    const out = modelsOutsideFolder([at('C:\\Models\\a.gguf'), at('D:/x.gguf')], 'c:/models/')
    expect(out.map((m) => m.path)).toEqual(['D:/x.gguf'])
  })

  it('does not drop a sibling folder that merely shares a prefix', () => {
    const out = modelsOutsideFolder([at('C:/models-old/a.gguf')], 'C:/models')
    expect(out).toHaveLength(1)
  })

  it('keeps everything for an empty folder name', () => {
    expect(modelsOutsideFolder([at('C:/a.gguf')], '  ')).toHaveLength(1)
  })
})

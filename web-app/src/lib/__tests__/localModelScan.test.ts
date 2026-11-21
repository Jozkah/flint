import { describe, expect, it, vi } from 'vitest'

const studio = vi.hoisted(() => ({
  guessFamily: vi.fn(),
  addLocalModel: vi.fn(),
}))
vi.mock('@/lib/studio/studio', () => ({ studioApi: studio }))
import {
  addScannedToStudio,
  groupBySource,
  splitByKind,
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

describe('splitByKind', () => {
  const k = (name: string, kind?: ScannedModel['kind']): ScannedModel => ({
    ...model(name, 'Custom folder'),
    kind,
  })

  it('keeps encoders, VAEs and LoRAs out of the chat list', () => {
    const split = splitByKind([
      k('chat'),
      k('old-scan-entry', undefined),
      k('flux', 'diffusion'),
      k('qwen3', 'encoder'),
      k('ae', 'vae'),
      k('style', 'lora'),
    ])
    expect(split.text.map((m) => m.name)).toEqual(['chat', 'old-scan-entry'])
    expect(split.diffusion.map((m) => m.name)).toEqual(['flux'])
    expect(split.companions.map((m) => m.name)).toEqual(['qwen3', 'ae'])
    expect(split.loras.map((m) => m.name)).toEqual(['style'])
  })
})

describe('addScannedToStudio', () => {
  const scan: ScannedModel[] = [
    { ...model('z', 'Custom folder'), path: 'D:/m/diffusion_models/z_image_turbo-Q3_K.gguf', kind: 'diffusion' },
    { ...model('enc', 'Custom folder'), path: 'D:/m/text_encoders/q.gguf', kind: 'encoder' },
    { ...model('chat', 'Custom folder'), path: 'D:/m/chat.gguf', kind: 'text' },
  ]

  it('registers in place with the family guessed from the file name and the found companions', async () => {
    studio.guessFamily.mockResolvedValue('z-image')
    studio.addLocalModel.mockResolvedValue({ display_name: 'z' })
    await addScannedToStudio(scan[0], scan)
    expect(studio.guessFamily).toHaveBeenCalledWith('', 'z_image_turbo-Q3_K.gguf')
    expect(studio.addLocalModel).toHaveBeenCalledWith({
      path: 'D:/m/diffusion_models/z_image_turbo-Q3_K.gguf',
      family: 'z-image',
      companions: ['D:/m/text_encoders/q.gguf'],
    })
  })

  it('rejects a file whose family Studio cannot run', async () => {
    studio.guessFamily.mockResolvedValue(null)
    studio.addLocalModel.mockClear()
    await expect(addScannedToStudio(scan[0], scan)).rejects.toThrow('unsupported-family')
    expect(studio.addLocalModel).not.toHaveBeenCalled()
  })
})

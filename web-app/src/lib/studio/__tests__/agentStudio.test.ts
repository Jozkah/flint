import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const status = vi.fn()
const gallery = vi.fn()
const generateImage = vi.fn()
const cancel = vi.fn()
const openExternal = vi.fn()
const refreshGallery = vi.fn()

vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    status: () => status(),
    gallery: (k: string) => gallery(k),
    generateImage: (p: unknown) => generateImage(p),
    cancel: () => cancel(),
    openExternal: (...a: unknown[]) => openExternal(...a),
  },
}))
vi.mock('@/hooks/useStudio', () => ({
  useStudio: { getState: () => ({ refreshGallery }) },
}))

import {
  STUDIO_LIMITS,
  describeStudioCall,
  folderOf,
  forgetStudioReadFolders,
  installedImageModels,
  isStudioTool,
  planGeneration,
  runStudioTool,
  studioInputError,
  studioPrecheck,
  studioReadFolders,
} from '../agentStudio'
import { localStorageKey } from '@/constants/localStorage'

const model = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  display_name: `Model ${id}`,
  kind: 'image',
  installed: true,
  min_side: 256,
  max_side: 1536,
  defaults: { steps: 8, width: 1024, height: 1024 },
  ...over,
})

const ready = (over: Record<string, unknown> = {}) => ({
  supported: true,
  engineBackend: 'vulkan',
  models: [model('z-image-turbo'), model('flux-x')],
  resident: null,
  ...over,
})

const item = (id: string, created: number, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'image',
  path: `C:\\Data\\images\\${id}.png`,
  recipe: {
    jobId: 'j',
    kind: 'image',
    prompt: `prompt ${id}`,
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 8,
    seed: 7,
    batchSeed: 7,
    modelId: 'z-image-turbo',
    modelName: 'Z-Image Turbo',
    createdAtMs: created,
    durationMs: 10,
    ...over,
  },
})

let n = 0
const thread = () => `studio-thread-${++n}`

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  status.mockResolvedValue(ready())
  gallery.mockResolvedValue([])
  cancel.mockResolvedValue(undefined)
  refreshGallery.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  forgetStudioReadFolders()
})

describe('argument validation', () => {
  it('knows its three tools', () => {
    expect(isStudioTool('studio_list_generations')).toBe(true)
    expect(isStudioTool('studio_generate_image')).toBe(true)
    expect(isStudioTool('studio_open_in_editor')).toBe(true)
    expect(isStudioTool('image_gen')).toBe(false)
  })

  it('bounds the listing', () => {
    expect(studioInputError('studio_list_generations', {})).toBeNull()
    expect(studioInputError('studio_list_generations', { limit: STUDIO_LIMITS.maxListed })).toBeNull()
    expect(studioInputError('studio_list_generations', { limit: 0 })).toMatch(/limit/)
    expect(studioInputError('studio_list_generations', { limit: 51 })).toMatch(/limit/)
    expect(studioInputError('studio_list_generations', { limit: 1.5 })).toMatch(/limit/)
    expect(studioInputError('studio_list_generations', { kind: 'audio' })).toMatch(/kind/)
    expect(studioInputError('studio_list_generations', { kind: 'video' })).toBeNull()
  })

  it('needs a prompt and keeps count, steps and seed inside the engine limits', () => {
    const ok = { prompt: 'a cat' }
    expect(studioInputError('studio_generate_image', ok)).toBeNull()
    expect(studioInputError('studio_generate_image', {})).toMatch(/prompt/)
    expect(studioInputError('studio_generate_image', { prompt: '   ' })).toMatch(/prompt/)
    expect(studioInputError('studio_generate_image', { prompt: 'x'.repeat(4001) })).toMatch(/longer/)
    expect(studioInputError('studio_generate_image', { ...ok, count: 0 })).toMatch(/count/)
    expect(studioInputError('studio_generate_image', { ...ok, count: 5 })).toMatch(/count/)
    expect(studioInputError('studio_generate_image', { ...ok, count: 4 })).toBeNull()
    expect(studioInputError('studio_generate_image', { ...ok, steps: 0 })).toMatch(/steps/)
    expect(studioInputError('studio_generate_image', { ...ok, steps: 101 })).toMatch(/steps/)
    expect(studioInputError('studio_generate_image', { ...ok, steps: 100 })).toBeNull()
    expect(studioInputError('studio_generate_image', { ...ok, seed: -1 })).toMatch(/seed/)
    expect(studioInputError('studio_generate_image', { ...ok, seed: 4294967296 })).toMatch(/seed/)
    expect(studioInputError('studio_generate_image', { ...ok, seed: 4294967295 })).toBeNull()
    expect(studioInputError('studio_generate_image', { ...ok, seed: 0 })).toBeNull()
    expect(studioInputError('studio_generate_image', { ...ok, width: 512.5 })).toMatch(/width/)
    expect(studioInputError('studio_generate_image', { ...ok, height: '512' })).toMatch(/height/)
    expect(studioInputError('studio_generate_image', { ...ok, model: 3 })).toMatch(/model/)
    expect(studioInputError('studio_generate_image', { ...ok, negative_prompt: 4 })).toMatch(/negative/)
  })

  it('needs an id to open', () => {
    expect(studioInputError('studio_open_in_editor', {})).toMatch(/id/)
    expect(studioInputError('studio_open_in_editor', { id: '  ' })).toMatch(/id/)
    expect(studioInputError('studio_open_in_editor', { id: 'g1' })).toBeNull()
  })

  it('finds the folder of a Windows or POSIX path', () => {
    expect(folderOf('C:\\Data\\images\\a.png')).toBe('C:\\Data\\images')
    expect(folderOf('/home/u/data/images/a.png')).toBe('/home/u/data/images')
  })
})

describe('choosing the model', () => {
  it('says to install a model in Studio when none is installed, and never generates', async () => {
    status.mockResolvedValue(ready({ models: [model('a', { installed: false }), model('v', { kind: 'video' })] }))
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    expect(r.error).toMatch(/No picture model is installed in Studio/)
    expect(r.error).toMatch(/download or add/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('says to install the engine when only the models are there', async () => {
    status.mockResolvedValue(ready({ engineBackend: null }))
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    expect(r.error).toMatch(/engine is not installed/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('refuses on a computer with no engine support', async () => {
    status.mockResolvedValue(ready({ supported: false }))
    expect((await planGeneration({ prompt: 'cat' })) as { error: string }).toHaveProperty('error')
  })

  it('lists installed picture models only', () => {
    const s = ready({ models: [model('a'), model('b', { installed: false }), model('c', { kind: 'video' })] })
    expect(installedImageModels(s as never).map((m) => m.id)).toEqual(['a'])
  })

  it('prefers the named model, then the loaded one, then the newest picture\'s, then the first', async () => {
    const pick = async (args: Record<string, unknown> = {}) => {
      const plan = await planGeneration({ prompt: 'cat', ...args })
      return 'error' in plan ? plan.error : plan.model.id
    }
    expect(await pick()).toBe('z-image-turbo')
    gallery.mockResolvedValue([item('a', 5, { modelId: 'flux-x' })])
    expect(await pick()).toBe('flux-x')
    status.mockResolvedValue(ready({ resident: { model_id: 'z-image-turbo', kind: 'image', busy: false } }))
    expect(await pick()).toBe('z-image-turbo')
    expect(await pick({ model: 'FLUX-X' })).toBe('flux-x')
    expect(await pick({ model: 'Model z-image-turbo' })).toBe('z-image-turbo')
    expect(await pick({ model: 'nope' })).toMatch(/not an installed picture model.*z-image-turbo.*flux-x/)
  })

  it('holds sizes to the model: a multiple of 16 inside its range', async () => {
    const size = async (w: number, h: number) => {
      const plan = await planGeneration({ prompt: 'cat', width: w, height: h })
      return 'error' in plan ? plan.error : 'ok'
    }
    expect(await size(512, 768)).toBe('ok')
    expect(await size(1536, 256)).toBe('ok')
    expect(await size(200, 512)).toMatch(/width must be between 256 and 1536/)
    expect(await size(512, 2048)).toMatch(/height must be between 256 and 1536/)
    expect(await size(500, 512)).toMatch(/width must be a multiple of 16/)
  })
})

describe('studio_list_generations', () => {
  it('lists the newest first with absolute paths, prompt, model, size and seed', async () => {
    gallery.mockResolvedValue([item('old', 1000), item('new', 3000), item('mid', 2000)])
    const t = thread()
    const r = await runStudioTool('studio_list_generations', { limit: 2 }, t)
    const out = JSON.parse(r.content ?? '{}')
    expect(out.total).toBe(3)
    expect(out.shown).toBe(2)
    expect(out.folder).toBe('C:\\Data\\images')
    expect(out.generations.map((g: { id: string }) => g.id)).toEqual(['new', 'mid'])
    expect(out.generations[0]).toMatchObject({
      path: 'C:\\Data\\images\\new.png',
      prompt: 'prompt new',
      model: 'Z-Image Turbo',
      width: 1024,
      height: 1024,
      steps: 8,
      seed: 7,
    })
    expect(out.generations[0].created).toBe('1970-01-01T00:00:03.000Z')
  })

  it('defaults to ten and asks the gallery for the kind it was given', async () => {
    gallery.mockResolvedValue(Array.from({ length: 15 }, (_, i) => item(`g${i}`, i)))
    const r = await runStudioTool('studio_list_generations', {}, thread())
    expect(JSON.parse(r.content ?? '{}').shown).toBe(10)
    await runStudioTool('studio_list_generations', { kind: 'video' }, thread())
    expect(gallery).toHaveBeenLastCalledWith('video')
  })

  it('says so when nothing was made and grants no folder', async () => {
    const t = thread()
    const r = await runStudioTool('studio_list_generations', {}, t)
    expect(JSON.parse(r.content ?? '{}').shown).toBe(0)
    expect(studioReadFolders(t)).toEqual([])
  })

  it('remembers the gallery folder for that conversation only, so the file tools can read it', async () => {
    gallery.mockResolvedValue([item('a', 1)])
    const a = thread()
    const b = thread()
    await runStudioTool('studio_list_generations', {}, a)
    expect(studioReadFolders(a)).toEqual(['C:\\Data\\images'])
    expect(studioReadFolders(b)).toEqual([])
  })

  it('rejects a bad limit without touching Studio', async () => {
    const r = await runStudioTool('studio_list_generations', { limit: 500 }, thread())
    expect(r.error).toMatch(/limit/)
    expect(gallery).not.toHaveBeenCalled()
  })
})

describe('studio_generate_image', () => {
  const generated = { job_id: 'j1', seed: 42, ids: ['g1'], paths: ['C:\\Data\\images\\g1.png'], duration_ms: 900 }

  it('generates with the chosen model and the limits it was given', async () => {
    generateImage.mockResolvedValue(generated)
    gallery.mockResolvedValue([item('g1', 9)])
    const t = thread()
    const r = await runStudioTool(
      'studio_generate_image',
      { prompt: ' a red fox ', negative_prompt: 'blurry', width: 512, height: 768, steps: 6, seed: 42, count: 2 },
      t
    )
    expect(generateImage).toHaveBeenCalledWith({
      model: 'z-image-turbo',
      prompt: 'a red fox',
      negative_prompt: 'blurry',
      width: 512,
      height: 768,
      steps: 6,
      seed: 42,
      count: 2,
    })
    const out = JSON.parse(r.content ?? '{}')
    expect(out.status).toBe('done')
    expect(out.images[0]).toMatchObject({ id: 'g1', path: 'C:\\Data\\images\\g1.png', model: 'Z-Image Turbo' })
    expect(studioReadFolders(t)).toEqual(['C:\\Data\\images'])
    expect(refreshGallery).toHaveBeenCalledWith('image')
  })

  it('falls back to the bare ids and paths when the gallery cannot be read back', async () => {
    generateImage.mockResolvedValue(generated)
    gallery.mockRejectedValue(new Error('no'))
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    expect(JSON.parse(r.content ?? '{}').images).toEqual([{ id: 'g1', path: 'C:\\Data\\images\\g1.png' }])
  })

  it('reports the engine\'s own error', async () => {
    generateImage.mockRejectedValue('The image engine is busy with another generation.')
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    expect(r.error).toMatch(/busy/)
  })

  it('cancels the engine when the user presses Stop', async () => {
    let finish: (v: unknown) => void = () => {}
    generateImage.mockReturnValue(new Promise((r) => (finish = r)))
    const stop = new AbortController()
    const run = runStudioTool('studio_generate_image', { prompt: 'cat' }, thread(), { signal: stop.signal })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalled())
    stop.abort()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    finish(generated)
    const r = await run
    expect(r.error).toMatch(/Stopped/)
  })

  it('does not start when it was stopped already', async () => {
    const stop = new AbortController()
    stop.abort()
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread(), { signal: stop.signal })
    expect(r.error).toMatch(/Stopped/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('gives up after the generation timeout and cancels the engine', async () => {
    vi.useFakeTimers()
    let finish: (v: unknown) => void = () => {}
    generateImage.mockReturnValue(new Promise((r) => (finish = r)))
    const run = runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    await vi.advanceTimersByTimeAsync(STUDIO_LIMITS.timeoutMs + 1)
    expect(cancel).toHaveBeenCalledTimes(1)
    finish(generated)
    await vi.advanceTimersByTimeAsync(1)
    const r = await run
    expect(r.error).toMatch(/10 minutes/)
  })

  it('does not count a finished call as a timeout', async () => {
    vi.useFakeTimers()
    generateImage.mockResolvedValue(generated)
    const r = await runStudioTool('studio_generate_image', { prompt: 'cat' }, thread())
    expect(r.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(STUDIO_LIMITS.timeoutMs * 2)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('describes the call for the approval question with the model, size and steps (the prompt is shown beside it)', async () => {
    const text = await describeStudioCall('studio_generate_image', { prompt: 'a red fox', width: 512, height: 768, steps: 9 })
    expect(text).toContain('9')
    expect(text).toContain('512 x 768')
    expect(text).toContain('Model z-image-turbo')
  })
})

describe('studio_open_in_editor', () => {
  const configure = (program = 'C:\\Tools\\gmic_qt.exe', args = '') =>
    window.localStorage.setItem(
      localStorageKey.studioExternalEditor,
      JSON.stringify({ preset: 'gmic', program, args })
    )

  it('refuses until the user set up an editor, and opens nothing', async () => {
    gallery.mockResolvedValue([item('g1', 1)])
    const r = await runStudioTool('studio_open_in_editor', { id: 'g1' }, thread())
    expect(r.error).toMatch(/No external editor is set up/)
    expect(openExternal).not.toHaveBeenCalled()
    expect(await studioPrecheck('studio_open_in_editor', { id: 'g1' })).toMatch(/No external editor/)
  })

  it('refuses an id that is not in the gallery', async () => {
    configure()
    gallery.mockResolvedValue([item('g1', 1)])
    const r = await runStudioTool('studio_open_in_editor', { id: 'zzz' }, thread())
    expect(r.error).toMatch(/no picture with the id zzz/)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the picture with the program the user chose, never one the model names', async () => {
    configure('C:\\Tools\\gmic_qt.exe', '--x {file}')
    gallery.mockResolvedValue([item('g1', 1)])
    openExternal.mockResolvedValue(undefined)
    const r = await runStudioTool(
      'studio_open_in_editor',
      { id: 'g1', program: 'C:\\Windows\\System32\\cmd.exe', args: '/c calc' },
      thread()
    )
    expect(openExternal).toHaveBeenCalledWith('image', 'g1', 'C:\\Tools\\gmic_qt.exe', '--x {file}')
    const out = JSON.parse(r.content ?? '{}')
    expect(out).toMatchObject({ status: 'opened', id: 'g1', editor: 'gmic_qt.exe' })
  })

  it('shows the program and picture in the approval question', async () => {
    configure()
    gallery.mockResolvedValue([item('g1', 1)])
    const text = await describeStudioCall('studio_open_in_editor', { id: 'g1' })
    expect(text).toContain('g1')
    expect(text).toContain('C:\\Tools\\gmic_qt.exe')
  })

  it('reports a launch failure from the backend', async () => {
    configure()
    gallery.mockResolvedValue([item('g1', 1)])
    openExternal.mockRejectedValue('That program could not be started.')
    const r = await runStudioTool('studio_open_in_editor', { id: 'g1' }, thread())
    expect(r.error).toMatch(/could not be started/)
  })
})

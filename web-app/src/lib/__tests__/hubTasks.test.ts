import { describe, expect, it } from 'vitest'
import type { HuggingFaceModel } from '@/lib/huggingface'
import {
  MORE_TASKS,
  PRIMARY_TASKS,
  matchesTask,
  type HubTaskId,
} from '@/lib/hubTasks'

const model = (over: Partial<HuggingFaceModel>): HuggingFaceModel => ({
  id: 'org/model',
  downloads: 0,
  likes: 0,
  gated: false,
  tags: [],
  files: [],
  ...over,
})

const match = (m: HuggingFaceModel, task: HubTaskId) =>
  matchesTask(m, m.files, task)

describe('hub task chips', () => {
  it('shows at most six primary chips, All first, with friendly labels', () => {
    expect(PRIMARY_TASKS.length).toBeLessThanOrEqual(6)
    expect(PRIMARY_TASKS[0]).toEqual({ id: 'all', label: 'All' })
    for (const { label } of [...PRIMARY_TASKS, ...MORE_TASKS]) {
      expect(label).not.toMatch(/gguf|safetensors|diffusers|text-generation/i)
    }
  })

  it('all matches everything', () => {
    expect(match(model({}), 'all')).toBe(true)
  })

  it('chat uses pipeline tag or instruct naming and excludes embedders', () => {
    expect(match(model({ pipelineTag: 'text-generation' }), 'chat')).toBe(true)
    expect(match(model({ id: 'org/Foo-7B-Instruct' }), 'chat')).toBe(true)
    expect(
      match(
        model({ pipelineTag: 'text-generation', tags: ['feature-extraction'] }),
        'chat'
      )
    ).toBe(false)
  })

  it('coding, reasoning and tool use read id and tags', () => {
    expect(match(model({ id: 'org/Qwen2.5-Coder-7B' }), 'coding')).toBe(true)
    expect(match(model({ id: 'org/DeepSeek-R1-Distill-8B' }), 'reasoning')).toBe(
      true
    )
    expect(match(model({ tags: ['function-calling'] }), 'tools')).toBe(true)
    expect(match(model({ id: 'org/plain' }), 'coding')).toBe(false)
  })

  it('small & fast is a parameter-size cut', () => {
    expect(match(model({ id: 'org/Foo-3B' }), 'small')).toBe(true)
    expect(match(model({ id: 'org/Foo-70B' }), 'small')).toBe(false)
    expect(match(model({ id: 'org/Foo' }), 'small')).toBe(false)
  })

  it('vision, speech, embeddings map to modalities', () => {
    expect(match(model({ pipelineTag: 'image-text-to-text' }), 'vision')).toBe(
      true
    )
    expect(
      match(model({ tags: ['automatic-speech-recognition'] }), 'speech')
    ).toBe(true)
    expect(match(model({ tags: ['feature-extraction'] }), 'embeddings')).toBe(
      true
    )
    expect(match(model({}), 'vision')).toBe(false)
  })

  it('multilingual, summaries, translation', () => {
    expect(
      match(model({ tags: ['en', 'fr', 'de', 'es'] }), 'multilingual')
    ).toBe(true)
    expect(match(model({ tags: ['en'] }), 'multilingual')).toBe(false)
    expect(match(model({ pipelineTag: 'summarization' }), 'summaries')).toBe(
      true
    )
    expect(match(model({ tags: ['translation'] }), 'translation')).toBe(true)
  })
})

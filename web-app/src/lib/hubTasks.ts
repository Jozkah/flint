import {
  inferModalities,
  inferParameterCount,
  type HuggingFaceFile,
  type HuggingFaceModel,
} from '@/lib/huggingface'

/**
 * Plain-language ways to browse Discover. Each task maps to Hugging Face
 * metadata the search already returns (pipeline tag, tags, model id, parameter
 * count, mmproj files); no raw tag is ever shown to the person.
 */
export type HubTaskId =
  | 'all'
  | 'chat'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'small'
  | 'tools'
  | 'multilingual'
  | 'speech'
  | 'embeddings'
  | 'summaries'
  | 'translation'

export type HubTask = { id: HubTaskId; label: string }

/** Shown in the main row. */
export const PRIMARY_TASKS: HubTask[] = [
  { id: 'all', label: 'All' },
  { id: 'chat', label: 'Chat' },
  { id: 'coding', label: 'Coding' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'vision', label: 'Vision' },
  { id: 'small', label: 'Small & fast' },
]

/** Behind the "More" popover. */
export const MORE_TASKS: HubTask[] = [
  { id: 'tools', label: 'Tool use' },
  { id: 'multilingual', label: 'Multilingual' },
  { id: 'speech', label: 'Speech' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'summaries', label: 'Summaries' },
  { id: 'translation', label: 'Translation' },
]

/** Models at or under this many billion parameters count as small and fast. */
export const SMALL_MODEL_BILLIONS = 4

const LANGUAGE_TAG = /^[a-z]{2,3}$/

export function matchesTask(
  model: HuggingFaceModel,
  files: HuggingFaceFile[],
  task: HubTaskId
): boolean {
  if (task === 'all') return true
  const tags = model.tags.map((tag) => tag.toLowerCase())
  const id = model.id.toLowerCase()
  const pipeline = (model.pipelineTag ?? '').toLowerCase()
  const modalities = inferModalities(model, files)
  switch (task) {
    case 'chat':
      return (
        !modalities.includes('embedding') &&
        (pipeline === 'text-generation' ||
          pipeline === 'image-text-to-text' ||
          tags.includes('conversational') ||
          /instruct|chat|(^|[-_/])it([-_]|$)/.test(id))
      )
    case 'coding':
      return (
        tags.includes('code') ||
        /(^|[-_/])(code|coder|coding|codestral|starcoder|codellama|devstral)/.test(
          id
        )
      )
    case 'reasoning':
      return (
        tags.some((tag) => /reasoning|thinking/.test(tag)) ||
        /reason|think|(^|[-_/])(r1|qwq|o1)([-_]|$)|deepseek-r1/.test(id)
      )
    case 'vision':
      return modalities.includes('vision') || modalities.includes('multimodal')
    case 'small': {
      const size = inferParameterCount(model)
      return size != null && size <= SMALL_MODEL_BILLIONS
    }
    case 'tools':
      return tags.some((tag) => /tool|function-call/.test(tag))
    case 'multilingual':
      return (
        tags.includes('multilingual') ||
        /multiling|(^|[-_/])aya|bloom/.test(id) ||
        tags.filter((tag) => LANGUAGE_TAG.test(tag)).length >= 4
      )
    case 'speech':
      return (
        modalities.includes('audio') ||
        /automatic-speech|text-to-speech|audio/.test(pipeline) ||
        tags.some((tag) => /whisper|text-to-speech|automatic-speech/.test(tag))
      )
    case 'embeddings':
      return modalities.includes('embedding')
    case 'summaries':
      return pipeline === 'summarization' || tags.includes('summarization')
    case 'translation':
      return pipeline === 'translation' || tags.includes('translation')
  }
  return false
}

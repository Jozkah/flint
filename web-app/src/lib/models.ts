import { providerModels as models } from '@/constants/models'
import { ModelCapabilities } from '@/types/models'

/**
 * First model of a provider's built-in cloud catalogue.
 *
 * Local engines (llamacpp, mlx, any OpenAI-compatible server the user added)
 * have no catalogue here, so there is nothing to fall back to and this returns
 * undefined. It used to return `models.openai.models[0]`, which persisted
 * threads pairing a cloud model id such as `gpt-5` with `provider: 'llamacpp'`
 * — an id no local engine can serve. See janhq/jan#8007.
 */
export const defaultModel = (provider?: string): string | undefined => {
  if (!provider) return undefined
  const catalogue = models[provider as unknown as keyof typeof models]
  if (!catalogue) return undefined
  return (catalogue.models as unknown as string[])[0]
}

/**
 * The model id a new thread should carry, in order of trust: the model the user
 * actually selected, then the provider's own first model, then — only for a
 * provider with a built-in cloud catalogue — that catalogue's first entry.
 *
 * Returns undefined when none of those exist. Callers must treat that as "no
 * model to chat with yet" and refuse to create the thread rather than inventing
 * an id the provider cannot serve.
 */
export const resolveThreadModelId = (
  provider: string | undefined,
  selectedModelId: string | undefined,
  providerModelIds: readonly string[] = []
): string | undefined =>
  selectedModelId ?? providerModelIds[0] ?? defaultModel(provider)

/**
 * Determines model capabilities based on provider configuration from token.js
 * @param providerName - The provider name (e.g., 'openai', 'anthropic', 'openrouter')
 * @param modelId - The model ID to check capabilities for
 * @returns Array of model capabilities
 */
export const getModelCapabilities = (
  providerName: string,
  modelId: string
): string[] => {
  const providerConfig = models[providerName as unknown as keyof typeof models]

  const supportsToolCalls = Array.isArray(
    providerConfig?.supportsToolCalls as unknown
  )
    ? (providerConfig.supportsToolCalls as unknown as string[])
    : []

  const supportsImages = Array.isArray(
    providerConfig?.supportsImages as unknown
  )
    ? (providerConfig.supportsImages as unknown as string[])
    : []

  return [
    ModelCapabilities.COMPLETION,
    supportsToolCalls.includes(modelId) ? ModelCapabilities.TOOLS : undefined,
    supportsImages.includes(modelId) ? ModelCapabilities.VISION : undefined,
  ].filter(Boolean) as string[]
}

/**
 * This utility is to extract cortexso model description from README.md file
 * @returns
 */
export const extractDescription = (text?: string) => {
  if (!text) return text
  const normalizedText = removeYamlFrontMatter(text)
  const overviewPattern = /(?:##\s*Overview\s*\n)([\s\S]*?)(?=\n\s*##|$)/
  const matches = normalizedText?.match(overviewPattern)
  let extractedText =
    matches && matches[1]
      ? matches[1].trim()
      : normalizedText?.slice(0, 500).trim()

  // Remove image markdown syntax ![alt text](image-url)
  extractedText = extractedText?.replace(/!\[.*?\]\(.*?\)/g, '')

  // Remove <img> HTML tags
  extractedText = extractedText?.replace(/<img[^>]*>/g, '')

  return extractedText
}
/**
 * Remove YAML (HF metadata) front matter from content
 * @param content
 * @returns
 */
export const removeYamlFrontMatter = (content: string): string => {
  return content.replace(/^---\n([\s\S]*?)\n---\n/, '')
}

/**
 * Extract model name from repo path, e.g. cortexso/tinyllama -> tinyllama
 * @param modelId
 * @returns
 */
export const extractModelName = (model?: string) => {
  return model?.split('/')[1] ?? model
}

/**
 * Extract model name from repo path, e.g. https://huggingface.co/cortexso/tinyllama -> cortexso/tinyllama
 * @param modelId
 * @returns
 */
export const extractModelRepo = (model?: string) => {
  return model?.replace('https://huggingface.co/', '')
}

export const selectDefaultQuant = <T extends { model_id: string }>(
  quants: T[] | undefined,
  preferred: readonly string[]
): T | undefined => {
  if (!quants?.length) return undefined
  return (
    quants.find((q) =>
      preferred.some((p) => q.model_id.toLowerCase().includes(p))
    ) ?? quants[0]
  )
}

export const extractQuantLabel = (modelId?: string): string | null => {
  if (!modelId) return null
  const match = modelId.match(
    /(IQ\d+(?:_[A-Z0-9]+)+|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)(?:[-_.][^-_.]*)?$/i
  )
  return match ? match[1].toUpperCase() : null
}

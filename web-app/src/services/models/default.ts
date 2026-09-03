import type { SpecDraftKind } from '@janhq/core'
/**
 * Default Models Service - Web implementation
 */

import {
  AIEngine,
  EngineManager,
  SessionInfo,
  SettingComponentProps,
  modelInfo,
  ThreadMessage,
  ContentType,
  UnloadResult,
} from '@janhq/core'
import { Model as CoreModel } from '@janhq/core'
import type {
  ModelsService,
  ModelValidationResult,
  EmbeddingModelReport,
  GpuOffloadReport,
} from './types'
import {
  extractToolContextFromContent,
  extractToolContextFromMetadata,
} from './tokenCountToolContext'

// TODO: Replace this with the actual provider later
const defaultProvider = 'llamacpp'

export class DefaultModelsService implements ModelsService {
  private getEngine(provider: string = defaultProvider) {
    return EngineManager.instance().get(provider) as AIEngine | undefined
  }

  async getModel(modelId: string): Promise<modelInfo | undefined> {
    return this.getEngine()?.get(modelId)
  }

  async fetchModels(): Promise<modelInfo[]> {
    return this.getEngine()?.list() ?? []
  }

  /**
   * Import a model that is already on this machine.
   *
   * The engines refuse a URL, so this is the manual-import path and nothing
   * else: no catalogue, no fetch.
   */
  async pullModel(
    id: string,
    modelPath: string,
    modelSha256?: string,
    modelSize?: number,
    mmprojPath?: string,
    mmprojSha256?: string,
    mmprojSize?: number,
    specDraftPath?: string,
    specDraftKind?: SpecDraftKind
  ): Promise<void> {
    return this.getEngine()?.import(id, {
      modelPath,
      mmprojPath,
      modelSha256,
      modelSize,
      mmprojSha256,
      mmprojSize,
      specDraftPath,
      specDraftKind,
    })
  }

  async updateModel(modelId: string, model: Partial<CoreModel>): Promise<void> {
    if (model.settings) {
      this.getEngine()?.updateSettings(
        model.settings as SettingComponentProps[]
      )
    }
    // Note: Model name/ID updates are handled at the provider level in the frontend
    // The engine doesn't have an update method for model metadata
    console.log('Model update request processed for modelId:', modelId)
  }

  async deleteModel(id: string, provider?: string): Promise<void> {
    return this.getEngine(provider)?.delete(id)
  }

  async getActiveModels(provider?: string): Promise<string[]> {
    return this.getEngine(provider)?.getLoadedModels() ?? []
  }

  async stopModel(
    model: string,
    provider?: string
  ): Promise<UnloadResult | undefined> {
    return this.getEngine(provider)?.unload(model)
  }

  async stopAllModels(): Promise<void> {
    const llamaCppModels = await this.getActiveModels('llamacpp')
    if (llamaCppModels)
      await Promise.all(
        llamaCppModels.map((model) => this.stopModel(model, 'llamacpp'))
      )
    const mlxModels = await this.getActiveModels('mlx')
    if (mlxModels)
      await Promise.all(mlxModels.map((model) => this.stopModel(model, 'mlx')))
  }

  async startModel(
    provider: ProviderObject,
    model: string,
    bypassAutoUnload: boolean = false
  ): Promise<SessionInfo | undefined> {
    const engine = this.getEngine(provider.provider)
    if (!engine) return undefined

    const loadedModels = await engine.getLoadedModels()
    if (loadedModels.includes(model)) return undefined

    // Find the model configuration to get settings
    const modelConfig = provider.models.find((m) => m.id === model)

    // Key mapping function to transform setting keys
    const mapSettingKey = (key: string): string => {
      const keyMappings: Record<string, string> = {
        ctx_len: 'ctx_size',
        ngl: 'n_gpu_layers',
      }
      return keyMappings[key] || key
    }

    const settings = modelConfig?.settings
      ? Object.fromEntries(
          Object.entries(modelConfig.settings).map(([key, value]) => [
            mapSettingKey(key),
            value.controller_props?.value,
          ])
        )
      : undefined

    return engine
      .load(model, settings, false, bypassAutoUnload)
      .catch((error) => {
        console.error(
          `Failed to start model ${model} for provider ${provider.provider}:`,
          error
        )
        throw error
      })
  }

  private reloadingModels = new Map<
    string,
    Promise<SessionInfo | undefined>
  >()

  // Force unload first: a crashed model still reports "loaded", so load() alone no-ops.
  async reloadModel(
    provider: ProviderObject,
    model: string
  ): Promise<SessionInfo | undefined> {
    const key = `${provider.provider}:${model}`
    const inflight = this.reloadingModels.get(key)
    if (inflight) return inflight
    const p = (async () => {
      await this.stopModel(model, provider.provider).catch(() => {})
      return this.startModel(provider, model)
    })().finally(() => this.reloadingModels.delete(key))
    this.reloadingModels.set(key, p)
    return p
  }

  async isToolSupported(modelId: string): Promise<boolean> {
    const engine = this.getEngine()
    if (!engine) return false

    return engine.isToolSupported(modelId)
  }

  async checkMmprojExistsAndUpdateOffloadMMprojSetting(
    modelId: string,
    updateProvider?: (
      providerName: string,
      data: Partial<ModelProvider>
    ) => void,
    getProviderByName?: (providerName: string) => ModelProvider | undefined
  ): Promise<{ exists: boolean; settingsUpdated: boolean }> {
    let settingsUpdated = false

    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        checkMmprojExists?: (id: string) => Promise<boolean>
      }
      if (engine && typeof engine.checkMmprojExists === 'function') {
        const exists = await engine.checkMmprojExists(modelId)

        // If we have the store functions, use them; otherwise fall back to localStorage
        if (updateProvider && getProviderByName) {
          const provider = getProviderByName('llamacpp')
          if (provider) {
            const model = provider.models.find((m) => m.id === modelId)

            if (model?.settings) {
              const hasOffloadMmproj = 'offload_mmproj' in model.settings

              // If mmproj exists, add offload_mmproj setting (only if it doesn't exist)
              if (exists && !hasOffloadMmproj) {
                // Create updated models array with the new setting
                const updatedModels = provider.models.map((m) => {
                  if (m.id === modelId) {
                    return {
                      ...m,
                      settings: {
                        ...m.settings,
                        offload_mmproj: {
                          key: 'offload_mmproj',
                          title: 'Offload MMProj',
                          description:
                            'Offload multimodal projection model to GPU',
                          controller_type: 'checkbox',
                          controller_props: {
                            value: true,
                          },
                        },
                      },
                    }
                  }
                  return m
                })

                // Update the provider with the new models array
                updateProvider('llamacpp', { models: updatedModels })
                settingsUpdated = true
              }
            }
          }
        } else {
          // Fall back to localStorage approach for backwards compatibility
          try {
            const modelProviderData = JSON.parse(
              localStorage.getItem('model-provider') || '{}'
            )
            const llamacppProvider = modelProviderData.state?.providers?.find(
              (p: { provider: string }) => p.provider === 'llamacpp'
            )
            const model = llamacppProvider?.models?.find(
              (m: { id: string; settings?: Record<string, unknown> }) =>
                m.id === modelId
            )

            if (model?.settings) {
              // If mmproj exists, add offload_mmproj setting (only if it doesn't exist)
              if (exists) {
                if (!model.settings.offload_mmproj) {
                  model.settings.offload_mmproj = {
                    key: 'offload_mmproj',
                    title: 'Offload MMProj',
                    description: 'Offload multimodal projection layers to GPU',
                    controller_type: 'checkbox',
                    controller_props: {
                      value: true,
                    },
                  }
                  // Save updated settings back to localStorage
                  localStorage.setItem(
                    'model-provider',
                    JSON.stringify(modelProviderData)
                  )
                  settingsUpdated = true
                }
              }
            }
          } catch (localStorageError) {
            console.error(
              `Error checking localStorage for model ${modelId}:`,
              localStorageError
            )
          }
        }

        return { exists, settingsUpdated }
      }
    } catch (error) {
      console.error(`Error checking mmproj for model ${modelId}:`, error)
    }
    return { exists: false, settingsUpdated }
  }

  async checkMmprojExists(modelId: string): Promise<boolean> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        checkMmprojExists?: (id: string) => Promise<boolean>
      }
      if (engine && typeof engine.checkMmprojExists === 'function') {
        return await engine.checkMmprojExists(modelId)
      }
    } catch (error) {
      console.error(`Error checking mmproj for model ${modelId}:`, error)
    }
    return false
  }

  async getMtpInfo(modelId: string): Promise<{
    mtp_layers: number
    mtp: boolean
    spec_draft_n_max?: number
    spec_draft_n_min?: number
    spec_draft_p_min?: number
  }> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        getMtpInfo?: (id: string) => Promise<{
          mtp_layers: number
          mtp: boolean
          spec_draft_n_max?: number
          spec_draft_n_min?: number
          spec_draft_p_min?: number
        }>
      }
      if (engine && typeof engine.getMtpInfo === 'function') {
        return await engine.getMtpInfo(modelId)
      }
    } catch (error) {
      console.error(`Error reading MTP info for ${modelId}:`, error)
    }
    return { mtp_layers: 0, mtp: false }
  }

  async updateMtpSettings(
    modelId: string,
    patch: {
      mtp?: boolean
      spec_draft_n_max?: number | null
      spec_draft_n_min?: number | null
      spec_draft_p_min?: number | null
    }
  ): Promise<void> {
    const engine = this.getEngine('llamacpp') as AIEngine & {
      updateMtpSettings?: (
        id: string,
        patch: {
          mtp?: boolean
          spec_draft_n_max?: number | null
          spec_draft_n_min?: number | null
          spec_draft_p_min?: number | null
        }
      ) => Promise<void>
    }
    if (engine && typeof engine.updateMtpSettings === 'function') {
      await engine.updateMtpSettings(modelId, patch)
    }
  }

  async updateModelSettings(
    modelId: string,
    patch: Record<string, string | number | boolean | null | undefined>
  ): Promise<void> {
    const engine = this.getEngine('llamacpp') as AIEngine & {
      updateModelSettings?: (
        id: string,
        patch: Record<string, string | number | boolean | null | undefined>
      ) => Promise<void>
    }
    if (engine && typeof engine.updateModelSettings === 'function') {
      await engine.updateModelSettings(modelId, patch)
    }
  }

  async isModelSupported(
    modelPath: string,
    ctxSize?: number
  ): Promise<'RED' | 'YELLOW' | 'GREEN' | 'GREY'> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        isModelSupported?: (
          path: string,
          ctx_size?: number
        ) => Promise<'RED' | 'YELLOW' | 'GREEN'>
      }
      if (engine && typeof engine.isModelSupported === 'function') {
        return await engine.isModelSupported(modelPath, ctxSize)
      }
      // Fallback if method is not available
      console.warn('isModelSupported method not available in llamacpp engine')
      return 'YELLOW' // Conservative fallback
    } catch (error) {
      console.error(`Error checking model support for ${modelPath}:`, error)
      return 'GREY' // Error state, assume not supported
    }
  }

  async verifyEmbeddingModel(): Promise<EmbeddingModelReport> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        verifyEmbeddingModel?: () => Promise<EmbeddingModelReport>
      }
      if (engine && typeof engine.verifyEmbeddingModel === 'function') {
        return await engine.verifyEmbeddingModel()
      }
      return { status: 'warning', unavailable: true }
    } catch (error) {
      return {
        status: 'warning',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Asks the local engine to begin its first-run provisioning (backend download,
   * router start, embedding model). Deliberately fire-and-forget from the
   * caller's point of view: progress is reported by the readiness checks, and a
   * failure here must not stop the setup screen from advancing.
   */
  async startEngineSetup(): Promise<void> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        startFirstRunSetup?: () => Promise<void>
      }
      if (engine && typeof engine.startFirstRunSetup === 'function') {
        await engine.startFirstRunSetup()
      }
    } catch (error) {
      console.warn('Failed to start engine setup:', error)
    }
  }

  async verifyGpuOffload(): Promise<GpuOffloadReport> {
    const unknown: GpuOffloadReport = {
      status: 'warning',
      backend: '',
      gpuExpected: false,
      engineDeviceCount: 0,
    }
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        verifyGpuOffload?: () => Promise<GpuOffloadReport>
      }
      if (engine && typeof engine.verifyGpuOffload === 'function') {
        return await engine.verifyGpuOffload()
      }
      return { ...unknown, unavailable: true }
    } catch (error) {
      return {
        ...unknown,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async validateGgufFile(filePath: string): Promise<ModelValidationResult> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        validateGgufFile?: (path: string) => Promise<ModelValidationResult>
      }

      if (engine && typeof engine.validateGgufFile === 'function') {
        return await engine.validateGgufFile(filePath)
      }

      // If the specific method isn't available, we can fallback to a basic check
      console.warn('validateGgufFile method not available in llamacpp engine')
      return {
        isValid: true, // Assume valid for now
        error: 'Validation method not available',
      }
    } catch (error) {
      console.error(`Error validating GGUF file ${filePath}:`, error)
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async getTokensCount(
    modelId: string,
    messages: ThreadMessage[]
  ): Promise<number> {
    try {
      const engine = this.getEngine('llamacpp') as AIEngine & {
        getTokensCount?: (opts: {
          model: string
          messages: Array<{
            role: string
            content:
              | string
              | Array<{
                  type: string
                  text?: string
                  image_url?: {
                    detail?: string
                    url?: string
                  }
                }>
          }>
          chat_template_kwargs?: {
            enable_thinking: boolean
          }
        }) => Promise<number>
      }

      if (engine && typeof engine.getTokensCount === 'function') {
        // Transform Jan's ThreadMessage format to OpenAI chat completion format
        const transformedMessages = messages
          .map((message) => {
            // Handle different content types
            let content:
              | string
              | Array<{
                  type: string
                  text?: string
                  image_url?: {
                    detail?: string
                    url?: string
                  }
                }> = ''

            if (message.content && message.content.length > 0) {
              // Check if there are any image_url content types
              const hasImages = message.content.some(
                (content) => content.type === ContentType.Image
              )

              if (hasImages) {
                // For multimodal messages, preserve the array structure
                content = message.content.map((contentItem) => {
                  if (contentItem.type === ContentType.Text) {
                    return {
                      type: 'text',
                      text: contentItem.text?.value || '',
                    }
                  } else if (contentItem.type === ContentType.Image) {
                    return {
                      type: 'image_url',
                      image_url: {
                        detail: contentItem.image_url?.detail,
                        url: contentItem.image_url?.url || '',
                      },
                    }
                  }
                  // Fallback for unknown content types
                  return {
                    type: contentItem.type,
                    text: contentItem.text?.value,
                    image_url: contentItem.image_url,
                  }
                })
              } else {
                // For text-only messages, keep the string format
                const textContents = message.content
                  .filter(
                    (content) =>
                      content.type === ContentType.Text && content.text?.value
                  )
                  .map((content) => content.text?.value || '')

                content = textContents.join(' ')
              }
            }

            const toolContextFromContent = extractToolContextFromContent(message)
            const toolContextFromMetadata =
              toolContextFromContent.length > 0
                ? ''
                : extractToolContextFromMetadata(message)
            const toolContext = [toolContextFromContent, toolContextFromMetadata]
              .filter((entry) => entry.length > 0)
              .join('\n\n')
            if (toolContext.length > 0) {
              if (typeof content === 'string') {
                content = content ? `${content}\n\n${toolContext}` : toolContext
              } else if (Array.isArray(content)) {
                content = [
                  ...content,
                  {
                    type: 'text',
                    text: toolContext,
                  },
                ]
              }
            }

            return {
              role: message.role,
              content,
            }
          })
          .filter((msg) =>
            typeof msg.content === 'string'
              ? msg.content.trim() !== ''
              : Array.isArray(msg.content) && msg.content.length > 0
          ) // Filter out empty messages

        return await engine.getTokensCount({
          model: modelId,
          messages: transformedMessages,
          chat_template_kwargs: {
            enable_thinking: false,
          },
        })
      }

      // Fallback if method is not available
      console.warn('getTokensCount method not available in llamacpp engine')
      return 0
    } catch (error) {
      console.error(`Error getting tokens count for model ${modelId}:`, error)
      return 0
    }
  }
}

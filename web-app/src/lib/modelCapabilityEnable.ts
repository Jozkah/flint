export type EnableableCapability = 'tools' | 'vision' | 'audio' | 'video'

/** Keep existing model metadata while recording an explicit user choice. */
export function enableModelCapabilities(
  models: Model[],
  modelId: string,
  capabilities: readonly EnableableCapability[]
): Model[] {
  return models.map((model) =>
    model.id === modelId
      ? {
          ...model,
          capabilities: Array.from(
            new Set([...(model.capabilities ?? []), ...capabilities])
          ),
          _userConfiguredCapabilities: true,
        }
      : model
  )
}

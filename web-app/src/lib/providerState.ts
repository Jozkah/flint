import { API_KEY_FALLBACKS_SETTING_KEY } from '@/lib/provider-api-keys'
import { withoutSecretValues } from '@/lib/customHeaders'

const API_KEY_SETTING_KEY = 'api-key'

// Secrets live only in the OS keyring (see register_provider_config), never in
// persisted settings storage. Strip the key chain from every provider before it
// is written to disk; the in-memory object keeps the keys (re-seeded from the
// keyring at boot in DataProvider) so synchronous consumers still work.
export function stripProviderSecrets(provider: ModelProvider): ModelProvider {
  const settings = provider.settings?.map((s) =>
    s.key === API_KEY_SETTING_KEY || s.key === API_KEY_FALLBACKS_SETTING_KEY
      ? { ...s, controller_props: { ...s.controller_props, value: '' } }
      : s
  )
  return {
    ...provider,
    api_key: undefined,
    api_key_fallbacks: undefined,
    ...(settings ? { settings } : {}),
    // A custom header marked secret is a credential too. janhq/jan#8208.
    ...(provider.custom_header
      ? { custom_header: withoutSecretValues(provider.custom_header) }
      : {}),
  }
}

// A model's id is its identity within a provider: lookups find by id and the
// model lists key rows on it. Keep the first occurrence (carries user edits).
export function uniqueModelsById(models: Model[]): Model[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

// Strings are legacy global tombstones (persisted before provider-scoped
// records, with no way to tell their owner); new deletions always carry the
// provider that owned the model (janhq/jan#9336).
export type DeletedModel = string | { provider: string; id: string }

export function isDeleted(entry: DeletedModel, provider: string, id: string): boolean {
  return typeof entry === 'string'
    ? entry === id
    : entry.provider === provider && entry.id === id
}

export type ModelProviderState = {
  providers: ModelProvider[]
  selectedProvider: string
  selectedModel: Model | null
  deletedModels: DeletedModel[]
  getModelBy: (modelId: string, providerName?: string) => Model | undefined
  setProviders: (providers: ModelProvider[]) => void
  getProviderByName: (providerName: string) => ModelProvider | undefined
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  selectModelProvider: (
    providerName: string,
    modelName: string
  ) => Model | undefined
  addProvider: (provider: ModelProvider) => void
  deleteProvider: (providerName: string) => void
  deleteModel: (modelId: string, provider: string) => void
  addDeletedModels: (modelIds: string[], provider: string) => void
}

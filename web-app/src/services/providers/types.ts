/**
 * Providers Service Types
 */

export interface ProvidersService {
  getProviders(): Promise<ModelProvider[]>
  fetchModelsFromProvider(provider: ModelProvider): Promise<string[]>
  /**
   * The provider's own `/models` entry for one model (context window and the
   * like), or null when it lists none. Optional: only the desktop service
   * reaches a provider.
   */
  fetchModelEntry?(
    provider: ModelProvider,
    modelId: string
  ): Promise<Record<string, unknown> | null>
  updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void>
  /**
   * Permanently delete a provider's stored API key chain from the OS keyring.
   * Explicit, user-initiated only (provider removal / key clear) — never called
   * during boot reconciliation, which must not destroy stored secrets.
   */
  deleteProviderKeys(providerName: string): Promise<void>
  fetch(): typeof fetch
}

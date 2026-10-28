/**
 * Default Providers Service - Generic implementation with minimal returns
 */

import type { ProvidersService } from './types'

export class DefaultProvidersService implements ProvidersService {
  async getProviders(): Promise<ModelProvider[]> {
    return []
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    void provider
    return []
  }

  async updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void> {
    void providerName
    void settings
    // No-op - not implemented in default service
  }

  async deleteProviderKeys(providerName: string): Promise<void> {
    console.log('deleteProviderKeys called:', { providerName })
    // No-op - no keyring on the default (web) service
  }

  fetch(): typeof fetch {
    return fetch
  }
}

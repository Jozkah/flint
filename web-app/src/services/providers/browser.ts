/**
 * Browser Providers Service - provider requests run on the Flint server.
 *
 * Model discovery and chat completions go through the server's copy of the
 * provider transport, so the browser never needs CORS access to a provider and
 * the endpoint-resolution rules match the desktop app. API keys are stored by
 * the server (keyring or encrypted file), not by the browser.
 */

import { hostInvoke } from '@/lib/hostInvoke'
import { providerFetch } from '@/lib/providerFetch'
import { TauriProvidersService } from './tauri'

export class BrowserProvidersService extends TauriProvidersService {
  fetch(): typeof fetch {
    return providerFetch as typeof fetch
  }

  async deleteProviderKeys(providerName: string): Promise<void> {
    try {
      await hostInvoke('delete_provider_keys', { provider: providerName })
    } catch (error) {
      console.error(`Failed to delete stored keys for ${providerName}:`, error)
    }
  }
}

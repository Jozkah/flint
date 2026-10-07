/**
 * Browser Providers Service - provider requests run on the Flint server.
 *
 * Model discovery and chat completions go through the server's copy of the
 * provider transport, so the browser never needs CORS access to a provider and
 * the endpoint-resolution rules match the desktop app. There is no OS keyring
 * in a browser: keys stay in the page's own settings, so clearing them has
 * nothing further to delete.
 */

import { providerFetch } from '@/lib/providerFetch'
import { TauriProvidersService } from './tauri'

export class BrowserProvidersService extends TauriProvidersService {
  fetch(): typeof fetch {
    return providerFetch as typeof fetch
  }

  async deleteProviderKeys(): Promise<void> {}
}

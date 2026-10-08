/**
 * Browser App Service - facts about the Flint server the page is served by.
 * Factory reset, data-folder relocation and background-run settings change the
 * machine the server runs on, so they stay with the desktop app.
 */

import { browserApi } from '@/services/browserApi'
import { DefaultAppService } from './default'

type AppInfo = { dataFolder: string; version: string; headless: boolean }

export class BrowserAppService extends DefaultAppService {
  async getJanDataFolder(): Promise<string | undefined> {
    return (await browserApi<AppInfo>('/api/v1/app/info')).dataFolder
  }

  async getServerStatus(): Promise<boolean> {
    return true
  }
}

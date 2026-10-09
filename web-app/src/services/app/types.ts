/**
 * App Service Types
 */

export interface LogEntry {
  timestamp: string | number
  level: 'info' | 'warn' | 'error' | 'debug'
  target: string
  message: string
}

export interface FactoryResetOptions {
  keepAppData: boolean
  keepModelsAndConfigs: boolean
  clearWebData?: boolean
}

export interface AppService {
  factoryReset(options?: FactoryResetOptions): Promise<void>
  readLogs(): Promise<LogEntry[]>
  parseLogLine(line: string): LogEntry
  getJanDataFolder(): Promise<string | undefined>
  /**
   * The saved data folder when it could not be used this run (a disconnected
   * drive, a renamed profile) and the default folder is in use instead.
   */
  getUnavailableJanDataFolder(): Promise<string | undefined>
  relocateJanDataFolder(path: string): Promise<void>
  getServerStatus(): Promise<boolean>
  setServerRunInBackground(enabled: boolean): Promise<void>
  setCloseToTray(enabled: boolean): Promise<void>
  /** Cap model downloads at this many bytes per second; 0 is unlimited. */
  setDownloadSpeedLimit(bytesPerSec: number): Promise<void>
  /** Write the redacted app log to `destination`; returns the path written. */
  exportRedactedLogs(destination: string): Promise<string>
  readYaml<T = unknown>(path: string): Promise<T>
}

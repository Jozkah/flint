/**
 * App Service Types
 */

/** The Hugging Face endpoint chosen in Settings ('' is huggingface.co). */
export interface HfEndpointSetting {
  endpoint: string
  /** Send the Hugging Face token to a mirror too; off by default. */
  sendTokenToMirror: boolean
  /** The HF_ENDPOINT environment value, which wins over the setting. */
  envOverride: string | null
}

export interface LogEntry {
  timestamp: string | number
  level: 'info' | 'warn' | 'error' | 'debug'
  target: string
  message: string
}

/** Log lines read since an offset; see `AppService.readLogsSince`. */
export interface LogChunk {
  entries: LogEntry[]
  /** Pass back on the next call to read only what was appended. */
  offset: number
  /** The entries replace what is shown (first read, or the log rotated). */
  reset: boolean
}

export interface FactoryResetOptions {
  keepAppData: boolean
  keepModelsAndConfigs: boolean
  clearWebData?: boolean
}

export interface AppService {
  factoryReset(options?: FactoryResetOptions): Promise<void>
  readLogs(): Promise<LogEntry[]>
  /** The log lines appended since `offset`; with none, the log's tail. */
  readLogsSince(offset?: number): Promise<LogChunk>
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
  /** The Hugging Face endpoint chosen in Settings, and any HF_ENDPOINT override. */
  getHfEndpointSetting(): Promise<HfEndpointSetting>
  /** Save the endpoint ('' is huggingface.co); rejects an invalid URL. */
  setHfEndpointSetting(
    endpoint: string,
    sendTokenToMirror: boolean
  ): Promise<void>
  /** Write the redacted app log to `destination`; returns the path written. */
  exportRedactedLogs(): Promise<string | null>
  /** Save a diagnostic bundle (.tar.gz) where the user picks; null if cancelled. */
  exportDiagnosticBundle(): Promise<string | null>
  readYaml<T = unknown>(path: string): Promise<T>
}

import { invokeCommand } from '@/lib/backend'
// Tauri commands for remote access (src-tauri/src/core/remote/commands.rs).

export type RemoteInterface = 'tailscale' | 'lan' | 'localhost'
export type RemoteTlsSource = 'custom' | 'tailscale' | 'self_signed' | 'none'

export type RemoteConfig = {
  enabled: boolean
  interface: RemoteInterface
  port: number
  certPath: string | null
  keyPath: string | null
  /** A DNS name of the user's own for this computer; phones connect to it. */
  customHost?: string | null
  allowApprovals: boolean
  allowAlwaysAllow: boolean
  /** Largest file a phone may upload, MiB. */
  maxUploadMb?: number
  /** Paired phones may view the Cowork session's live preview. */
  allowPreviewProxy?: boolean
}

export type RemoteServeInfo = {
  address: string
  host: string
  port: number
  https: boolean
  tlsSource: RemoteTlsSource
  fingerprint: string | null
  baseUrl: string
}

export type RemoteStatus = {
  config: RemoteConfig
  running: boolean
  serving: RemoteServeInfo | null
  error: string | null
  detected: { tailscale: string | null; lan: string | null }
  pairedDevices: number
  connectedDevices: number
  /** Whether this install has the phone app's files; false means phones get
   * a placeholder page. Absent from an older backend. */
  phoneApp?: boolean
  /** Where they were looked for, when missing. */
  phoneAppPaths?: string[]
}

export type RemoteDevice = {
  id: string
  name: string
  pairedAt: number
  lastSeen: number | null
  connected: boolean
}

export type RemotePairing = {
  code: string
  confirmNumber: string
  expiresInMs: number
  url: string
}

export type RemotePairingRequest = {
  requestId: string
  deviceName: string
  confirmNumber: string
}

/** A phone's finished upload, as `remote_upload_take` returns it. */
export type RemoteUploadedFile = {
  id: string
  name: string
  size: number
  mime: string
  path: string
  dataUrl: string | null
}

export const remoteApi = {
  getStatus: () => invokeCommand<RemoteStatus>('remote_get_status'),
  setConfig: (config: RemoteConfig) =>
    invokeCommand<RemoteStatus>('remote_set_config', { config }),
  startPairing: () => invokeCommand<RemotePairing>('remote_start_pairing'),
  cancelPairing: () => invokeCommand<void>('remote_cancel_pairing'),
  confirmPairing: (requestId: string, approve: boolean) =>
    invokeCommand<RemoteDevice | null>('remote_confirm_pairing', { requestId, approve }),
  listDevices: () => invokeCommand<RemoteDevice[]>('remote_list_devices'),
  revokeDevice: (id: string) => invokeCommand<boolean>('remote_revoke_device', { id }),
  rpcRespond: (
    id: string,
    reply: { result?: unknown; error?: { code: string; message: string } }
  ) => invokeCommand<boolean>('remote_rpc_respond', { id, ...reply }),
  emitEvent: (event: unknown, topic?: string) =>
    invokeCommand<void>('remote_emit_event', { event, topic: topic ?? null }),
  takeUploads: (deviceId: string, ids: string[]) =>
    invokeCommand<RemoteUploadedFile[]>('remote_upload_take', { deviceId, ids }),
  setPreview: (sessionId: string | null, url: string | null) =>
    invokeCommand<void>('remote_set_preview', { sessionId, url }),
}

export type RemoteApi = typeof remoteApi

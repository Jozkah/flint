import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { remoteApi, type RemotePairingRequest } from '@/lib/remote/api'
import { dispatchRemoteRpc } from '@/lib/remote/bridge'
import { createRemoteHandlers } from '@/lib/remote/handlers'
import { appSources } from '@/lib/remote/sources'
import { appActions } from '@/lib/remote/appActions'
import { appExtras } from '@/lib/remote/appExtras'
import { appArchive } from '@/lib/remote/appArchive'
import { appStudio, appVoice, startStudioForwarding } from '@/lib/remote/appStudio'
import { startRemoteEventForwarding } from '@/lib/remote/events'
import {
  REMOTE_EVENT_DEVICES_CHANGED,
  REMOTE_EVENT_PAIRING_REQUEST,
  REMOTE_EVENT_RPC,
  type RemoteRpcRequest,
} from '@/lib/remote/protocol'
import { useRemoteAccess } from '@/hooks/useRemoteAccess'

/**
 * The window's end of remote access, mounted once in the app shell: answers
 * phones' RPCs, surfaces pairing requests, and forwards events while at least
 * one phone is connected (no IPC traffic otherwise).
 */
export function useRemoteBridge() {
  const connected = useRemoteAccess((s) => s.status?.connectedDevices ?? 0)
  const navigate = useNavigate()

  useEffect(() => {
    if (!IS_TAURI) return
    const handlers = createRemoteHandlers(
      appSources,
      appActions((to) => navigate(to as Parameters<typeof navigate>[0])),
      appExtras,
      appStudio,
      appVoice,
      appArchive
    )
    let cancelled = false
    const offs: (() => void)[] = []
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const subs = await Promise.all([
        listen<RemoteRpcRequest>(REMOTE_EVENT_RPC, async ({ payload }) => {
          const reply = await dispatchRemoteRpc(payload, handlers)
          await remoteApi.rpcRespond(payload.id, reply).catch(() => {})
        }),
        listen<RemotePairingRequest>(REMOTE_EVENT_PAIRING_REQUEST, ({ payload }) =>
          useRemoteAccess.getState().setPairingRequest(payload)
        ),
        listen(REMOTE_EVENT_DEVICES_CHANGED, () => {
          void useRemoteAccess.getState().refresh().catch(() => {})
        }),
      ])
      if (cancelled) subs.forEach((off) => off())
      else offs.push(...subs)
    })()
    void useRemoteAccess.getState().refresh().catch(() => {})
    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [navigate])

  useEffect(() => {
    if (!IS_TAURI || connected === 0) return
    const emit = (event: Parameters<typeof remoteApi.emitEvent>[0], topic?: string) => {
      void remoteApi.emitEvent(event, topic).catch(() => {})
    }
    const stops = [startRemoteEventForwarding(emit), startStudioForwarding(emit)]
    return () => stops.forEach((stop) => stop())
  }, [connected])
}

import { create } from 'zustand'
import {
  remoteApi,
  type RemoteDevice,
  type RemotePairingRequest,
  type RemoteStatus,
} from '@/lib/remote/api'

/**
 * Remote access as the window sees it: the listener's status, the paired
 * phones, and a phone waiting for the user to confirm pairing. The settings
 * live in the backend (`core::remote`), which owns them; this only mirrors.
 */
type RemoteAccessState = {
  status: RemoteStatus | null
  devices: RemoteDevice[]
  pairingRequest: RemotePairingRequest | null
  /** Set when a confirmed pairing lands, so the Pair dialog can say so. */
  lastPaired: RemoteDevice | null
  refresh: () => Promise<void>
  setPairingRequest: (req: RemotePairingRequest | null) => void
  setLastPaired: (device: RemoteDevice | null) => void
}

export const useRemoteAccess = create<RemoteAccessState>()((set) => ({
  status: null,
  devices: [],
  pairingRequest: null,
  lastPaired: null,
  refresh: async () => {
    const [status, devices] = await Promise.all([
      remoteApi.getStatus(),
      remoteApi.listDevices(),
    ])
    set({ status, devices })
  },
  setPairingRequest: (pairingRequest) => set({ pairingRequest }),
  setLastPaired: (lastPaired) => set({ lastPaired }),
}))

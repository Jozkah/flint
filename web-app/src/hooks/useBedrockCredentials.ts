import { create } from 'zustand'
import { getBedrockCredentialStatus } from '@/lib/bedrock'
import { setBedrockCredentialsSaved } from '@/lib/providerReadiness'

/**
 * Whether the AWS access key id and secret are saved in the keyring, for the
 * provider list's status chip. Only the fact, never a value.
 */
interface BedrockCredentialsState {
  saved: boolean
  refresh: () => Promise<void>
}

export const useBedrockCredentials = create<BedrockCredentialsState>()((set) => ({
  saved: false,
  refresh: async () => {
    const status = await getBedrockCredentialStatus()
    const saved = status.access_key_id && status.secret_access_key
    setBedrockCredentialsSaved(saved)
    set({ saved })
  },
}))

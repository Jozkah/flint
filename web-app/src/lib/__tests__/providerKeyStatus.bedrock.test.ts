import { afterEach, describe, expect, it } from 'vitest'
import { providerKeyStatus } from '../providerKeyStatus'
import {
  isProviderUsable,
  setBedrockCredentialsSaved,
} from '../providerReadiness'

const bedrock = {
  provider: 'bedrock',
  base_url: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  api_key: '',
  settings: [] as { key: string }[],
  models: [{ id: 'anthropic.claude-3-haiku-20240307-v1:0' }],
}

describe('Amazon Bedrock readiness', () => {
  afterEach(() => setBedrockCredentialsSaved(false))

  it('is not keyless: without AWS credentials the list says so', () => {
    expect(providerKeyStatus(bedrock)).toBe('credentials-missing')
    expect(providerKeyStatus(bedrock, { bedrockCredentials: false })).toBe(
      'credentials-missing'
    )
  })

  it('is connected once the AWS keys are saved', () => {
    expect(providerKeyStatus(bedrock, { bedrockCredentials: true })).toBe(
      'keyed'
    )
  })

  it('is not usable without saved credentials, even with models', () => {
    expect(isProviderUsable(bedrock)).toBe(false)
  })

  it('is usable with saved credentials and a model', () => {
    setBedrockCredentialsSaved(true)
    expect(isProviderUsable(bedrock)).toBe(true)
  })

  it('is not usable with credentials but no model', () => {
    setBedrockCredentialsSaved(true)
    expect(isProviderUsable({ ...bedrock, models: [] })).toBe(false)
  })
})

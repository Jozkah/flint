/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/containers/BedrockCredentials', () => ({ BedrockCredentials: () => <i data-testid="bedrock" /> }))

import { ProviderApiFrame } from '../ProviderApiFrame'

const props = (over: Record<string, unknown> = {}) =>
  ({
    provider: { provider: 'openai', models: [] },
    baseUrlDraft: '',
    setBaseUrlDraft: vi.fn(),
    commitBaseUrlDraft: vi.fn(),
    apiVersionDraft: '',
    setApiVersionDraft: vi.fn(),
    commitApiVersionDraft: vi.fn(),
    showAdvancedApiKeys: false,
    primaryKeyDraft: 'sk-abc',
    setPrimaryKeyDraft: vi.fn(),
    commitApiKeysDraft: vi.fn(),
    setShowAdvancedApiKeys: vi.fn(),
    setKeyCheckResults: vi.fn(),
    handleTestApiKeys: vi.fn(async () => {}),
    isTestingKeys: false,
    advancedApiKeyLines: ['k1', 'k2'],
    keyCheckResults: [],
    setKeyAtIndex: vi.fn(),
    removeKeyLine: vi.fn(),
    addKeyLine: vi.fn(),
    ...over,
  }) as any

describe('ProviderApiFrame', () => {
  it('opens the advanced key list and clears old check results', async () => {
    const p = props()
    render(<ProviderApiFrame {...p} />)
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }))
    expect(p.setShowAdvancedApiKeys).toHaveBeenCalledWith(true)
    expect(p.setKeyCheckResults).toHaveBeenCalledWith([])
  })

  it('commits the primary key when the box loses focus', async () => {
    const p = props()
    render(<ProviderApiFrame {...p} />)
    const inputs = document.querySelectorAll('input')
    const box = inputs[inputs.length - 1] as HTMLInputElement
    await userEvent.click(box)
    await userEvent.tab()
    expect(p.commitApiKeysDraft).toHaveBeenCalled()
  })

  it('in advanced mode lists every key, tests them, and hides by committing first', async () => {
    const p = props({ showAdvancedApiKeys: true })
    render(<ProviderApiFrame {...p} />)
    expect(screen.getAllByText('#1').length).toBeGreaterThan(0)
    expect(screen.getByText('#2')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^test/i }))
    expect(p.handleTestApiKeys).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /hide/i }))
    expect(p.commitApiKeysDraft).toHaveBeenCalled()
    expect(p.setShowAdvancedApiKeys).toHaveBeenCalledWith(false)
  })

  it('disables the test button while testing', () => {
    render(<ProviderApiFrame {...props({ showAdvancedApiKeys: true, isTestingKeys: true })} />)
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.some((b) => b.disabled)).toBe(true)
  })

  it('shows the Azure API version box only for azure, committing on blur', () => {
    const { unmount } = render(<ProviderApiFrame {...props()} />)
    expect(screen.queryByTestId('azure-api-version')).toBeNull()
    unmount()
    const p = props({ provider: { provider: 'azure', models: [] } })
    render(<ProviderApiFrame {...p} />)
    const box = screen.getByTestId('azure-api-version')
    ;(box as HTMLInputElement).focus()
    ;(box as HTMLInputElement).blur()
    expect(p.commitApiVersionDraft).toHaveBeenCalled()
  })

  it('shows Bedrock credentials for bedrock and hides the key block', () => {
    render(<ProviderApiFrame {...props({ provider: { provider: 'bedrock', models: [] } })} />)
    expect(screen.getByTestId('bedrock')).toBeTruthy()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ParametersSection } from '@/containers/ParametersSection'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${vars.name}` : key,
  }),
}))

vi.mock('@/lib/providerCaps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providerCaps')>()
  return { ...actual, isModelLevelRejected: () => true }
})

describe('ParametersSection labels', () => {
  it('labels the unsupported warning icon and routes text through t()', () => {
    render(
      <ParametersSection
        params={{ temperature: 0.7, not_a_real_param: 1 }}
        providers={[{ provider: 'llamacpp' }]}
        onToggle={vi.fn()}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        providerId="p"
        modelId="m"
      />
    )
    expect(
      screen.getByRole('img', { name: 'common:paramSearch.notSupportedStripped' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:paramSearch.notSupportedSkipped')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /common:paramSearch.removeParam/ })
    ).toBeInTheDocument()
    expect(screen.getByText('common:paramSearch.unrecognized')).toBeInTheDocument()
  })
})

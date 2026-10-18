import { describe, expect, it, vi } from 'vitest'
vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
import { fireEvent, render, screen } from '@testing-library/react'
import { HubVariantList } from '../HubVariantList'
import type { HuggingFaceFileGroup } from '@/lib/huggingface'

const g = (quant: string, size: number): HuggingFaceFileGroup => {
  const file = { name: `m-${quant}.gguf`, size }
  return {
    id: quant,
    files: [file],
    primary: file,
    quantization: quant,
    totalSize: size,
    multipart: false,
    kind: 'model',
  }
}

const many = [
  'Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'IQ3_XS', 'F16',
].map((q, i) => g(q, i + 1))

const row = (group: HuggingFaceFileGroup) => (
  <div key={group.id} data-testid="row">
    {group.id}
  </div>
)

describe('HubVariantList', () => {
  it('shows a short set, then all in a bounded area, then fewer', () => {
    render(
      <HubVariantList variants={many} recommendedId="Q4_K_M" renderRow={row} />
    )
    expect(screen.getAllByTestId('row')).toHaveLength(4)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show all 14 variants' })
    )
    expect(screen.getAllByTestId('row')).toHaveLength(14)
    expect(screen.getByText('Compact (IQ)')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: 'Show fewer' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(screen.getAllByTestId('row')).toHaveLength(4)
  })

  it('has no toggle when the list is already short', () => {
    render(
      <HubVariantList
        variants={many.slice(0, 3)}
        recommendedId={null}
        renderRow={row}
      />
    )
    expect(screen.getAllByTestId('row')).toHaveLength(3)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

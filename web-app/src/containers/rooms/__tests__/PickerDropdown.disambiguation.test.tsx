import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { PickerDropdown } from '../PickerDropdown'

// The model pickers key each row by JSON.stringify([provider, id]).
const row = (provider: string, id: string) => ({
  value: JSON.stringify([provider, id]),
  label: id,
})

const open = async (items: ReturnType<typeof row>[]) => {
  render(
    <PickerDropdown
      value={null}
      groups={[{ label: 'Bedrock', items }]}
      placeholder="pick"
      onChange={() => {}}
    />
  )
  await userEvent.click(screen.getByRole('button'))
}

describe('PickerDropdown disambiguation chips', () => {
  it('shows no chip for Bedrock ids that already read differently', async () => {
    await open([
      row('bedrock', 'anthropic.claude-fable-5-1'),
      row('bedrock', 'anthropic.claude-opus-5-5'),
      row('bedrock', 'anthropic.claude-sonnet-5-5'),
      row('bedrock', 'cohere.command-r-plus-v1:0'),
      row('bedrock', 'cohere.command-r-v1:0'),
      row('bedrock', 'meta.llama3-70b-instruct-v1:0'),
    ])
    await screen.findAllByRole('menuitemradio')
    expect(screen.queryAllByTestId('picker-disambiguator')).toHaveLength(0)
  })

  it('never builds a chip from the encoded value (no JSON punctuation)', async () => {
    const long = (mid: string) =>
      `anthropic.claude-3-5-sonnet-for-the-eu-region-${mid}-regional-inference-profile-for-batch-jobs-v1:0`
    await open([
      row('bedrock', long('20240620')),
      row('bedrock', long('20241022')),
    ])
    await screen.findAllByRole('menuitemradio')
    const chips = screen.queryAllByTestId('picker-disambiguator')
    expect(chips).toHaveLength(2)
    for (const chip of chips) {
      expect(chip.textContent).not.toMatch(/["\[\]]/)
      expect(chip.getAttribute('title') ?? '').not.toMatch(/["\[\]]/)
    }
  })
})

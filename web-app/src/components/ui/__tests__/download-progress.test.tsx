import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DownloadProgress } from '../download-progress'

const col = (id: string) => screen.getByTestId(id).style.transform

describe('DownloadProgress', () => {
  it('rolls the digits to the percentage', () => {
    render(
      <DownloadProgress
        percent={47.6}
        sizeText="2.3 / 4.9 GB"
        rateText="38 MB/s"
      />
    )
    expect(col('dlp-ones')).toBe('translateY(-47em)')
    expect(col('dlp-tens')).toBe('translateY(-4em)')
    expect(col('dlp-hundreds')).toBe('translateY(0em)')
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '47'
    )
    expect(screen.getByText('47%')).toHaveClass('sr-only')
    expect(screen.getByText('2.3 / 4.9 GB')).toBeInTheDocument()
    expect(screen.getByText('Downloading…')).toBeInTheDocument()
  })

  it('never rolls backwards', () => {
    const { rerender } = render(<DownloadProgress percent={30} />)
    rerender(<DownloadProgress percent={12} />)
    expect(col('dlp-ones')).toBe('translateY(-30em)')
    rerender(<DownloadProgress percent={31} />)
    expect(col('dlp-ones')).toBe('translateY(-31em)')
  })

  it('shows 100 and the finished state', () => {
    const { container } = render(<DownloadProgress percent={80} done />)
    expect(container.firstElementChild).toHaveAttribute('data-state', 'done')
    expect(col('dlp-hundreds')).toBe('translateY(-1em)')
    expect(col('dlp-tens')).toBe('translateY(-10em)')
    expect(col('dlp-ones')).toBe('translateY(-100em)')
    expect(screen.getByText('Ready')).not.toHaveAttribute('aria-hidden', 'true')
  })

  it('swaps the odometer for a label while idle', () => {
    render(<DownloadProgress percent={100} idle label="Verifying…" />)
    expect(screen.getByText('Verifying…')).toBeInTheDocument()
    expect(screen.queryByTestId('download-percent')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QrCode } from '../QrCode'

describe('QrCode', () => {
  it('draws a code for a short value', () => {
    render(<QrCode value="https://example.com" label="pair" />)
    expect(screen.getByTestId('remote-qr')).toBeTruthy()
  })

  it('falls back to the text when the value is too long to encode', () => {
    const value = 'x'.repeat(5000)
    render(<QrCode value={value} label="pair" />)
    expect(screen.queryByTestId('remote-qr')).toBeNull()
    expect(screen.getByTestId('remote-qr-fallback').textContent).toBe(value)
  })
})

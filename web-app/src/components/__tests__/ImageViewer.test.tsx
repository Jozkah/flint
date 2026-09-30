import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ImageViewer, downloadNameOf, type ViewerImage } from '../ImageViewer'
import { AttachedImages } from '../AttachedImages'
import { fitScale } from '@/lib/imageResize'

const png = 'data:image/png;base64,AAAA'
const jpg = 'data:image/jpeg;base64,BBBB'
const images: ViewerImage[] = [
  { url: png, name: 'chart.png' },
  { url: jpg, name: 'photo' },
  { url: png },
]

function Harness({ start = 0, onClose = () => {} }: { start?: number; onClose?: () => void }) {
  const [index, setIndex] = useState(start)
  return <ImageViewer images={images} index={index} onIndexChange={setIndex} onClose={onClose} />
}

describe('downloadNameOf', () => {
  it('keeps a real file name and builds one from the type otherwise', () => {
    expect(downloadNameOf({ url: png, name: 'chart.png' }, 0)).toBe('chart.png')
    expect(downloadNameOf({ url: jpg, name: 'photo' }, 1)).toBe('photo.jpg')
    expect(downloadNameOf({ url: png }, 2)).toBe('image-3.png')
    expect(downloadNameOf({ url: 'data:image/svg+xml;base64,AA' }, 0)).toBe('image-1.svg')
  })
})

describe('fitScale', () => {
  it('shrinks only images larger than the cap, never enlarges', () => {
    expect(fitScale(800, 600)).toBe(1)
    expect(fitScale(3200, 1600)).toBe(0.5)
    expect(fitScale(1000, 4000)).toBe(0.4)
  })
})

describe('ImageViewer', () => {
  it('shows the image and where it sits among the others', () => {
    render(<Harness />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByAltText('chart.png')).toBeTruthy()
    expect(screen.getByText('1 of 3')).toBeTruthy()
  })

  it('steps through the images with the buttons and the arrow keys, wrapping round', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByText('2 of 3')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('3 of 3')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('1 of 3')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('3 of 3')).toBeTruthy()
  })

  it('closes on Escape, the close button and a click outside the image, not on the image', async () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(3)
    await userEvent.click(screen.getByAltText('chart.png'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('zooms with the buttons and keys, and resets', async () => {
    render(<Harness />)
    const zoom = () => screen.getByTestId('viewer-zoom').textContent
    expect(zoom()).toBe('100%')
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(zoom()).toBe('125%')
    fireEvent.keyDown(window, { key: '+' })
    expect(zoom()).toBe('156%')
    fireEvent.keyDown(window, { key: '0' })
    expect(zoom()).toBe('100%')
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers the image for saving under its name', () => {
    render(<Harness start={1} />)
    const save = screen.getByRole('link', { name: 'Save image' }) as HTMLAnchorElement
    expect(save.getAttribute('download')).toBe('photo.jpg')
    expect(save.getAttribute('href')).toBe(jpg)
  })

  it('has no stepping controls for a single image', () => {
    render(
      <ImageViewer images={[images[0]]} index={0} onIndexChange={() => {}} onClose={() => {}} />
    )
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
    expect(screen.queryByText(/of 1/)).toBeNull()
  })
})

describe('AttachedImages', () => {
  it('shows one image as a single large card and opens it on click', async () => {
    const onOpen = vi.fn()
    render(<AttachedImages images={[images[0]]} onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: 'Open chart.png' })
    expect(card.className).toContain('max-w-')
    await userEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith(0)
  })

  it('shows several as tiles and opens the one clicked', async () => {
    const onOpen = vi.fn()
    render(<AttachedImages images={images} onOpen={onOpen} />)
    const tiles = screen.getAllByRole('button')
    expect(tiles).toHaveLength(3)
    expect(tiles[1].className).toContain('size-44')
    await userEvent.click(tiles[2])
    expect(onOpen).toHaveBeenCalledWith(2)
  })

  it('renders nothing without images', () => {
    const { container } = render(<AttachedImages images={[]} onOpen={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

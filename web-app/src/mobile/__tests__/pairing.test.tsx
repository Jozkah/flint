import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Pairing } from '../screens/Pairing'
import { memoryPairingStore } from '../api/storage'
import { RemoteCallError, type RemoteClient } from '../api/client'
import { hashToRoute, readPairingFragment, routeToHash } from '../state/router'
import { guessDeviceName } from '../ui/format'

function client(statuses: unknown[], pair?: () => Promise<unknown>) {
  const queue = [...statuses]
  return {
    pair: vi.fn(pair ?? (async () => ({ status: 'pending', pollId: 'poll1', confirmNumber: '482913' }))),
    pairStatus: vi.fn(async () => queue.shift() ?? { status: 'pending' }),
  } as unknown as RemoteClient & { pair: ReturnType<typeof vi.fn>; pairStatus: ReturnType<typeof vi.fn> }
}

describe('Pairing', () => {
  it('names the phone, shows the number, polls until confirmed and stores the token', async () => {
    const store = memoryPairingStore()
    const c = client([{ status: 'pending' }, { status: 'approved', token: 'tok', deviceId: 'd9' }])
    const onPaired = vi.fn()
    render(<Pairing code="abc" computer="Desk PC" client={c} store={store} onPaired={onPaired} pollMs={5} />)
    expect(screen.getByText('Pair with “Desk PC”?')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name this phone'), { target: { value: '  Jo’s Pixel ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(await screen.findByTestId('confirm-number')).toHaveTextContent('482 913')
    expect(c.pair).toHaveBeenCalledWith('abc', 'Jo’s Pixel')
    await waitFor(() => expect(onPaired).toHaveBeenCalled())
    expect(c.pairStatus).toHaveBeenCalledTimes(2)
    expect(store.get()).toMatchObject({ token: 'tok', deviceId: 'd9', deviceName: 'Jo’s Pixel', computerName: 'Desk PC' })
  })

  it('says so when the desktop declines', async () => {
    const store = memoryPairingStore()
    render(<Pairing code="abc" client={client([{ status: 'rejected' }])} store={store} onPaired={vi.fn()} pollMs={5} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('declined')
    expect(store.get()).toBeNull()
  })

  it('explains an expired or used code', async () => {
    const c = client([], async () => {
      throw new RemoteCallError('invalid_code', 'bad', 401)
    })
    render(<Pairing code="old" client={c} store={memoryPairingStore()} onPaired={vi.fn()} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pair' })))
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong, expired or already used')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: 'Pair' })).toBeInTheDocument()
  })
})

describe('routes and the pairing link', () => {
  it('reads the code and computer name from the fragment only', () => {
    expect(readPairingFragment('#pair=abc123&name=Desk%20PC')).toEqual({ code: 'abc123', computer: 'Desk PC' })
    expect(readPairingFragment('#pair=abc123')).toEqual({ code: 'abc123' })
    expect(readPairingFragment('#/cowork/w1')).toBeNull()
    expect(readPairingFragment('#pair=')).toBeNull()
  })

  it('round-trips routes through the hash', () => {
    for (const r of [
      { name: 'home' },
      { name: 'home', mode: 'cowork' },
      { name: 'cowork', id: 'a/b c' },
      { name: 'settings-sub', sub: 'jev' },
      { name: 'models' },
    ] as const) {
      expect(hashToRoute(routeToHash(r))).toEqual(r)
    }
    expect(hashToRoute('#/nonsense')).toEqual({ name: 'home' })
  })

  it('falls back to home for malformed percent-encoded routes', () => {
    expect(() => hashToRoute('#/chat/%E0%A4%A')).not.toThrow()
    expect(hashToRoute('#/chat/%E0%A4%A')).toEqual({ name: 'home' })
    expect(hashToRoute('#/settings/%')).toEqual({ name: 'home' })
  })

  it('guesses a readable phone name', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A)')).toBe('Pixel 9')
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 10; K)')).toBe('Android phone')
  })
})

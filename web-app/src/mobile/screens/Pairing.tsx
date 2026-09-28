// Pairing from the QR code's link (`/m/#pair=<code>&name=<computer>`): name
// this phone, send the claim, show the 6-digit number to compare with the
// computer's, and wait there until the desktop user confirms.
import { useEffect, useRef, useState } from 'react'
import type { PairStatus } from '@/lib/remote/protocol'
import { I } from '../ui/icons'
import { FlintMark } from '../ui/bits'
import { guessDeviceName } from '../ui/format'
import type { RemoteClient } from '../api/client'
import { RemoteCallError } from '../api/client'
import type { PairingStore } from '../api/storage'

const POLL_MS = 1500

type Phase =
  | { step: 'name' }
  | { step: 'sending' }
  | { step: 'waiting'; confirmNumber: string }
  | { step: 'failed'; message: string }

export function Pairing({
  code,
  computer,
  client,
  store,
  onPaired,
  pollMs = POLL_MS,
}: {
  code: string
  computer?: string
  client: RemoteClient
  store: PairingStore
  onPaired: () => void
  pollMs?: number
}) {
  const [name, setName] = useState(guessDeviceName)
  const [phase, setPhase] = useState<Phase>({ step: 'name' })
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const who = computer ? `“${computer}”` : 'your computer'

  useEffect(
    () => () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    },
    []
  )

  const start = async () => {
    const deviceName = name.trim().slice(0, 64) || guessDeviceName()
    setPhase({ step: 'sending' })
    try {
      const r = await client.pair(code, deviceName)
      setPhase({ step: 'waiting', confirmNumber: r.confirmNumber })
      const poll = async () => {
        let s: PairStatus
        try {
          s = await client.pairStatus(r.pollId)
        } catch {
          // A dropped request: keep asking until the code expires.
          pollRef.current = setTimeout(poll, pollMs)
          return
        }
        if (s.status === 'approved') {
          store.set({
            token: s.token,
            deviceId: s.deviceId,
            deviceName,
            ...(computer ? { computerName: computer } : {}),
            pairedAt: Date.now(),
          })
          // Drop the code from the address bar and history.
          try {
            history.replaceState(null, '', location.pathname + location.search)
          } catch {
            // Not in a browser.
          }
          onPaired()
        } else if (s.status === 'pending') {
          pollRef.current = setTimeout(poll, pollMs)
        } else if (s.status === 'rejected') {
          setPhase({ step: 'failed', message: `Pairing was declined on ${who}.` })
        } else {
          setPhase({ step: 'failed', message: 'The pairing code expired. Show a new QR code on the computer and scan it again.' })
        }
      }
      pollRef.current = setTimeout(poll, pollMs)
    } catch (e) {
      setPhase({
        step: 'failed',
        message:
          e instanceof RemoteCallError && e.code === 'invalid_code'
            ? 'This pairing code is wrong, expired or already used. Show a new QR code on the computer.'
            : e instanceof RemoteCallError
              ? e.message
              : "Can't reach your computer.",
      })
    }
  }

  const number = phase.step === 'waiting' ? phase.confirmNumber : null
  return (
    <div className="app">
      <div id="views">
        <div className="top">
          <div className="crumb" style={{ paddingLeft: 10 }}>
            <b>Connect to Flint</b>
          </div>
        </div>
        <div className="pair" data-testid="pairing">
          <FlintMark size={56} />
          <div>
            <b style={{ fontSize: 18 }}>Pair with {who}?</b>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 13.5 }}>
              {number
                ? 'Check that this number matches the one on your computer, then confirm there.'
                : 'Name this phone, then confirm on your computer.'}
            </p>
          </div>
          {number && (
            <div className="code6" data-testid="confirm-number" aria-label={`Confirmation number ${number.split('').join(' ')}`}>
              {number.slice(0, 3)} {number.slice(3)}
            </div>
          )}
          {phase.step === 'name' || phase.step === 'sending' ? (
            <>
              <label className="field">
                Name this phone
                <input
                  value={name}
                  maxLength={64}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  onKeyDown={(e) => e.key === 'Enter' && void start()}
                />
              </label>
              <button type="button" className="btn pri big" disabled={phase.step === 'sending'} onClick={() => void start()}>
                {phase.step === 'sending' ? 'Sending…' : 'Pair'}
              </button>
            </>
          ) : phase.step === 'waiting' ? (
            <span className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }} role="status">
              <I n="loader" spin size={14} />
              Waiting for you to confirm on the computer…
            </span>
          ) : (
            <>
              <p role="alert" style={{ margin: 0, color: 'var(--destructive)', fontSize: 13.5 }}>
                {phase.message}
              </p>
              <button type="button" className="btn big" onClick={() => setPhase({ step: 'name' })}>
                Try again
              </button>
            </>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            You can remove this phone any time in Settings › Remote access on your computer.
          </span>
        </div>
      </div>
    </div>
  )
}

export function Unpaired() {
  return (
    <div className="app">
      <div id="views">
        <div className="pair" data-testid="unpaired">
          <FlintMark size={56} />
          <div>
            <b style={{ fontSize: 18 }}>This phone isn't paired</b>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 13.5 }}>
              It may have been removed on the computer. To connect, open Flint on your computer, go to Settings › Remote access, choose
              Pair a phone and scan the QR code with this phone's camera.
            </p>
          </div>
          <button type="button" className="btn big" onClick={() => location.reload()}>
            <I n="refresh" />
            Check again
          </button>
        </div>
      </div>
    </div>
  )
}

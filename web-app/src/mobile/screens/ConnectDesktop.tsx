// First screen of the iOS app: which computer to talk to. Takes the address
// shown by Flint's Remote access settings, or the pairing link in its QR code.
import { useState } from 'react'

type Props = {
  initial?: string
  error?: string | null
  /** The pinned certificate no longer matches: offer to trust the new one. */
  pinChanged?: boolean
  onConnect: (input: string) => void
  onForgetPin?: () => void
  busy?: boolean
}

export function ConnectDesktop({ initial = '', error, pinChanged, onConnect, onForgetPin, busy }: Props) {
  const [value, setValue] = useState(initial)
  return (
    <div className="app">
      <div className="pair" data-testid="connect-desktop">
        <h1 style={{ margin: 0 }}>Connect to your computer</h1>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13.5 }}>
          Turn on Remote access in Flint on your computer, then enter its address or paste the
          pairing link.
        </p>
        <label className="field">
          <span>Computer address</span>
          <input
            value={value}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="192.168.1.20:1340"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim() && !busy) onConnect(value)
            }}
          />
        </label>
        {error ? (
          <p role="alert" style={{ color: 'var(--destructive, #d33)', fontSize: 13.5 }}>
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="btn pri big"
          disabled={busy || !value.trim()}
          onClick={() => onConnect(value)}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {pinChanged && onForgetPin ? (
          <button type="button" className="btn big" onClick={onForgetPin}>
            Trust this computer&apos;s new certificate
          </button>
        ) : null}
      </div>
    </div>
  )
}

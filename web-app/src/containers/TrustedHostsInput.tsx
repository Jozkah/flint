import { Input } from '@/components/ui/input'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

// What the server's allowlist check (src-tauri/utils/src/http.rs) can match:
// `*` alone, or a host with an optional port, optionally written as a full
// origin (`chrome-extension://<id>`, `http://host:3000`, #155). Entries are
// compared exactly, so partial wildcards such as `*.example.com` never match
// and are rejected here rather than saved as dead entries.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i
const IPV6 = /^[0-9a-f:.]+(%[\w.-]+)?$/i

function validPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

export function isValidTrustedHost(entry: string): boolean {
  if (entry === '*') return true
  let rest = entry
  const scheme = rest.match(SCHEME)
  if (scheme) rest = rest.slice(scheme[0].length)
  // Allow one trailing slash from a pasted origin; any real path is an error.
  if (scheme && rest.endsWith('/')) rest = rest.slice(0, -1)
  if (!rest || /[/?#@\s]/.test(rest)) return false
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0) return false
    const ip = rest.slice(1, close)
    const after = rest.slice(close + 1)
    if (!ip.includes(':') || !IPV6.test(ip)) return false
    return after === '' || (after.startsWith(':') && validPort(after.slice(1)))
  }
  const parts = rest.split(':')
  if (parts.length > 2) return false
  if (parts.length === 2 && !validPort(parts[1])) return false
  return HOSTNAME.test(parts[0])
}

export function parseTrustedHosts(value: string): string[] {
  const hosts = value
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
  return [...new Set(hosts)]
}

export function TrustedHostsInput({
  isServerRunning,
}: {
  isServerRunning?: boolean
}) {
  const { trustedHosts, setTrustedHosts } = useLocalApiServer()
  const stored = trustedHosts.join(', ')
  const [inputValue, setInputValue] = useState(stored)
  const { t } = useTranslation()

  // Update input value when trustedHosts changes externally
  useEffect(() => {
    setInputValue(stored)
  }, [stored])

  const invalid = parseTrustedHosts(inputValue).filter(
    (host) => !isValidTrustedHost(host)
  )
  const dirty = parseTrustedHosts(inputValue).join(', ') !== stored

  // Saves the edit if it is valid and the server is stopped. A running server
  // keeps its configuration; the field is disabled, and this guards a blur
  // that still arrives (#111).
  const commit = () => {
    if (isServerRunning) return
    const hosts = parseTrustedHosts(inputValue)
    if (hosts.some((host) => !isValidTrustedHost(host))) return
    if (hosts.join(', ') !== stored) setTrustedHosts(hosts)
    setInputValue(hosts.join(', '))
  }

  // Leaving the page or closing the settings dialog unmounts the field
  // without a blur; save the pending edit then as well.
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => commitRef.current(), [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape' && inputValue !== stored) {
      // Revert only; let Escape close a surrounding dialog when nothing changed.
      e.preventDefault()
      e.stopPropagation()
      setInputValue(stored)
    }
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      <Input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        disabled={isServerRunning}
        aria-invalid={invalid.length > 0}
        title={isServerRunning ? t('settings:localApiServer.stopServerToEdit') : undefined}
        placeholder={t('common:enterTrustedHosts')}
        className={cn(
          'h-8 text-sm',
          isServerRunning && 'opacity-50',
          invalid.length > 0 && 'border-destructive'
        )}
      />
      {isServerRunning ? (
        <p className="text-xs text-muted-foreground">
          {t('settings:localApiServer.stopServerToEdit')}
        </p>
      ) : invalid.length > 0 ? (
        <p role="alert" className="text-xs text-destructive">
          {t('settings:localApiServer.trustedHostsInvalid', {
            hosts: invalid.join(', '),
          })}
        </p>
      ) : dirty ? (
        <p className="text-xs text-muted-foreground">
          {t('settings:localApiServer.trustedHostsUnsaved')}
        </p>
      ) : null}
    </div>
  )
}

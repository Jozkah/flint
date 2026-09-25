import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

interface GlobalErrorProps {
  error: Error | unknown
}

/**
 * The root route's error boundary. It renders without the shell, the theme
 * provider or i18n, so it relies only on the base tokens and fixed copy.
 */
export default function GlobalError({ error }: GlobalErrorProps) {
  console.error('Error in root route:', error)
  const [showFull, setShowFull] = useState(false)

  return (
    <div className="flex h-screen w-full items-start justify-center overflow-auto bg-background px-4 py-10 text-foreground sm:items-center">
      <div className="w-full min-w-0 max-w-xl">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive-tint text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground">
              Something went wrong
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-fg-2">
              Flint hit an error it could not recover from. Try to{' '}
              <button
                rel="noopener noreferrer"
                className="cursor-pointer rounded-sm font-medium text-acc-text hover:underline"
                onClick={() => window.location.reload()}
              >
                refresh this page
              </button>
              . If it keeps happening,{' '}
              <a
                rel="noopener noreferrer"
                className="rounded-sm font-medium text-acc-text hover:underline"
                href="https://discord.gg/FTk2MvZwJH"
                target="_blank"
              >
                contact us
              </a>{' '}
              and include the details below.
            </p>
          </div>
        </div>
        <div
          className="mt-4 w-full rounded-lg border border-destructive/40 bg-destructive-tint px-3 py-2.5 text-left text-destructive"
          role="alert"
        >
          <p className="text-sm">
            <strong className="font-semibold">Error: </strong>
            <span className="break-words">
              {error instanceof Error ? error.message : String(error)}
            </span>
          </p>
          <pre className="mt-2 max-h-[250px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-code-bg p-3 text-left font-mono text-xs text-fg-2">
            <code>
              {error instanceof Error
                ? showFull
                  ? error.stack
                  : error.stack?.slice(0, 200)
                : String(error)}
            </code>
          </pre>
          <button
            onClick={() => setShowFull(!showFull)}
            className="mt-1.5 cursor-pointer rounded-sm text-sm text-destructive underline underline-offset-2 pointer-coarse:min-h-11"
          >
            {showFull ? 'Show less' : 'Show more'}
          </button>
        </div>
      </div>
    </div>
  )
}

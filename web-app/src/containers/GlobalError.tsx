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
    <div className="flex h-screen w-full items-center justify-center overflow-auto bg-background p-5 text-foreground">
      <div className="w-full max-w-3xl text-center">
        <span className="inline-flex size-16 items-center justify-center rounded-lg bg-destructive-tint text-destructive">
          <AlertTriangle className="size-8" />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-foreground">
          Oops! Unexpected error occurred.
        </h1>
        <p className="my-2 text-ink-2">
          Something went wrong. Try to{' '}
          <button
            rel="noopener noreferrer"
            className="cursor-pointer rounded-sm font-medium text-brand-text hover:underline"
            onClick={() => window.location.reload()}
          >
            refresh this page
          </button>{' '}
          or <br /> feel free to{' '}
          <a
            rel="noopener noreferrer"
            className="rounded-sm font-medium text-brand-text hover:underline"
            href="https://discord.gg/FTk2MvZwJH"
            target="_blank"
          >
            contact us
          </a>{' '}
          if the problem persists.
        </p>
        <div
          className="mx-auto mt-5 w-full rounded-lg border border-destructive/40 bg-destructive-tint px-4 py-3 text-left text-destructive md:w-4/5"
          role="alert"
        >
          <strong className="font-semibold">Error: </strong>
          <span className="block break-words sm:inline">
            {error instanceof Error ? error.message : String(error)}
          </span>
          <div className="mt-2 h-full w-full">
            <pre className="mt-2 max-h-[250px] overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-4 text-left font-mono text-xs text-ink-2">
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
              className="mt-2 cursor-pointer rounded-sm text-sm text-destructive underline underline-offset-2 pointer-coarse:min-h-11"
            >
              {showFull ? 'Show less' : 'Show more'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

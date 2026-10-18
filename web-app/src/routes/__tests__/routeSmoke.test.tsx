/* eslint-disable @typescript-eslint/no-explicit-any */
// Renders every route once through the real route tree. It only fails on
// errors that are bugs whatever the backend says: a variable read before it
// is declared ("Cannot access 't' before initialization") and similar
// ReferenceErrors, which take a whole page down at every width and language.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { getServiceHub } from '@/hooks/useServiceHub'

// The shared test hub only stubs what other tests needed. Fill every gap
// with a no-op that resolves empty, so the shell renders and each page gets
// its turn; a page that then crashes on its own code still fails.
const NAMESPACES = [
  'theme', 'window', 'events', 'hardware', 'app', 'messages', 'mcp',
  'threads', 'providers', 'models', 'assistants', 'dialog', 'opener',
  'path', 'core', 'deeplink', 'projects', 'rag', 'uploads',
]
function fill(target: any): any {
  return new Proxy(target ?? {}, {
    get: (t, key) =>
      key in t || typeof key === 'symbol' || key === 'then'
        ? t[key as any]
        : (t[key as any] = vi.fn().mockResolvedValue([])),
  })
}
beforeAll(() => {
  const hub = getServiceHub() as any
  for (const ns of NAMESPACES) {
    const orig = hub[ns]
    const cache = new Map<string, any>()
    hub[ns] = () => {
      if (!cache.has(ns)) cache.set(ns, fill(orig?.()))
      return cache.get(ns)
    }
  }
})

const PATHS = [
  '/',
  '/overview',
  '/archive',
  '/artifacts',
  '/campaigns',
  '/campaign/c1',
  '/cowork',
  '/extensions',
  '/hub',
  '/hub/some-model',
  '/logs',
  '/local-api-server/logs',
  '/project/p1',
  '/rooms',
  '/rooms/r1',
  '/settings/agent-tools',
  '/settings/assistant',
  '/settings/attachments',
  '/settings/claude-code',
  '/settings/extensions',
  '/settings/general',
  '/settings/https-proxy',
  '/settings/interface',
  '/settings/jev',
  '/settings/local-api-server',
  '/settings/mcp-servers',
  '/settings/memory',
  '/settings/permissions',
  '/settings/providers',
  '/settings/providers/openai',
  '/settings/remote-access',
  '/settings/schedules',
  '/settings/shortcuts',
  '/settings/web-search',
  '/studio',
  '/system-monitor',
  '/threads/t1',
  '/translate',
]

const FATAL = /before initialization|ReferenceError/

function captureErrors() {
  const seen: string[] = []
  const note = (v: unknown) => {
    const text = v instanceof Error ? `${v.name}: ${v.message}` : String(v)
    if (FATAL.test(text)) seen.push(text)
  }
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    args.forEach(note)
  })
  const onError = (e: ErrorEvent) => note(e.error ?? e.message)
  window.addEventListener('error', onError)
  return {
    seen,
    stop: () => {
      spy.mockRestore()
      window.removeEventListener('error', onError)
    },
  }
}

afterEach(() => cleanup())

describe('every route renders without a declaration-order crash', () => {
  it('has a smoke entry for every route in the tree', () => {
    const tree = (routeTree as any).children as Record<string, any>
    const leafPaths = new Set<string>()
    const walk = (r: any) => {
      const kids = r.children ? Object.values(r.children) : []
      if (kids.length === 0 && r.fullPath) leafPaths.add(r.fullPath)
      kids.forEach(walk)
    }
    Object.values(tree).forEach(walk)
    const covered = PATHS.map((p) => p.replace(/\/$/, ''))
    const asPattern = (full: string) =>
      new RegExp(
        '^' + full.replace(/\/$/, '').replace(/\$[A-Za-z]+/g, '[^/]+') + '$'
      )
    for (const full of leafPaths) {
      const re = asPattern(full)
      const hit = covered.some((p) => re.test(p) || (full === '/' && p === ''))
      expect(hit, `route ${full} has no smoke entry`).toBe(true)
    }
  })

  for (const path of PATHS) {
    it(`renders ${path}`, async () => {
      const errors = captureErrors()
      try {
        const router = createRouter({
          routeTree,
          history: createMemoryHistory({ initialEntries: [path] }),
        })
        await router.load()
        render(<RouterProvider router={router as any} />)
        await waitFor(() => expect(document.body.innerHTML).not.toBe('<div></div>'), {
          timeout: 10000,
        })
        // Let lazy components and their first effects settle.
        await new Promise((r) => setTimeout(r, 50))
        const crash = document.body.querySelector('[role=alert]')?.textContent
        if (crash && FATAL.test(crash)) errors.seen.push(crash)
      } finally {
        errors.stop()
      }
      expect(errors.seen).toEqual([])
    })
  }
})

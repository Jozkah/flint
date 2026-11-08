/* eslint-disable @typescript-eslint/no-explicit-any */
// Mounts one route through the real route tree for smoke-level tests: the
// page renders, a key control is present, nothing throws. Mirrors the setup
// in routeSmoke.test.tsx (no-op service hub gaps, memory history).
import { vi, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import { getServiceHub } from '@/hooks/useServiceHub'

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

/** Call once from beforeAll: fills every gap in the shared test hub. */
export function fillServiceHub() {
  const hub = getServiceHub() as any
  for (const ns of NAMESPACES) {
    const orig = hub[ns]
    const cache = new Map<string, any>()
    hub[ns] = () => {
      if (!cache.has(ns)) cache.set(ns, fill(orig?.()))
      return cache.get(ns)
    }
  }
}

/** Renders the route at `path` and waits for the first paint. */
export async function renderRoute(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  const utils = render(<RouterProvider router={router as any} />)
  await waitFor(
    () => expect(document.body.innerHTML).not.toBe('<div></div>'),
    { timeout: 10000 }
  )
  // Let lazy components and their first effects settle.
  await new Promise((r) => setTimeout(r, 50))
  return utils
}

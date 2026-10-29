/**
 * `invoke` for the provider-credential commands, answered by the Flint server
 * when the page is served by `flint serve`. Kept as a name for its callers;
 * the routing lives in `invokeCommand` (lib/backend.ts).
 */
export { invokeCommand as hostInvoke } from '@/lib/backend'

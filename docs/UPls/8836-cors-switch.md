# The Local API Server "CORS" switch did nothing (janhq/jan#8836)

## Defect in the fork

Settings > Local API Server has a CORS switch, and every caller of
`startServer` passed it as `isCorsEnabled` -- but the `start_server` shim in
`web-app/src/lib/service.ts` dropped it, `StartServerConfig` had no field for
it, and the proxy added `Access-Control-*` headers to every response
regardless. Switching CORS off changed nothing.

Mitigated before the fix: the proxy only reflects an origin whose host is on
the Trusted Hosts list, so an arbitrary site was not granted access either way.
But a user who switched CORS off to keep even trusted-host browser pages out
was not getting that.

## Fix

- The shim forwards the switch as `cors_enabled`; `StartServerConfig` takes it
  (on when a caller does not say, which is the old behaviour); it reaches
  `ProxyConfig`.
- With it off, every response has its `Access-Control-*` headers removed at a
  single point, where the connection's service returns the response: the
  preflight answer, the many responses the proxy builds itself, and any CORS
  headers a backend sent. A browser page on another origin is then refused.
  Threading a flag through each of the ~45 places that add the headers would
  have left the next one added unguarded.

Upstream's PR for this plumbs the flag by hand through `proxy.rs`; it does not
apply to the fork's proxy and was not used.

## Tests

- `core::server::tests::cors_off_strips_every_access_control_header`: headers
  added by the proxy's own helper, and one standing in for a backend's, are all
  removed; other headers stay.
- `web-app/src/lib/__tests__/service.test.ts`: the shim forwards the switch,
  and leaves it unset when a caller does not pass one.

# Custom request headers for model providers (janhq/jan#8208)

Upstream issue #8208 asks for custom HTTP headers on AI model providers, for
gateways that need a tenant, a subscription key or a routing header. The fork
already stored `custom_header` on a provider and sent it with chat requests,
but nothing in the UI could set it, and the plumbing had no rules.

## What was wrong underneath

Found while mapping the existing plumbing, before adding a UI:

- **A custom header could replace the API key.** The AI SDK providers spread
  custom headers after their own, so a custom `Authorization`, `x-api-key` or
  `x-goog-api-key` replaced the configured key. On the OpenAI-compatible path
  a lower-case `authorization` went out beside Jan's `Authorization`.
- **Redirects carried credentials to other hosts.** reqwest's default policy
  follows any redirect and drops only `Authorization`, `Cookie` and the proxy
  credentials on a host change. `x-api-key`, `x-goog-api-key` and every custom
  header went on to the new host.
- **Header values sat in `settings.json` in plaintext**, beside keys that are
  already kept in the OS credential store.
- **`list_provider_configs` / `get_provider_config` returned the keys**,
  despite the comment saying they did not.
- **The log redactor could not see custom credentials**: it matches known
  shapes and names, and a custom header can be any name and any shape.

## What changed

- **One set of rules** (`web-app/src/lib/customHeaders.ts`), used by chat
  requests (every provider in `model-factory.ts`), model discovery, the key
  test and `ai-model.ts`:
  - Names Jan owns are refused, in any case: authentication (`Authorization`,
    `x-api-key`, `x-goog-api-key`, `api-key`, `Proxy-Authorization`), framing
    (`Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`,
    `Connection`, ...), `Origin`, and the `x-jan-*`, `proxy-*` and `sec-*`
    prefixes. `x-jan-*` carries the dispatch identity.
  - Any other header of the same name, in any case, is replaced by the custom
    one. For example, a custom `Anthropic-Version` overrides the default.
  - Names must be RFC 9110 tokens. Values may not contain line breaks or other
    control characters. Names, values and the number of headers are bounded.
  - A row with a problem is never sent.
- **Typed validation errors** (`empty-name`, `invalid-name`, `reserved`,
  `duplicate`, `empty-value`, `invalid-value`, `too-long`, `too-many`). The
  editor shows them against the row, with `aria-invalid` set, and does not save.
- **Secret headers.** A header can be marked secret; key-like names
  (`auth`, `token`, `key`, `secret`, `cookie`, ...) default to it.
  - Its value is stored with the provider's keys in the OS credential store,
    or the encrypted file where there is none, under
    `provider-headers:<provider>`.
  - `settings.json` keeps the name and a blank value, and the value is read
    back at startup the way the keys are.
  - It is saved to the credential store before the provider is updated, so a
    header is never shown as saved when its value was lost.
  - Removing the provider removes the entry.
- **Editor** in the provider's API-keys card: name, value (masked when secret),
  a secret switch, remove, add.
- **Redirects** (`core/net/transport.rs`) are followed only on the same
  server, or from `http` to `https` on the same host.
  - A redirect elsewhere fails, naming where the provider tried to send the
    request, and nothing is sent there.
  - Transport errors now include reqwest's source chain, which is where the
    reason is.
- **No leaks.**
  - The config commands return configs without keys or secret header values.
  - Secret values are registered with the log redactor by exact value when a
    provider is registered, so the file log and the diagnostic bundle redact
    them whatever their shape.
  - The editor redacts them from the save-failure message.

## Completion audit (second pass)

- **Switch a header off without removing it.** Each row has an on/off switch.
  An off header keeps its name, value and secrecy but is not sent. It still
  takes its name for the duplicate check, so switching it back on cannot
  collide with a later row.
- **Error bodies are redacted in the transport.** A gateway that rejects the
  request and echoes it back would otherwise put a secret header's value in
  the UI and the thread. `core/net/transport.rs` redacts registered secret
  values from every non-success body before the webview sees it: whole on
  `send`, and read whole on `send_stream` so a value cannot be split across
  chunks. Success bodies (model output) are left alone.
- **Secret values are registered for redaction on their own.** Before, they
  were registered only through `register_provider_config`, which is skipped
  for a provider with no API key. `register_secret_values` is now called
  whenever secret values are saved or loaded.
- **Headers stay with their provider.** A guard test covers this; it passed
  on the earlier code too.
- A second change made before the store echoes the first back (off, then on
  again) used to be dropped as "unchanged". It is now compared with the last
  committed rows.

## Precedence

In increasing order of priority:

1. Built-in defaults (`anthropic-version`, ...).
2. Custom headers.
3. Authentication and the dispatch identity, which custom headers cannot
   name at all.

## Not changed

The Rust paths that do not read `custom_headers` still do not send them:
- the Local API Server proxy (`core/server/proxy.rs`);
- the agent's upstream (`core/agent/upstream.rs`, `genai_bridge.rs`);
- the CLI (`core/cli/providers.rs`).

Those requests go without the custom headers, as before.

## Tests

- `lib/__tests__/customHeaders.test.ts`: validation, precedence, secrets.
- `lib/__tests__/model-factory.test.ts`: a custom header cannot stand in for
  the key on the OpenAI-compatible and Anthropic paths; a default is replaced,
  not duplicated. Both failed before.
- `hooks/__tests__/stripProviderSecrets.test.ts`: a secret value is not
  persisted. Failed before.
- `lib/__tests__/providerHeaderSecrets.test.ts`: the credential-store record.
- `providers/__tests__/DataProvider.test.tsx`: secret values are loaded at
  startup before the provider is registered. Failed before.
- `containers/__tests__/ProviderCustomHeaders.test.tsx`: the editor.
- Rust:
  - `core/net/transport.rs`: a redirect to another server is refused and the
    other server receives nothing, on both the plain and the streamed path; a
    same-server redirect is still followed.
  - `core/cli/secrets.rs`: exact-value redaction.
  - `core/server/remote_provider_commands.rs`: configs leave without secrets.
- Real app: `custom-headers-reach-the-provider-and-secrets-stay-secret` in
  `src-tauri/examples/cowork_smoke.rs`. The fixture records the headers of
  every chat request it receives.
  - Headers are added in the settings page, and a reserved one is refused
    there.
  - Both the plain and the secret header reach the provider on a real request.
  - The secret value is in the credential store and in no file of the data
    folder.
  - Switching the plain header off takes it out of the next request;
    switching it back on puts it back.
  - A gateway that answers 401 and echoes every request header in its error:
    the error is shown, and the secret value is on neither the page nor the
    disk.
  - `custom-headers-survive-a-restart` runs in a second process on the kept
    profile. The value is not in settings, so a request that still carries it
    read it back from the credential store. Removing the headers takes them
    out of the very next request and removes the stored value.
  - The secret is typed into the page base64-encoded, so a failing script
    printed to the log does not show it.

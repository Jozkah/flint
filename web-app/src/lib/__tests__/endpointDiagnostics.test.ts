import { describe, it, expect } from 'vitest'
import {
  endpointScope,
  isLocalEndpoint,
  describeEndpointFailure,
  parseModelList,
  describeChatFailure,
} from '@/lib/endpointDiagnostics'

describe('endpointScope', () => {
  it('classifies loopback as local', () => {
    for (const url of [
      'http://localhost:8080/v1',
      'http://127.0.0.1:1337/v1',
      'http://[::1]:8080/v1',
      'http://0.0.0.0:8080/v1',
    ]) {
      expect(endpointScope(url)).toBe('loopback')
      expect(isLocalEndpoint(url)).toBe(true)
    }
  })

  it('classifies LAN and overlay addresses as local, not remote', () => {
    for (const url of [
      'http://192.168.1.50:8080/v1',
      'http://10.0.0.4:8080/v1',
      'http://172.16.3.9:8080/v1',
      // Tailscale hands out 100.64.0.0/10; this is the address the reporter's
      // own server actually answers on.
      'http://100.118.119.72:8080/v1',
      'http://llm-host.tail76b52a.ts.net:8080/v1',
      'http://box.local:8080/v1',
    ]) {
      expect(isLocalEndpoint(url)).toBe(true)
      expect(endpointScope(url)).toBe('private')
    }
  })

  it('classifies a public host as remote', () => {
    expect(endpointScope('https://api.openai.com/v1')).toBe('public')
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
  })

  it('refuses to guess for a bare hostname', () => {
    // `llm-host` resolves to the LAN box or to a public record depending on the
    // resolver's search domains. Claiming either would be a lie.
    expect(endpointScope('http://llm-host:8080/v1')).toBe('unknown')
    expect(isLocalEndpoint('http://llm-host:8080/v1')).toBe(false)
  })

  it('does not throw on rubbish', () => {
    expect(endpointScope(null)).toBe('unknown')
    expect(endpointScope('')).toBe('unknown')
    expect(endpointScope('not a url')).toBe('unknown')
  })
})

describe('describeEndpointFailure', () => {
  const base = {
    provider: 'Qwen 3.8 (8080)',
    url: 'http://llm-host:8080/v1/models',
  }

  it('names the proxy when a local-looking endpoint is answered from the internet', () => {
    // The actual reported failure: Cloudflare answered 403 because the bare
    // hostname resolved to a public record.
    const message = describeEndpointFailure({
      ...base,
      status: 403,
      statusText: 'Forbidden',
      server: 'cloudflare',
    })
    expect(message).toContain('Qwen 3.8 (8080)')
    expect(message).toContain('http://llm-host:8080/v1/models')
    expect(message).toContain('403')
    expect(message).toContain('cloudflare')
    expect(message).toMatch(/resolving to a public address/i)
    expect(message).not.toContain('[object Object]')
  })

  it('asks for a key on 401 and does not on 403', () => {
    const unauthorized = describeEndpointFailure({ ...base, status: 401 })
    expect(unauthorized).toMatch(/requires an API key/i)

    // A 403 from the user's own server must never be "fixed" by telling them to
    // strip authentication.
    const forbidden = describeEndpointFailure({
      ...base,
      url: 'http://192.168.1.50:8080/v1/models',
      status: 403,
    })
    expect(forbidden).toMatch(/check what is answering/i)
    expect(forbidden).not.toMatch(/remove.*(auth|key)/i)
  })

  it('points at the base URL shape on 404', () => {
    const message = describeEndpointFailure({
      ...base,
      url: 'http://127.0.0.1:8080/v1/v1/models',
      status: 404,
    })
    expect(message).toMatch(/ends at \/v1/i)
  })

  it('describes a refused connection without a status', () => {
    const message = describeEndpointFailure({
      ...base,
      url: 'http://127.0.0.1:8081/v1/models',
      cause: new Error('Connection refused'),
    })
    expect(message).toMatch(/could not reach/i)
    expect(message).toContain('Connection refused')
    expect(message).toContain('http://127.0.0.1:8081')
  })

  it('renders an object rejection safely', () => {
    const message = describeEndpointFailure({
      ...base,
      cause: { code: 'ECONNREFUSED' },
    })
    expect(message).not.toContain('[object Object]')
    expect(message).toContain('ECONNREFUSED')
  })

  it('reports a server fault as the server’s, not a credential problem', () => {
    const message = describeEndpointFailure({ ...base, status: 503 })
    expect(message).toMatch(/check its logs/i)
    expect(message).not.toMatch(/API key/i)
  })
})

describe('parseModelList', () => {
  it('reads the llama.cpp payload, which carries both shapes at once', () => {
    // Redacted copy of what the reporter's server actually returns.
    const payload = {
      models: [{ name: 'qwen3.8-27b', model: 'qwen3.8-27b', type: 'model' }],
      object: 'list',
      data: [{ id: 'qwen3.8-27b', aliases: ['qwen3.8-27b'], object: 'model' }],
    }
    expect(parseModelList(payload)).toEqual(['qwen3.8-27b'])
  })

  it('reads a standard OpenAI payload', () => {
    expect(
      parseModelList({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'o3' }] })
    ).toEqual(['gpt-4o', 'o3'])
  })

  it('reads a bare list of names', () => {
    expect(parseModelList({ models: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('returns nothing for a server that does not implement /v1/models', () => {
    // The UI must be able to say "this server lists no models" truthfully and
    // fall back to a manually entered id, rather than throw.
    expect(parseModelList({ error: 'not found' })).toEqual([])
    expect(parseModelList('<html>404</html>')).toEqual([])
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList({ data: 'nonsense' })).toEqual([])
  })
})

describe('when nothing answered at all', () => {
  const failure = {
    provider: '123',
    url: 'http://llm-host:8555/v1/models',
    method: 'GET',
  }

  it('keeps what the name resolved to, which is the diagnosis', () => {
    const message = describeEndpointFailure({
      ...failure,
      cause: new Error(
        'llm-host:8555 could not connect (resolved 203.0.113.9 [public, suppressed], 127.0.0.1 [loopback]; selected 127.0.0.1): error sending request for url (http://llm-host:8555/v1/models)'
      ),
    })
    expect(message).toContain('203.0.113.9 [public, suppressed]')
    expect(message).toContain('selected 127.0.0.1')
    expect(message).toContain('listening on http://llm-host:8555')
  })

  it('does not say the same URL three times', () => {
    const message = describeEndpointFailure({
      ...failure,
      cause: new Error(
        'llm-host:8555 could not connect: error sending request for url (http://llm-host:8555/v1/models)'
      ),
    })
    expect(message.match(/v1\/models/g) ?? []).toHaveLength(1)
  })

  it('still says something when the transport said nothing', () => {
    const message = describeEndpointFailure({ ...failure, cause: undefined })
    expect(message).toContain('could not reach GET http://llm-host:8555/v1/models')
    expect(message).not.toContain('—  .')
  })
})

describe('describeChatFailure', () => {
  it('names the endpoint, status and responder for a chat 403', () => {
    const err = Object.assign(new Error('Forbidden'), {
      statusCode: 403,
      url: 'https://api.example.com/v1/chat/completions',
      responseHeaders: { Server: 'cloudflare' },
    })
    const message = describeChatFailure(err, 'Poe')
    expect(message).toContain('Poe: POST https://api.example.com/v1/chat/completions returned 403')
    expect(message).toContain('answered by cloudflare')
  })

  it('leaves other errors unchanged', () => {
    expect(describeChatFailure(new Error('boom'), 'X')).toBe('boom')
    const err = Object.assign(new Error('Bad request'), {
      statusCode: 400,
      url: 'https://a.test/v1/chat/completions',
    })
    expect(describeChatFailure(err, 'X')).toBe('Bad request')
  })
})

describe('describeEndpointFailure: local 403', () => {
  it('points an Ollama user at OLLAMA_ORIGINS', () => {
    const message = describeEndpointFailure({
      provider: 'Ollama',
      url: 'http://127.0.0.1:11434/v1/models',
      status: 403,
      statusText: 'Forbidden',
    })
    expect(message).toContain('OLLAMA_ORIGINS')
  })

  it('does not mention it for a public endpoint', () => {
    const message = describeEndpointFailure({
      provider: 'X',
      url: 'https://api.example.com/v1/models',
      status: 403,
    })
    expect(message).not.toContain('OLLAMA_ORIGINS')
  })
})

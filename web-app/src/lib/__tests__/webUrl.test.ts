
// C087: copying a reply put the raw [[cite:URL]] markers on the clipboard.
describe('citationsForCopy', () => {
  it('turns cite markers into plain links', async () => {
    const { citationsForCopy } = await import('../webUrl')
    expect(
      citationsForCopy('Water boils.[[cite:https://a.org/x]] Ice melts. [[cite: b.com/y ]]')
    ).toBe('Water boils. (https://a.org/x) Ice melts. (https://b.com/y)')
    expect(citationsForCopy('no markers')).toBe('no markers')
  })
})

describe('faviconCandidates for hosts off the public internet', () => {
  it.each([
    'http://localhost:3000/x',
    'http://app.localhost/',
    'http://127.0.0.1/',
    'http://127.5.5.5:8080/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.100.1.1/',
    'http://[::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://printer.local/',
    'https://db.internal/',
    'http://intranet/',
  ])('returns nothing for %s', async (url) => {
    const { faviconCandidates, faviconUrl } = await import('../webUrl')
    expect(faviconCandidates(url)).toEqual([])
    expect(faviconUrl(url)).toBeNull()
  })

  it.each([
    'https://example.com/',
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://8.8.8.8/',
    'http://100.63.0.1/',
    'https://sub.example.co.uk/page',
  ])('still returns candidates for %s', async (url) => {
    const { faviconCandidates } = await import('../webUrl')
    expect(faviconCandidates(url).length).toBeGreaterThan(0)
  })
})

describe('faviconCandidates', () => {
  it('tries the site\'s own icon names in turn, and only for web addresses', async () => {
    const { faviconCandidates } = await import('../webUrl')
    expect(faviconCandidates('https://example.com/docs/page?q=1')).toEqual([
      'https://example.com/favicon.ico',
      'https://example.com/favicon.svg',
      'https://example.com/favicon.png',
      'https://example.com/apple-touch-icon.png',
    ])
    expect(faviconCandidates('file:///C:/x.html')).toEqual([])
    expect(faviconCandidates('nope')).toEqual([])
  })
})

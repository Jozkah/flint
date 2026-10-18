
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

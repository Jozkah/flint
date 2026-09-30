
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

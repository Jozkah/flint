# @jozkah/flint

The Flint agent harness CLI (`flint`) as an npm package.

```bash
npm install -g @jozkah/flint
flint            # interactive agent console
flint --help
```

The package is a thin launcher. On install it downloads the `flint` binary for
your platform from the matching [GitHub release](https://github.com/Jozkah/flint/releases)
and verifies its SHA-256 against the value recorded in this package. Set
`FLINT_SKIP_DOWNLOAD=1` to skip the download (for example when you supply the
binary yourself) and `FLINT_BIN` to point the launcher at a binary of your own.

Supported platforms: Linux x64 and arm64, macOS Apple silicon, Windows x64.

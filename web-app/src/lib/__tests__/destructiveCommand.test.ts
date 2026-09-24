import { describe, expect, it } from 'vitest'
import { destructiveCommandReason } from '../destructiveCommand'
import rules from '../destructiveCommandRules.json'

const WS = '/home/me/project'
const flagged = (cmd: string, ws = WS) =>
  destructiveCommandReason(cmd, ws) !== null

describe('destructiveCommandReason', () => {
  it('flags rm -rf outside the workspace', () => {
    for (const cmd of [
      'rm -rf /',
      'rm -rf /*',
      'rm -fr ~',
      'rm -rf ~/Documents',
      'rm -r -f $HOME',
      'sudo rm -rf /etc',
      'rm --recursive --force ../other',
      'cd x && rm -Rf /var/lib',
      'rm -rf /home/me/project/../secrets',
    ]) {
      expect(flagged(cmd), cmd).toBe(true)
    }
  })

  it('leaves ordinary deletes inside the workspace alone', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -rf ./target dist',
      'rm -rf /home/me/project/build',
      'rm file.txt',
      'rm -r build',
      "echo 'rm -rf /'",
    ]) {
      expect(flagged(cmd), cmd).toBe(false)
    }
  })

  it('flags git operations that lose work or history', () => {
    expect(flagged('git reset --hard HEAD~3')).toBe(true)
    expect(flagged('git clean -fdx')).toBe(true)
    expect(flagged('git clean -f -d')).toBe(true)
    expect(flagged('git push --force origin main')).toBe(true)
    expect(flagged('git push -f')).toBe(true)
    expect(flagged('git reset HEAD file')).toBe(false)
    expect(flagged('git clean -n')).toBe(false)
    expect(flagged('git push origin main')).toBe(false)
  })

  it('flags disks and databases', () => {
    expect(flagged('mkfs.ext4 /dev/sdb1')).toBe(true)
    expect(flagged('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true)
    expect(flagged('dd if=a.img of=b.img')).toBe(false)
    expect(flagged("psql -c 'DROP DATABASE prod'")).toBe(true)
    expect(flagged('dropdb prod')).toBe(true)
  })

  it('flags Windows commands', () => {
    const win = 'C:\\work\\proj'
    expect(flagged('Remove-Item -Recurse -Force C:\\Users\\me', win)).toBe(true)
    expect(flagged('Remove-Item C:\\ -Recurse -Force', win)).toBe(true)
    expect(
      flagged('Remove-Item -Recurse -Force C:\\work\\proj\\bin', win)
    ).toBe(false)
    expect(flagged('Remove-Item -Recurse -Force .\\bin', win)).toBe(false)
    expect(flagged('format C: /q', win)).toBe(true)
    expect(flagged('del /s /q *.*', win)).toBe(true)
    expect(flagged('rd /s /q C:\\Windows', win)).toBe(true)
    expect(flagged('rd /s /q build', win)).toBe(false)
    expect(flagged('del file.txt', win)).toBe(false)
  })

  // The same list the Rust side runs (destructive.rs,
  // every_shared_vector_gives_its_expected_verdict): a rule changed in one
  // implementation and not the other fails one of the two.
  it('gives the expected verdict for every shared vector', () => {
    expect(rules.cases.length).toBeGreaterThan(40)
    const wrong = rules.cases
      .map((c) => {
        const reason = destructiveCommandReason(c.command, c.workspace)
        const got = reason === null ? 'allow' : 'ask'
        return got === c.expect
          ? null
          : `${JSON.stringify(c.command)} -> ${got} (${reason})`
      })
      .filter(Boolean)
    expect(wrong).toEqual([])
  })

  it('asks about what it cannot check, and says why', () => {
    expect(destructiveCommandReason("echo 'oops", WS)).toMatch(
      /unbalanced quote/
    )
    expect(destructiveCommandReason('pwsh -enc AAAA', WS)).toMatch(/encoded/)
    expect(destructiveCommandReason('eval "$X"', WS)).toMatch(/eval/)
    let nested = 'ls'
    for (let i = 0; i < 8; i++) nested = `echo $(${nested})`
    expect(destructiveCommandReason(nested, WS)).not.toBeNull()
  })

  describe('approved scope', () => {
    const POSIX = ['/home/me/my project', '/tmp/scratch']
    const WIN = [String.raw`C:\Users\me\my project`]
    const rm = (p: string) => `rm -rf "${p}"`

    it('treats absolute paths inside any root as inside', () => {
      for (const p of [
        '/home/me/my project/build',
        '/home/me/my project/build/',
        '/home/me/my project/build/*',
        '/home/me/my project/./build',
        '/home/me/my project//build',
        '/tmp/scratch/out',
      ]) {
        expect(destructiveCommandReason(rm(p), POSIX), p).toBeNull()
      }
      for (const p of [
        String.raw`C:\Users\me\my project\build`,
        'c:/users/ME/My Project/build',
        String.raw`C:/Users\me/my project\build\ `.trimEnd(),
      ]) {
        expect(destructiveCommandReason(rm(p), WIN), p).toBeNull()
      }
      // A verbatim root is the same folder as its plain spelling.
      expect(
        destructiveCommandReason(rm(String.raw`C:\Users\me\my project\x`), [
          String.raw`\\?\C:\Users\me\my project`,
        ])
      ).toBeNull()
    })

    it('keeps asking outside the scope, for unknown scope and ambiguous paths', () => {
      for (const p of [
        // A sibling whose name starts with a root's.
        '/home/me/my project-other/build',
        '/home/me/my projectx',
        // Traversal: text cannot tell where `..` leads through a link.
        '/home/me/my project/../secrets',
        '/home/me/my project/build/../../x',
        '/home/me',
        '/',
      ]) {
        expect(destructiveCommandReason(rm(p), POSIX), p).not.toBeNull()
      }
      expect(
        destructiveCommandReason(
          rm(String.raw`C:\Users\me\my project-other`),
          WIN
        )
      ).not.toBeNull()
      // Drive-relative: its base directory is unknown.
      expect(destructiveCommandReason('rm -rf C:build', WIN)).not.toBeNull()
      // Unknown scope, and roots that vouch for nothing.
      expect(
        destructiveCommandReason(rm('/home/me/my project/b'), [])
      ).not.toBeNull()
      expect(destructiveCommandReason(rm('/etc'), ['/'])).not.toBeNull()
      expect(
        destructiveCommandReason(rm(String.raw`C:\Windows`), [
          String.raw`C:\ `.trim(),
        ])
      ).not.toBeNull()
      expect(
        destructiveCommandReason(rm('/home/me/my project/b'), ['my project'])
      ).not.toBeNull()
      // Unparseable, whatever the scope.
      expect(
        destructiveCommandReason('rm -rf "/home/me/my project/b', POSIX)
      ).not.toBeNull()
    })

    it('accepts a single root as before', () => {
      expect(
        destructiveCommandReason(
          rm('/home/me/my project/b'),
          '/home/me/my project'
        )
      ).toBeNull()
    })
  })
})

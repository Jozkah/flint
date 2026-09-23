import { describe, expect, it } from 'vitest'
import { destructiveCommandReason } from '../destructiveCommand'

const WS = '/home/me/project'
const flagged = (cmd: string, ws = WS) => destructiveCommandReason(cmd, ws) !== null

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
    expect(flagged('Remove-Item -Recurse -Force C:\\work\\proj\\bin', win)).toBe(false)
    expect(flagged('Remove-Item -Recurse -Force .\\bin', win)).toBe(false)
    expect(flagged('format C: /q', win)).toBe(true)
    expect(flagged('del /s /q *.*', win)).toBe(true)
    expect(flagged('rd /s /q C:\\Windows', win)).toBe(true)
    expect(flagged('rd /s /q build', win)).toBe(false)
    expect(flagged('del file.txt', win)).toBe(false)
  })
})

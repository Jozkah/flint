import { describe, it, expect } from 'vitest'
import {
  classifyPath,
  isExecutablePath,
  isInsideRoots,
  normalizePath,
  parseInlinePath,
  parsePathHref,
  pathHref,
  toOsPath,
} from '@/lib/pathOpen'

describe('parseInlinePath', () => {
  it('accepts relative source paths with an optional line', () => {
    expect(parseInlinePath('src/a.ts')).toMatchObject({ path: 'src/a.ts', absolute: false })
    expect(parseInlinePath('src/a.ts:12')).toMatchObject({ path: 'src/a.ts', line: 12 })
    expect(parseInlinePath('src/a.ts:12-20')).toMatchObject({ line: 12, endLine: 20 })
    expect(parseInlinePath('src/a.ts:12:5')).toMatchObject({ line: 12 })
    expect(parseInlinePath('./src/a.ts')).toMatchObject({ path: 'src/a.ts' })
    expect(parseInlinePath('package.json')).toMatchObject({ path: 'package.json' })
    expect(parseInlinePath('src\\a.ts')).toMatchObject({ path: 'src/a.ts' })
  })

  it('rejects things that only look path-like', () => {
    for (const v of [
      'npm install',
      'v1.2.3',
      '1.2',
      'e.g.',
      'i.e.',
      'foo.bar()',
      'foo.bar',
      'Node.js',
      'next.js',
      'and/or',
      'example.com/page',
      'https://example.com/a.ts',
      'foo',
      '~/a.ts',
      '../a.ts',
      'a/../../b.ts',
      '..',
      '.',
      '/',
      'C:\\',
      '$HOME/a.ts',
      'a.ts | b.ts',
      '',
    ]) {
      expect(parseInlinePath(v), v).toBeNull()
    }
  })

  it('accepts absolute paths, folders and UNC', () => {
    expect(parseInlinePath('/work/proj/src')).toMatchObject({ absolute: true, path: '/work/proj/src' })
    expect(parseInlinePath('C:\\Users\\me\\My Docs\\a.pdf')).toMatchObject({
      absolute: true,
      path: 'C:/Users/me/My Docs/a.pdf',
    })
    expect(parseInlinePath('c:/x/y/')).toMatchObject({ path: 'C:/x/y' })
    expect(parseInlinePath('\\\\srv\\share\\a.txt')).toMatchObject({ path: '//srv/share/a.txt' })
  })

  it('does not allow spaces outside Windows paths', () => {
    expect(parseInlinePath('/work/my dir/a.ts')).toBeNull()
  })
})

describe('normalizePath', () => {
  it('resolves dot segments and refuses to climb out', () => {
    expect(normalizePath('/a/b/../c')?.path).toBe('/a/c')
    expect(normalizePath('/a/./b//c/')?.path).toBe('/a/b/c')
    expect(normalizePath('/..')).toBeNull()
    expect(normalizePath('C:\\a\\..\\..\\b')).toBeNull()
    expect(normalizePath('\\\\srv\\share\\..\\x')).toBeNull()
    expect(normalizePath('\\\\srv')).toBeNull()
  })
})

describe('isInsideRoots', () => {
  it('matches the folder itself and its children', () => {
    expect(isInsideRoots(['/work/proj'], '/work/proj')).toBe(true)
    expect(isInsideRoots(['/work/proj'], '/work/proj/src/a.ts')).toBe(true)
  })

  it('rejects a sibling that shares the prefix', () => {
    expect(isInsideRoots(['/work/proj'], '/work/proj2/a.ts')).toBe(false)
    expect(isInsideRoots(['C:\\work\\proj'], 'C:\\work\\proj2\\a.ts')).toBe(false)
  })

  it('rejects traversal out of the folder', () => {
    expect(isInsideRoots(['/work/proj'], '/work/proj/../secret')).toBe(false)
    expect(isInsideRoots(['/work/proj'], '/work/proj/../proj/a.ts')).toBe(true)
  })

  it('ignores case and separators on Windows and UNC, not on POSIX', () => {
    expect(isInsideRoots(['C:\\Work\\Proj'], 'c:/work/proj/SRC/a.ts')).toBe(true)
    expect(isInsideRoots(['\\\\Srv\\Share\\p'], '//srv/share/p/a.txt')).toBe(true)
    expect(isInsideRoots(['/Work/Proj'], '/work/proj/a.ts')).toBe(false)
  })

  it('never treats a filesystem root or relative root as containing everything', () => {
    expect(isInsideRoots(['/'], '/etc/passwd')).toBe(false)
    expect(isInsideRoots(['C:\\'], 'C:\\Windows')).toBe(false)
    expect(isInsideRoots(['proj'], '/proj/a.ts')).toBe(false)
    expect(isInsideRoots([], '/a')).toBe(false)
  })
})

describe('classifyPath', () => {
  const roots = ['C:\\work\\proj']
  const abs = (v: string) => parseInlinePath(v)!

  it('sends source files inside a folder to the Code panel when there is one', () => {
    expect(classifyPath(abs('C:\\work\\proj\\src\\a.ts'), { roots, canOpenInCode: true })).toEqual({
      kind: 'code',
      path: 'C:/work/proj/src/a.ts',
    })
  })

  it('opens in the OS when there is no Code panel, or the file is not source', () => {
    expect(classifyPath(abs('C:\\work\\proj\\src\\a.ts'), { roots, canOpenInCode: false })).toEqual({
      kind: 'open',
      path: 'C:\\work\\proj\\src\\a.ts',
    })
    expect(classifyPath(abs('C:\\work\\proj\\logo.png'), { roots, canOpenInCode: true }).kind).toBe('open')
    expect(classifyPath(abs('C:\\work\\proj\\docs'), { roots, canOpenInCode: true }).kind).toBe('open')
  })

  it('only reveals executables', () => {
    for (const f of ['a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.lnk', 'a.msi', 'a.sh', 'a.APP', 'a.com', 'a.scr']) {
      expect(classifyPath(abs(`C:\\work\\proj\\${f}`), { roots, canOpenInCode: true }).kind, f).toBe('reveal')
    }
    expect(isExecutablePath('/x/run.sh')).toBe(true)
    expect(isExecutablePath('/x/.sh')).toBe(false)
  })

  it('leaves anything outside the folders as plain text', () => {
    expect(classifyPath(abs('C:\\Windows\\System32\\cmd.exe'), { roots, canOpenInCode: true })).toEqual({ kind: 'none' })
    expect(classifyPath(abs('C:\\work\\proj2\\a.ts'), { roots, canOpenInCode: true })).toEqual({ kind: 'none' })
    expect(classifyPath(abs('/etc/passwd'), { roots: [], canOpenInCode: true })).toEqual({ kind: 'none' })
  })

  it('links relative source paths only where the Code panel exists', () => {
    const rel = parseInlinePath('src/a.ts')!
    expect(classifyPath(rel, { roots: [], canOpenInCode: true })).toEqual({ kind: 'code', path: 'src/a.ts' })
    expect(classifyPath(rel, { roots, canOpenInCode: false })).toEqual({ kind: 'none' })
  })
})

describe('href round trip', () => {
  it('re-validates the href', () => {
    expect(parsePathHref(pathHref('src/a.ts:3'))).toMatchObject({ path: 'src/a.ts', line: 3 })
    expect(parsePathHref(pathHref('npm install'))).toBeNull()
    expect(parsePathHref('#other')).toBeNull()
    expect(parsePathHref('#coworkpath-%E0%A4%A')).toBeNull()
  })

  it('toOsPath uses backslashes for drive and UNC only', () => {
    expect(toOsPath('C:/a/b')).toBe('C:\\a\\b')
    expect(toOsPath('//s/h/x')).toBe('\\\\s\\h\\x')
    expect(toOsPath('/a/b')).toBe('/a/b')
  })
})

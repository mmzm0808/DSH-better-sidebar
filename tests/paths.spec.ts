import { describe, expect, it } from 'vitest'
import { dirsToReveal, isAbsolutePath, relativeTo, toPosix } from '../src/client/paths.ts'
import { resolveSidebarPath } from '../src/client/produced-files.ts'
import { htmlUrl } from '../src/client/api.ts'

describe('path helpers', () => {
  it('derives relative paths under the cwd (and "." for the cwd itself)', () => {
    expect(relativeTo('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/code')).toBe('.')
    expect(relativeTo('/Users/me/code/', '/Users/me/code/src/a/b.ts')).toBe('src/a/b.ts')
  })

  it('falls back to the path unchanged when it lies outside the cwd', () => {
    expect(relativeTo('/Users/me/code', '/Users/other/x.ts')).toBe('/Users/other/x.ts')
    expect(relativeTo('/Users/me/code', '/Users/me/codex/y.ts')).toBe('/Users/me/codex/y.ts')
  })

  it('handles windows roots and mixed separators', () => {
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\me\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me', 'C:/Users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\me\\', 'C:\\Users\\me')).toBe('.')
  })

  it('containment is case-insensitive (windows/macOS case-insensitive volumes)', () => {
    expect(relativeTo('C:\\Users\\Me', 'c:/users/me/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/Users/Me/code', '/users/me/code/src/main.ts')).toBe('src/main.ts')
    // The returned relative text keeps the caller's own casing.
    expect(relativeTo('C:\\Users\\me', 'C:\\Users\\Me\\SRC\\a.ts')).toBe('SRC/a.ts')
  })

  it('resolves produced paths against windows cwds', () => {
    expect(resolveSidebarPath('C:\\work\\proj', 'src/a.ts')).toBe('C:\\work\\proj\\src/a.ts')
    expect(resolveSidebarPath('C:\\work\\proj', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj\\', 'C:\\abs\\x.ts')).toBe('C:\\abs\\x.ts')
  })

  it('keeps UNC produced paths absolute instead of joining them onto the cwd', () => {
    // Pure client function: UNC detection is platform-independent, so these
    // assertions run on every host without a platform guard.
    expect(resolveSidebarPath('C:\\work\\proj', '\\\\server\\share\\abs\\x.ts'))
      .toBe('\\\\server\\share\\abs\\x.ts')
    expect(resolveSidebarPath('C:\\work\\proj', '//server/share/abs/x.ts'))
      .toBe('//server/share/abs/x.ts')
    // A relative path under a UNC cwd joins with backslashes.
    expect(resolveSidebarPath('\\\\server\\share\\proj', 'src/a.ts'))
      .toBe('\\\\server\\share\\proj\\src/a.ts')
  })

  it('mirrors the host absolute-path notion without node:path', () => {
    expect(isAbsolutePath('/abs/x.ts')).toBe(true)
    expect(isAbsolutePath('C:\\abs\\x.ts')).toBe(true)
    expect(isAbsolutePath('C:/abs/x.ts')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\x.ts')).toBe(true)
    expect(isAbsolutePath('//server/share/x.ts')).toBe(true)
    expect(isAbsolutePath('C:relative.ts')).toBe(false)
    expect(isAbsolutePath('rel/x.ts')).toBe(false)
  })

  it('htmlUrl always marks UNC paths (platform-neutral marker)', () => {
    // The marker is platform-neutral now: the host resolves the decoded
    // '//server/share/...' form per-platform, so no cwd/OS signal is needed.
    expect(htmlUrl({ sessionId: 's' }, '\\\\server\\share\\proj\\a.html'))
      .toBe('/sidebar/html/s//server/share/proj/a.html')
    expect(htmlUrl({ sessionId: 's', cwd: '/home/me' }, '//server/share/a.html'))
      .toBe('/sidebar/html/s//server/share/a.html')
    expect(htmlUrl({ sessionId: 's', cwd: '/home/me' }, '/home/me/index.html'))
      .toBe('/sidebar/html/s/home/me/index.html')
  })
})

describe('dirsToReveal', () => {
  it('lists every ancestor dir from the cwd down to the file parent', () => {
    expect(dirsToReveal('/p/a/b/f.ts', '/p')).toEqual(['/p', '/p/a', '/p/a/b'])
    expect(dirsToReveal('/p/f.ts', '/p')).toEqual(['/p'])
  })

  it('normalizes windows separators (posix form, matching fs-tree entries)', () => {
    expect(dirsToReveal('C:\\Users\\me\\src\\a.ts', 'C:\\Users\\me')).toEqual(['C:/Users/me', 'C:/Users/me/src'])
    expect(dirsToReveal('C:\\Users\\me\\a.ts', 'C:\\Users\\me\\')).toEqual(['C:/Users/me'])
  })

  it('returns [] outside the cwd or for the cwd itself', () => {
    expect(dirsToReveal('/other/f.ts', '/p')).toEqual([])
    expect(dirsToReveal('/p', '/p')).toEqual([])
    // A sibling prefix must not count as containment.
    expect(dirsToReveal('/p-other/f.ts', '/p')).toEqual([])
  })

  it('containment is case-insensitive (case-insensitive volumes)', () => {
    expect(dirsToReveal('/P/A/F.TS', '/p')).toEqual(['/p', '/P/A'])
  })

  it('toPosix normalizes backslashes', () => {
    expect(toPosix('C:\\a\\b\\c.ts')).toBe('C:/a/b/c.ts')
    expect(toPosix('/a/b/c.ts')).toBe('/a/b/c.ts')
  })
})

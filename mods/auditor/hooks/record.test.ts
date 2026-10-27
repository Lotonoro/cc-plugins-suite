import { describe, expect, test } from 'claude-code/testing'
import { clip, entryBlock, splitPages, toolLine } from './record'

describe('clip', () => {
  test('text within the bound is returned as it is, with no marker', () => {
    expect(clip('abc', 3)).toBe('abc')
  })

  test('a cut text is its first characters, then the count cut', () => {
    expect(clip('abcd', 3)).toBe('abc …+1 characters')
  })

  test('a surrogate pair is one character for the bound and for the count', () => {
    expect(clip('😀😀😀', 2)).toBe('😀😀 …+1 characters')
  })
})

describe('toolLine', () => {
  test('a worker call shows its tool, its input and its result', () => {
    expect(toolLine({ tool: 'Edit', input: { file_path: 'p.ts' }, text: 'edited', isError: false })).toBe('TOOL Edit({"file_path":"p.ts"}) -> edited')
  })

  test('a call a subagent made names the agent it ran in', () => {
    expect(toolLine({ tool: 'Grep', input: { pattern: 'x' }, agent: 'sub1 (Explore, scan)', text: '3 matches', isError: false })).toBe('TOOL [agent sub1 (Explore, scan)] Grep({"pattern":"x"}) -> 3 matches')
  })

  test('an error result is marked as one', () => {
    expect(toolLine({ tool: 'Bash', input: { command: 'ls' }, text: 'no such file', isError: true })).toBe('TOOL Bash({"command":"ls"}) -> ERROR no such file')
  })

  test('input is clipped to 300 characters and the result to 500, each with the count of characters cut', () => {
    const line = toolLine({ tool: 'Write', input: { content: 'x'.repeat(5000) }, text: 'y'.repeat(5000), isError: false })
    expect(line).toBe(`TOOL Write(${JSON.stringify({ content: 'x'.repeat(5000) }).slice(0, 300)} …+4714 characters) -> ${'y'.repeat(500)} …+4500 characters`)
  })

  test('an astral character counts as one character, so the cut keeps it whole and the count is in characters', () => {
    // The text is 509 characters: the 500-character cut keeps the emoji whole, and the 9 characters after it are counted.
    const line = toolLine({ tool: 'Bash', input: { command: 'ls' }, text: 'y'.repeat(498) + '😀' + 'z'.repeat(10), isError: false })
    expect(line).toBe(`TOOL Bash({"command":"ls"}) -> ${'y'.repeat(498)}😀z …+9 characters`)
    // The input's emoji is the 299th character of its JSON; the 300-character cut keeps the closing quote and counts the brace after it.
    const input = toolLine({ tool: 'Write', input: { c: 'x'.repeat(292) + '😀' }, text: 'ok', isError: false })
    expect(input).toBe(`TOOL Write({"c":"${'x'.repeat(292)}😀" …+1 characters) -> ok`)
    expect(input).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  test('a multi-byte result is clipped by characters, so the count is characters, not UTF-8 bytes', () => {
    // 600 é are 1,200 bytes: the cut keeps 500 characters and counts the 100 after them.
    const line = toolLine({ tool: 'Bash', input: { command: 'ls' }, text: 'é'.repeat(600), isError: false })
    expect(line).toBe(`TOOL Bash({"command":"ls"}) -> ${'é'.repeat(500)} …+100 characters`)
  })

  test('input of exactly 300 characters is shown whole, with no ellipsis', () => {
    const input = { c: 'x'.repeat(292) }
    expect(JSON.stringify(input).length).toBe(300)
    const line = toolLine({ tool: 'Write', input, text: 'ok', isError: false })
    expect(line).toBe(`TOOL Write(${JSON.stringify(input)}) -> ok`)
    expect(line.includes('…')).toBe(false)
  })
})

describe('entryBlock', () => {
  test('an entry is numbered and ends in a blank line, so the next entry starts a new block', () => {
    expect(entryBlock(3, 'USER: fix')).toBe('[3] USER: fix\n\n')
  })

  test('a multi-line entry keeps its lines whole inside its block', () => {
    expect(entryBlock(1, 'ASSISTANT: a\nb')).toBe('[1] ASSISTANT: a\nb\n\n')
  })
})

describe('splitPages', () => {
  const header = (first: number, last: number) => `E${first}-${last}\n`
  const bytes = (text: string) => new TextEncoder().encode(text).length

  test('blocks that fit stay in one page, header first', () => {
    expect(splitPages(['a\n', 'b\n'], header, 100)).toEqual([{ first: 1, last: 2, text: 'E1-2\na\nb\n' }])
  })

  test('no blocks, no pages', () => {
    expect(splitPages([], header, 100)).toEqual([])
  })

  test('a page is closed before the block that would carry it, header included, past the limit', () => {
    // 'E1-2\n' (5) + 'aaaa' (4) + 'bbbb' (4) = 13 bytes: one over 12, so 'bbbb' opens page 2.
    expect(splitPages(['aaaa', 'bbbb'], header, 12)).toEqual([
      { first: 1, last: 1, text: 'E1-1\naaaa' },
      { first: 2, last: 2, text: 'E2-2\nbbbb' },
    ])
    // At exactly the limit, the block stays.
    expect(splitPages(['aaaa', 'bbb'], header, 12)).toEqual([{ first: 1, last: 2, text: 'E1-2\naaaabbb' }])
  })

  test('the limit is in bytes: multi-byte blocks split where characters alone would fit', () => {
    // 'éé' is 2 characters, 4 bytes.
    const pages = splitPages(['éé', 'éé'], header, 12)
    expect(pages.map(p => [p.first, p.last])).toEqual([[1, 1], [2, 2]])
    for (const p of pages) expect(bytes(p.text)).toBeLessThanOrEqual(12)
  })

  test('every block is whole in exactly one page, in order', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => entryBlock(i + 1, 'x'.repeat(i % 7)))
    const pages = splitPages(blocks, header, 60)
    expect(pages.map(p => p.text.slice(header(p.first, p.last).length)).join('')).toBe(blocks.join(''))
    expect(pages.map(p => p.first)).toEqual([1, ...pages.slice(0, -1).map(p => p.last + 1)])
    for (const p of pages) expect(bytes(p.text)).toBeLessThanOrEqual(60)
  })

  test('a block too big for a page alone is clipped to fit, marked, and never splits a character', () => {
    const [page, ...rest] = splitPages(['é'.repeat(200)], header, 100)
    expect(rest).toEqual([])
    expect(bytes(page?.text ?? '')).toBeLessThanOrEqual(100)
    // 37 é fill the 74 bytes left after the 19-byte mark and the blank line; the 163 characters after them are counted.
    expect(page?.text).toBe(`E1-1\n${'é'.repeat(37)} …+163 characters\n\n`)
  })

  test('a first block that exactly fills the page is kept whole, not clipped', () => {
    const block = 'a'.repeat(12 - header(1, 1).length)
    const [page, ...rest] = splitPages([block], header, 12)
    expect(rest).toEqual([])
    expect(page?.text).toBe(header(1, 1) + block)
  })
})

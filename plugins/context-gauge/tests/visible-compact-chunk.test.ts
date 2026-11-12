import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { chunkMessages, chunkText, fenced, messageText } from '../hooks/visible-compact/chunk'

const squash = (s: string) => s.replace(/\s+/g, '')

const message = (m: Partial<SessionMessage> & Pick<SessionMessage, 'role'>): SessionMessage =>
  ({ text: '', toolUses: [], ...m }) as SessionMessage

describe('chunkText', () => {
  test('short text is one chunk', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world'])
  })

  test('empty or blank text gives no chunks', () => {
    expect(chunkText('', 100)).toEqual([])
    expect(chunkText('  \n\n  ', 100)).toEqual([])
  })

  test('paragraphs pack together up to the limit', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc\n\ndddd'
    expect(chunkText(text, 14)).toEqual(['aaaa\n\nbbbb', 'cccc\n\ndddd'])
  })

  test('a long paragraph is cut at a line break first', () => {
    const text = 'a'.repeat(6) + '\n' + 'b'.repeat(6)
    expect(chunkText(text, 10)).toEqual(['a'.repeat(6), 'b'.repeat(6)])
  })

  test('a long line is cut at a space before cutting a word', () => {
    expect(chunkText('alpha beta gamma', 11)).toEqual(['alpha beta', 'gamma'])
  })

  test('a word longer than the limit is cut hard', () => {
    expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  })

  test('no chunk is over the limit, and nothing but whitespace is lost', () => {
    const para = (n: number) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ')
    const text = [para(3), para(80), para(20) + '\n' + para(30), 'z'.repeat(300), para(5)].join('\n\n')
    for (const max of [20, 64, 150, 1000]) {
      const chunks = chunkText(text, max)
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(max)
      expect(squash(chunks.join(''))).toBe(squash(text))
    }
  })

  test('a code block with blank lines in it stays whole', () => {
    const block = '```ts\nconst a = 1\n\nconst b = 2\n\nconst c = 3\n```'
    const text = 'intro\n\n' + block + '\n\noutro'
    const chunks = chunkText(text, 50)
    expect(chunks).toContain(block)
  })

  test('a code block moves to the next chunk rather than being cut', () => {
    const block = '```\nline one\n\nline two\n```'
    const chunks = chunkText('p'.repeat(20) + '\n\n' + block, 40)
    expect(chunks).toEqual(['p'.repeat(20), block])
  })

  test('a code block too long for one chunk reopens its fence on every part', () => {
    const body = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n')
    const chunks = chunkText('```py\n' + body + '\n```', 60)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(60)
      expect(c.startsWith('```py\n')).toBe(true)
      expect(c.endsWith('\n```')).toBe(true)
    }
    const inner = chunks.map(c => c.slice('```py\n'.length, -'\n```'.length)).join('\n')
    expect(inner).toBe(body)
  })

  test('a longer fence is closed only by a run at least as long', () => {
    const block = '````md\n```js\nx\n```\n\nstill inside\n````'
    expect(chunkText(block + '\n\nafter', 40)).toEqual([block, 'after'])
  })

  test('tilde fences count as code blocks too', () => {
    const block = '~~~\na\n\nb\n~~~'
    expect(chunkText('x'.repeat(10) + '\n\n' + block, 16)).toEqual(['x'.repeat(10), block])
  })

  test('every chunk has its fences paired, so each draws on its own', () => {
    const code = (n: number) => '```\n' + Array.from({ length: n }, (_, i) => 'code ' + i).join('\n\n') + '\n```'
    const text = ['prose one', code(4), 'prose two '.repeat(20), code(60), 'end'].join('\n\n')
    for (const max of [80, 200, 4000]) {
      for (const c of chunkText(text, max)) {
        expect(c.length).toBeLessThanOrEqual(max)
        expect((c.match(/^```/gm) ?? []).length % 2).toBe(0)
      }
    }
  })

  test('chunks stay within what one Markdown element draws', () => {
    const text = 'word '.repeat(5000) + '\n\n```\n' + 'x'.repeat(20000) + '\n```'
    for (const c of chunkText(text)) expect(c.length).toBeLessThanOrEqual(10000)
  })

  test('chunks have no trailing whitespace', () => {
    for (const c of chunkText('one\n\n\ntwo  \n\nthree\n', 8)) expect(c).toBe(c.trimEnd())
  })
})

describe('messageText', () => {
  test('prose alone', () => {
    expect(messageText(message({ role: 'user', text: 'hi' }))).toBe('hi')
  })

  test('prose, then tool calls with their input', () => {
    const m = message({
      role: 'assistant',
      text: 'Reading it.',
      toolUses: [{ tool: 'Read', input: { file_path: '/a.ts' } }] as SessionMessage['toolUses'],
    })
    expect(messageText(m)).toBe('Reading it.\n\n[tool: Read]\n```json\n{\n  "file_path": "/a.ts"\n}\n```')
  })

  test('tool results, with errors marked', () => {
    const m = message({
      role: 'user',
      toolResults: [
        { text: 'ok', isError: false },
        { text: 'boom', isError: true },
      ] as SessionMessage['toolResults'],
    })
    expect(messageText(m)).toBe('[result]\n```\nok\n```\n\n[result (error)]\n```\nboom\n```')
  })

  test('a result keeps its own fences inside a longer one', () => {
    const m = message({
      role: 'user',
      toolResults: [{ text: 'see\n```ts\nx\n```', isError: false }] as SessionMessage['toolResults'],
    })
    expect(messageText(m)).toBe('[result]\n````\nsee\n```ts\nx\n```\n````')
  })
})

describe('fenced', () => {
  test('uses three backticks, or one more than the longest run inside', () => {
    expect(fenced('a')).toBe('```\na\n```')
    expect(fenced('a `b` c', 'md')).toBe('```md\na `b` c\n```')
    expect(fenced('`````')).toBe('``````\n`````\n``````')
  })

  test('a long result with blank lines splits into chunks that each draw as code', () => {
    const source = Array.from({ length: 1500 }, (_, i) => (i % 5 === 0 ? '' : '  line ' + i)).join('\n')
    const chunks = chunkText('[result]\n' + fenced(source))
    expect(chunks.length).toBeGreaterThan(1)
    // The label stays with the start of its code instead of sitting alone.
    expect(chunks[0]!.startsWith('[result]\n```\n')).toBe(true)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4000)
      expect((c.match(/^```/gm) ?? []).length).toBe(2)
    }
  })
})

describe('chunkMessages', () => {
  test('numbers each chunk within its message and keeps the role', () => {
    const long = Array.from({ length: 3 }, (_, i) => String(i).repeat(3000)).join('\n\n')
    const chunks = chunkMessages([
      message({ role: 'user', text: 'question' }),
      message({ role: 'assistant', text: long }),
    ])
    expect(chunks.map(({ m, role, i, n }) => ({ m, role, i, n }))).toEqual([
      { m: 0, role: 'user', i: 0, n: 1 },
      { m: 1, role: 'assistant', i: 0, n: 3 },
      { m: 1, role: 'assistant', i: 1, n: 3 },
      { m: 1, role: 'assistant', i: 2, n: 3 },
    ])
  })

  test('a message with no text yields no chunks but keeps later indexes', () => {
    const chunks = chunkMessages([message({ role: 'assistant' }), message({ role: 'user', text: 'x' })])
    expect(chunks).toEqual([{ m: 1, role: 'user', i: 0, n: 1, text: 'x' }])
  })
})

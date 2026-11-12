import { expect, test } from 'claude-code/testing'

import {
  MINUTE,
  TTL_1H,
  TTL_5M,
  cacheView,
  chunkSummary,
  compactHeadline,
  hitRate,
  readTranscriptTail,
  shortTokens,
  level,
} from '../hooks/logic'

const BAND = {
  plugin: 'context-gauge',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const row = (timestamp: string, written: Record<string, number>, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp, message: { usage: { cache_creation: written } }, ...extra })

test('the bar drains, turns yellow in the last quarter, red in the last tenth', () => {
  expect(cacheView(0, TTL_1H, 0)).toEqual({ minutes: 60, filled: 20, color: 'green', isExpired: false })
  expect(cacheView(0, TTL_1H, 30 * MINUTE).filled).toBe(10)
  expect(cacheView(0, TTL_1H, 45 * MINUTE).color).toBe('yellow')
  expect(cacheView(0, TTL_1H, 54 * MINUTE).color).toBe('red')
  expect(cacheView(0, TTL_1H, 60 * MINUTE)).toEqual({ minutes: 0, filled: 0, color: 'red', isExpired: true })
  expect(cacheView(0, TTL_5M, 4 * MINUTE).minutes).toBe(1)
})

test('the hit rate is the cached share of all input tokens', () => {
  expect(hitRate({ input_tokens: 2, cache_read_input_tokens: 98, cache_creation_input_tokens: 0 })).toBe(98)
  expect(hitRate({ input_tokens: 10, cache_read_input_tokens: 45, cache_creation_input_tokens: 45 })).toBe(45)
  expect(hitRate({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
})

test('the dot turns yellow past 100k, orange past 150k, red past 200k tokens', () => {
  expect(level(null)).toBe('🟢')
  expect(level(100_000)).toBe('🟢')
  expect(level(100_001)).toBe('🟡')
  expect(level(150_000)).toBe('🟡')
  expect(level(150_001)).toBe('🟠')
  expect(level(200_000)).toBe('🟠')
  expect(level(200_001)).toBe('🔴')
})

test('the headline names the tokens before and after', () => {
  expect(compactHeadline(184000, 12300)).toBe('Compact: 184,000 → 12,300 Tokens (−93%)')
  expect(compactHeadline(undefined, 12300)).toBe('Compact: unknown → 12,300 Tokens')
})

test('token counts are shortened to k and M', () => {
  expect(shortTokens(840)).toBe('840')
  expect(shortTokens(112_400)).toBe('112k')
  expect(shortTokens(999_600)).toBe('1M')
  expect(shortTokens(1_000_000)).toBe('1M')
  expect(shortTokens(1_500_000)).toBe('1.5M')
})

test('a long summary is cut at paragraphs and loses no word', () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40).trim()}`)
  const chunks = chunkSummary(paragraphs.join('\n\n'), 500)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500)
  expect(chunks.join('\n\n')).toBe(paragraphs.join('\n\n'))
})

test('a paragraph longer than a chunk is cut at a space', () => {
  const chunks = chunkSummary('word '.repeat(300).trim(), 100)
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
  expect(chunks.join(' ').split(' ').length).toBe(300)
})

test('the cache lifetime and last response come from the transcript', () => {
  const at = '2026-11-02T14:00:00.000Z'
  const earlier = row('2026-11-02T13:00:00.000Z', { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 })
  const latest = row(at, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 })
  expect(readTranscriptTail(`${earlier}\n${latest}\nnot json`)).toEqual({ ttlMs: TTL_1H, lastAt: Date.parse(at) })
  expect(readTranscriptTail(row(at, { ephemeral_5m_input_tokens: 3 })).ttlMs).toBe(TTL_5M)
  expect(readTranscriptTail(row(at, { ephemeral_5m_input_tokens: 3 }, { isSidechain: true }))).toEqual({})
})

function seed(on: Parameters<Parameters<typeof test>[1]>[1], values: Record<string, unknown>) {
  on('state.get', (_, e) => ({ value: { value: values[e.key], version: 1 } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}

const DATA = {
  lastAt: Date.now(),
  ttlMs: TTL_1H,
  hitRate: 97,
  tokens: 250_000,
  window: 1_000_000,
}

test('the band draws every figure and the Compact button, on the terminal and on desktop', async ($, on) => {
  seed(on, { data: DATA, tick: 1, collapsed: false, compact: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /60 min|59 min/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /97%/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /🔴/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /250k \/ 1M/ }))).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Auto-Compact/ })).toBeFalsy()
    expect((await ui.find({ type: 'Button', key: 'compact' }))).toBeTruthy()
    expect((await ui.find({ type: 'Button', key: 'last-compact' }))).toBeTruthy()
    await ui.unmount()
  }
})

test('collapsed it keeps the dot, the cache time and the context alone', async ($, on) => {
  seed(on, { data: DATA, tick: 1, collapsed: true, compact: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /🔴/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /250k \/ 1M/ }))).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /97%/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('with the time up it reads expired', async ($, on) => {
  seed(on, { data: { ...DATA, lastAt: Date.now() - 2 * TTL_1H }, tick: 1, collapsed: false, compact: null })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /expired/ })).toBeTruthy()
  await ui.unmount()
})

for (const [status, label] of [['shown', 'Shown ✓'], ['loading', 'Loading…'], [null, 'Last compact']] as const) {
  test(`the Last compact button reads ${label} while its status is ${status}`, async ($, on) => {
    seed(on, { data: DATA, tick: 1, collapsed: false, compact: null, lastStatus: status })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const button = await ui.find({ type: 'Button', key: 'last-compact' })
    expect(JSON.stringify(button)).toContain(label)
    await ui.unmount()
  })
}

for (const isCollapsed of [false, true]) {
  test(`the figures are one button that folds the band (collapsed: ${isCollapsed})`, async ($, on) => {
    seed(on, { data: DATA, tick: 1, collapsed: isCollapsed, compact: null, lastStatus: null })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const band = await ui.find({ type: 'Button', key: 'band' })
      expect(JSON.stringify(band)).toContain('250k / 1M')
      await ui.unmount()
    }
  })
}

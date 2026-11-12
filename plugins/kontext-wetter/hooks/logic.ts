export const MINUTE = 60_000
export const TTL_5M = 5 * MINUTE
export const TTL_1H = 60 * MINUTE
export const BAR_CELLS = 20
// The terminal draws the first 2000 characters of a log line; a header line rides on top of this.
export const LOG_CHARS = 1900

export type Usage = {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type CacheView = {
  minutes: number
  filled: number
  color: 'green' | 'yellow' | 'red'
  isExpired: boolean
}

export function cacheView(lastAt: number, ttlMs: number, now: number): CacheView {
  const remaining = Math.max(0, lastAt + ttlMs - now)
  const ratio = remaining / ttlMs

  return {
    minutes: Math.ceil(remaining / MINUTE),
    filled: Math.ceil(ratio * BAR_CELLS),
    color: ratio <= 0.1 ? 'red' : ratio <= 0.25 ? 'yellow' : 'green',
    isExpired: remaining === 0,
  }
}

// The share of a response's input tokens the cache served, 0 to 100.
export function hitRate(usage: Usage): number | null {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

  return total > 0 ? Math.round((usage.cache_read_input_tokens / total) * 100) : null
}

// Fixed token counts, whatever the window: answers stay sharp up to about 100k,
// from 200k on it is time to compact or start a new session.
export const GREEN_TOKENS = 100_000
export const YELLOW_TOKENS = 150_000
export const ORANGE_TOKENS = 200_000

export type Weather = '🟢' | '🟡' | '🟠' | '🔴'

export function weather(tokens: number | null): Weather {
  const used = tokens ?? 0
  if (used <= GREEN_TOKENS) return '🟢'
  if (used <= YELLOW_TOKENS) return '🟡'

  return used <= ORANGE_TOKENS ? '🟠' : '🔴'
}

export function formatTokens(tokens: number): string {
  return String(tokens).replace(/\B(?=(\d{3})+$)/g, ',')
}

// Short token counts for the band: 840, 112k, 1M, 1.5M.
export function shortTokens(tokens: number): string {
  const thousands = Math.round(tokens / 1000)
  if (tokens < 1000) return String(tokens)
  if (thousands < 1000) return `${thousands}k`

  return `${Number((tokens / 1_000_000).toFixed(1))}M`
}

export function compactHeadline(before: number | undefined, after: number | undefined): string {
  const side = (n: number | undefined) => (n === undefined ? 'unknown' : formatTokens(n))
  const saved = before && after !== undefined ? ` (−${Math.round((1 - after / before) * 100)}%)` : ''

  return `Compact: ${side(before)} → ${side(after)} Tokens${saved}`
}

function cut(text: string, max: number, at: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const end = rest.lastIndexOf(at, max - at.length)
    const stop = end > 0 ? end + at.length : max
    out.push(rest.slice(0, stop))
    rest = rest.slice(stop)
  }
  if (rest) out.push(rest)

  return out
}

// Packs whole paragraphs into chunks; only a paragraph longer than a chunk is cut, at a line, a space, or anywhere.
export function chunkSummary(text: string, max = LOG_CHARS): string[] {
  const pieces = text
    .trim()
    .split(/\n\s*\n/)
    .flatMap(p => (p.length > max ? cut(p, max, '\n') : [p]))
    .flatMap(p => (p.length > max ? cut(p, max, ' ') : [p]))
    .map(p => p.trim())
    .filter(Boolean)
  const chunks: string[] = []
  for (const piece of pieces) {
    const last = chunks.at(-1)
    if (last !== undefined && last.length + 2 + piece.length <= max) chunks[chunks.length - 1] = `${last}\n\n${piece}`
    else chunks.push(piece)
  }

  return chunks
}

// The session's real cache lifetime and last response, read off the transcript's own usage rows.
export function readTranscriptTail(tail: string): { ttlMs?: number; lastAt?: number } {
  const found: { ttlMs?: number; lastAt?: number } = {}
  for (const line of tail.split('\n').reverse()) {
    let row: TranscriptRow
    try {
      row = JSON.parse(line) as TranscriptRow
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || row.isSidechain || !row.message?.usage) continue
    if (found.lastAt === undefined && row.timestamp) {
      const at = Date.parse(row.timestamp)
      if (!Number.isNaN(at)) found.lastAt = at
    }
    const written = row.message.usage.cache_creation
    if (found.ttlMs === undefined && written) {
      if ((written.ephemeral_1h_input_tokens ?? 0) > 0) found.ttlMs = TTL_1H
      else if ((written.ephemeral_5m_input_tokens ?? 0) > 0) found.ttlMs = TTL_5M
    }
    if (found.lastAt !== undefined && found.ttlMs !== undefined) break
  }

  return found
}

type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: {
    usage?: {
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    }
  }
}

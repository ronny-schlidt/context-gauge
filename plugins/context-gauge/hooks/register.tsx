// context-gauge: one thin row above the prompt with the cache countdown, the hit rate,
// the context in tokens with its level dot, and a Compact button.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionMessage, Timer } from 'claude-code'

import type { BarData, CompactRecord, CompactStatus, LastStatus } from '../types'
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
} from './logic'

const EMPTY: BarData = { lastAt: null, ttlMs: TTL_5M, hitRate: null, tokens: null, window: null }
const COLLAPSED_KEY = 'collapsed'
// Lets the engine put its compaction boundary down first, so the lines land under it.
const LOG_DELAY_MS = 500
// How long the Last compact button reads "Shown ✓" and ignores presses.
const SHOWN_MS = 2000

const data = atom({ plugin: 'context-gauge', key: 'data' } as const, EMPTY)
const tick = atom({ plugin: 'context-gauge', key: 'tick' } as const, 0)
const collapsed = atom({ plugin: 'context-gauge', key: 'collapsed' } as const, false)
const compact = atom({ plugin: 'context-gauge', key: 'compact' } as const, null as CompactStatus)
const lastCompact = atom({ plugin: 'context-gauge', key: 'lastCompact' } as const, null as CompactRecord | null)
const lastStatus = atom({ plugin: 'context-gauge', key: 'lastStatus' } as const, null as LastStatus)

let timers: Timer[] = []
let lastSummary: string | undefined

function redraw($: EngineInterface) {
  return update($, tick, n => n + 1)
}

// Redraws each minute from the last response, and at the exact moments the color changes or the time is up.
function startTimers($: EngineInterface, lastAt: number, ttlMs: number, now: number) {
  for (const timer of timers) timer.cancel()
  timers = []
  const until = lastAt + ttlMs - now
  if (until <= 0) return
  const every = $.clock.every(MINUTE, () => void redraw($).catch(() => {}))
  timers.push(every)
  for (const share of [0.75, 0.9]) {
    const wait = lastAt + ttlMs * share - now
    if (wait > 0) timers.push($.clock.after(wait, () => void redraw($).catch(() => {})))
  }
  timers.push(
    $.clock.after(until, () => {
      every.cancel()
      void redraw($).catch(() => {})
    }),
  )
}

async function setContext($: EngineInterface, context: SessionContextUsage) {
  const { tokens, window } = context
  await update($, data, d => ({ ...d, window, tokens: tokens ?? d.tokens }))
}

// The session's context size; a read that fails leaves the last one.
async function readThreshold($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  await setContext($, context)
}

async function readTranscript($: EngineInterface, path: string, takeLastAt: boolean) {
  const { exitCode, stdout } = await $.process.run(['tail', '-n', '200', path])
  if (exitCode !== 0) return
  const found = readTranscriptTail(stdout)
  const after = await update($, data, d => ({
    ...d,
    ttlMs: found.ttlMs ?? d.ttlMs,
    lastAt: takeLastAt && found.lastAt !== undefined ? Math.max(found.lastAt, d.lastAt ?? 0) : d.lastAt,
  }))
  if (after.lastAt !== null) startTimers($, after.lastAt, after.ttlMs, await $.clock.now())
}

// The compacted conversation's new first message, for when the PostCompact hook gave no summary.
function summaryIn(before: readonly SessionMessage[], after: readonly SessionMessage[]) {
  const kept = new Set(before.map(m => m.handle))

  return (after.find(m => m.role === 'user' && !kept.has(m.handle)) ?? after.find(m => m.role === 'user'))?.text
}

function logSummary($: EngineInterface, headline: string, summary: string | undefined) {
  $.ui.log(headline)
  const chunks = chunkSummary(summary ?? '')
  if (chunks.length === 0) $.ui.log('Summary: none found')
  chunks.forEach((chunk, i) => {
    const head = chunks.length > 1 ? `Summary (${i + 1}/${chunks.length})` : 'Summary'
    $.ui.log(`${head}\n\n${chunk}`)
  })
}

async function pressCompact($: EngineInterface, surface: string, isWorking: boolean) {
  if ((await read($, compact)) !== null) return
  const clear = () => update($, compact, () => null)
  const fail = async (error: unknown) => {
    await clear()
    $.ui.toast(`Compact not possible: ${String(error)}`)
  }
  const queue = async () => {
    await update($, compact, () => 'queued')
    await $.command.run({ command: 'compact' }).catch(fail)
  }
  // The direct call works between turns on the terminal only; the queued command runs once Claude is idle.
  if (surface === 'desktop' || isWorking) return queue()
  await update($, compact, () => 'running')
  try {
    const { skip } = await $.session.compact()
    if (skip !== undefined) await fail(skip)
  } catch {
    await queue()
  }
}

// Shows the compaction this mod recorded at once, even while Claude works. Only without
// a record does it ask visible-compact, whose command waits until Claude is idle.
// Either way the button changes its label and takes no second press meanwhile.
async function showLastCompact($: EngineInterface) {
  if ((await read($, lastStatus)) !== null) return
  const record = await read($, lastCompact)
  if (record) {
    await update($, lastStatus, () => 'shown')
    const ago = Math.max(0, Math.round(((await $.clock.now()) - record.at) / MINUTE))
    logSummary($, `${record.headline} · ${ago} min ago`, record.summary ?? undefined)
    $.clock.after(SHOWN_MS, () => void update($, lastStatus, () => null).catch(() => {}))
    return
  }
  await update($, lastStatus, () => 'loading')
  try {
    const { text } = await $.command.run({ command: 'show-last-compact' })
    if (text) $.ui.toast(text)
  } catch {
    $.ui.toast('No compact in this session yet')
  } finally {
    await update($, lastStatus, () => null)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const stored = await $.store.get(COLLAPSED_KEY)
    if (stored === true) await update($, collapsed, () => true)
    const ttl = await $.settings.read({ key: 'promptCacheTtl' }).catch(() => undefined)
    const known = await read($, data)
    if (known.lastAt === null && ttl === '1h') await update($, data, d => ({ ...d, ttlMs: TTL_1H }))
    if (known.lastAt !== null) startTimers($, known.lastAt, known.ttlMs, await $.clock.now())
    void readThreshold($).catch(() => {})

    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A compaction or /clear starts anew; only a resumed conversation brings its last response along.
    if (e.source === 'resume' || e.source === 'fork') void readTranscript($, e.transcript_path, true).catch(() => {})

    return r
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage) {
      const lastAt = await $.clock.now()
      const hit = hitRate(r.usage)
      const after = await update($, data, d => ({ ...d, lastAt, hitRate: hit }))
      startTimers($, lastAt, after.ttlMs, lastAt)
    }

    return r
  })

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    void readTranscript($, e.transcript_path, true).catch(() => {})

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) void readThreshold($).catch(() => {})

    return r
  })

  on('session.measure', async ($, e, next) => {
    await setContext($, e.context)

    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    lastSummary = e.compact_summary

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    lastSummary = undefined
    try {
      const r = await next(e)
      if (r.skip !== undefined) return r
      for (const timer of timers) timer.cancel()
      timers = []
      await update($, data, d => ({ ...d, lastAt: null, hitRate: null, tokens: r.tokensAfter ?? null }))
      const headline = compactHeadline(r.tokensBefore, r.tokensAfter)
      const fallback = summaryIn(e.messages, r.messages)
      const at = await $.clock.now()
      // The PostCompact hook's summary may land after this; the record takes it once the log runs.
      $.clock.after(LOG_DELAY_MS, () => {
        const summary = lastSummary || fallback
        void update($, lastCompact, () => ({ at, headline, summary: summary ?? null })).catch(() => {})
        if (e.trigger === 'manual' || e.trigger === 'plugin') logSummary($, headline, summary)
      })

      return r
    } finally {
      await update($, compact, () => null)
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      for (const timer of timers) timer.cancel()
      timers = []
      await update($, data, () => EMPTY)
      await update($, lastCompact, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest

    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const d = await read($, data)
    const isCollapsed = await read($, collapsed)
    const status = await read($, compact)
    const last = await read($, lastStatus)
    const now = await $.clock.now()

    const window = d.window ?? 0
    const dot = level(d.tokens)
    const fill = d.tokens !== null && window ? `${shortTokens(d.tokens)} / ${shortTokens(window)}` : '–'
    const cache = d.lastAt === null ? null : cacheView(d.lastAt, d.ttlMs, now)
    const left = cache === null ? '–' : cache.isExpired ? 'expired' : `${cache.minutes} min`
    // Without the bar, the minutes themselves carry the cache state: green, then orange, then red.
    const leftColor = cache === null ? undefined : cache.color === 'yellow' ? '#f97316' : cache.color
    // The desktop draws in a proportional body font, too wide for one row beside the button.
    const small = e.surface === 'desktop' ? { size: 'footnote' as const } : {}

    const flip = () => {
      const after = !isCollapsed
      void update($, collapsed, () => after)
      void $.store.set(COLLAPSED_KEY, after)
    }
    const minutes = <Text {...(leftColor ? { color: leftColor } : {})}>{left}</Text>
    const gap = '\u00a0\u00a0\u00a0'

    // Only a Button takes a click, so the figures themselves are one plain Button that
    // folds the band; a Button holds strings and Text alone, so no-break spaces (which the desktop keeps) stand for the gaps.
    const figures = isCollapsed ? (
      <Button key="band" plain onPress={flip}>
        <Text>{dot}</Text>
        {gap}
        {minutes}
        {gap}
        <Text>{fill}</Text>
      </Button>
    ) : (
      <Button key="band" plain onPress={flip}>
        <Text {...small} dimColor>{'Cache '}</Text>
        <Text {...small}>{minutes}</Text>
        {gap}
        <Text {...small} dimColor>{'Hit '}</Text>
        <Text {...small}>{d.hitRate === null ? '–' : `${d.hitRate}%`}</Text>
        {gap}
        <Text {...small}>{dot}</Text>
        {gap}
        <Text {...small} dimColor>{'Context '}</Text>
        <Text {...small}>{fill}</Text>
      </Button>
    )

    const bar = isCollapsed ? (
      <Box paddingX={1} columnGap={2} alignItems="center">
        {figures}
      </Box>
    ) : (
      <Box paddingX={1} columnGap={2} alignItems="center" justifyContent="space-between">
        {/* The figures take the row's room; the controls keep their place at its end. */}
        <Box flexGrow={1} flexShrink={1} minWidth={0} alignItems="center">
          {figures}
        </Box>
        <Box flexShrink={0} columnGap={1} alignItems="center">
          <Button
            key="compact"
            label={status === 'queued' ? 'Compact queued' : status === 'running' ? 'Compacting…' : 'Compact'}
            {...(dot === '🔴' ? { variant: 'primary' as const } : {})}
            onPress={press => void pressCompact($, press.surface, e.props.isWorking).catch(() => {})}
          />
          <Button
            key="last-compact"
            label={last === 'shown' ? 'Shown ✓' : last === 'loading' ? 'Loading…' : 'Last compact'}
            onPress={() => void showLastCompact($).catch(() => {})}
          />
        </Box>
      </Box>
    )

    return rest ? (
      <Box flexDirection="column">
        {rest}
        {bar}
      </Box>
    ) : (
      bar
    )
  })
}

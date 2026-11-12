// context-gauge: one thin row above the prompt with the cache countdown,
// the context in tokens with its level dot, the 5-hour limit, and a Compact button.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, MatchedHook, Register, SessionContextUsage, SessionMessage, SessionRateLimit, StreamHook, Timer } from 'claude-code'

import {
  ctClassicSessionStart,
  ctCommandRunCacheTax,
  ctCommandRunKeepwarm,
  ctConfigSetTheme,
  ctPromptSubmit,
  ctSessionCompact,
  ctSessionEnd,
  ctSessionStart,
  ctSetup,
  ctTurnComplete,
  ctTurnStep,
  ctUiRenderAbovePrompt,
} from './cache-tax/register'
import {
  vcCommandRunShowLastCompact,
  vcSessionCompact,
  vcSessionEnd,
  vcSessionStart,
  vcSetup,
  vcUiRenderPaneVisibleCompact,
} from './visible-compact/register'
import type { BarData, CompactRecord, CompactStatus, LastStatus, LimitData } from '../types'
import {
  MINUTE,
  TTL_1H,
  TTL_5M,
  cacheView,
  chunkSummary,
  compactHeadline,
  fiveHour,
  hitRate,
  limitView,
  readTranscriptTail,
  shortTokens,
  level,
  stateDot,
} from './logic'

const EMPTY: BarData = { lastAt: null, ttlMs: TTL_5M, hitRate: null, tokens: null, window: null }
const COLLAPSED_KEY = 'collapsed'
// The cache lifetime last seen in a transcript, so a new session starts with it instead of 5 minutes.
const TTL_KEY = 'ttlMs'
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
const limit = atom({ plugin: 'context-gauge', key: 'limit' } as const, null as LimitData | null)

let timers: Timer[] = []
let limitTimers: Timer[] = []
let transcriptPath: string | undefined
// Whether this session's transcript has shown the cache lifetime yet.
let ttlSeen = false
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

// A response without a 5-hour reading leaves the last one standing.
async function setLimit($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  const found = fiveHour(rateLimits)
  if (!found) return
  const before = await read($, limit)
  await update($, limit, () => found)
  if (before?.resetsAt !== found.resetsAt) startLimitTimer($, found, await $.clock.now())
}

// The 5-hour countdown moves each minute until the window resets.
function startLimitTimer($: EngineInterface, window: LimitData, now: number) {
  for (const timer of limitTimers) timer.cancel()
  limitTimers = []
  if (window.resetsAt === null || window.resetsAt <= now) return
  const every = $.clock.every(MINUTE, () => void redraw($).catch(() => {}))
  limitTimers.push(
    every,
    $.clock.after(window.resetsAt - now, () => {
      every.cancel()
      void redraw($).catch(() => {})
    }),
  )
}

// The session's context size and rate limits; a read that fails leaves the last ones.
async function readThreshold($: EngineInterface) {
  const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  await setContext($, context)
  await setLimit($, rateLimits)
}

async function readTranscript($: EngineInterface, path: string, takeLastAt: boolean) {
  const { exitCode, stdout } = await $.process.run(['tail', '-n', '200', path])
  if (exitCode !== 0) return
  const found = readTranscriptTail(stdout)
  if (found.ttlMs !== undefined) {
    ttlSeen = true
    void $.store.set(TTL_KEY, found.ttlMs).catch(() => {})
  }
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

export const gaugeSessionStart: Hook<'session.start'> = async ($, e, next) => {
    const r = await next(e)
    const stored = await $.store.get(COLLAPSED_KEY)
    if (stored === true) await update($, collapsed, () => true)
    const ttl = await $.settings.read({ key: 'promptCacheTtl' }).catch(() => undefined)
    const learned = await $.store.get(TTL_KEY).catch(() => undefined)
    const known = await read($, data)
    const start = ttl === '1h' ? TTL_1H : learned === TTL_1H || learned === TTL_5M ? learned : undefined
    if (known.lastAt === null && start !== undefined) await update($, data, d => ({ ...d, ttlMs: start }))
    if (known.lastAt !== null) startTimers($, known.lastAt, known.ttlMs, await $.clock.now())
    const knownLimit = await read($, limit)
    if (knownLimit) startLimitTimer($, knownLimit, await $.clock.now())
    void readThreshold($).catch(() => {})

    return r
}


export const gaugeClassicSessionStart: Hook<'classic.SessionStart'> = async ($, e, next) => {
    const r = await next(e)
    transcriptPath = e.transcript_path
    // A compaction or /clear starts anew; only a resumed conversation brings its last response along.
    if (e.source === 'resume' || e.source === 'fork') void readTranscript($, e.transcript_path, true).catch(() => {})

    return r
}


export const gaugeTurnStep: StreamHook<'turn.step'> = async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage) {
      const lastAt = await $.clock.now()
      const hit = hitRate(r.usage)
      const after = await update($, data, d => ({ ...d, lastAt, hitRate: hit }))
      startTimers($, lastAt, after.ttlMs, lastAt)
      // The response's usage has no 1h/5m split; the transcript has, so read it once instead of waiting for the turn's end.
      if (!ttlSeen && transcriptPath) void readTranscript($, transcriptPath, false).catch(() => {})
    }

    return r
}


export const gaugeClassicStop: Hook<'classic.Stop'> = async ($, e, next) => {
    const r = await next(e)
    transcriptPath = e.transcript_path
    void readTranscript($, e.transcript_path, true).catch(() => {})

    return r
}


export const gaugeTurnComplete: Hook<'turn.complete'> = async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) void readThreshold($).catch(() => {})

    return r
}


export const gaugeSessionMeasure: Hook<'session.measure'> = async ($, e, next) => {
    await setContext($, e.context)
    await setLimit($, e.rateLimits)

    return next(e)
}


export const gaugeClassicPostCompact: Hook<'classic.PostCompact'> = async ($, e, next) => {
    lastSummary = e.compact_summary

    return next(e)
}


export const gaugeSessionCompact: Hook<'session.compact'> = async ($, e, next) => {
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
}


export const gaugeSessionEnd: Hook<'session.end'> = async ($, e, next) => {
    if (e.reason === 'clear') {
      for (const timer of timers) timer.cancel()
      timers = []
      await update($, data, () => EMPTY)
      await update($, lastCompact, () => null)
    }

    return next(e)
}


export const gaugeUiRenderAbovePrompt: MatchedHook<'ui.render', { component: 'AbovePrompt' }> = async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest

    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const d = await read($, data)
    const isCollapsed = await read($, collapsed)
    const status = await read($, compact)
    const last = await read($, lastStatus)
    const fiveH = await read($, limit)
    const now = await $.clock.now()

    const window = d.window ?? 0
    const dot = level(d.tokens)
    const fill = d.tokens !== null && window ? `${shortTokens(d.tokens)} / ${shortTokens(window)}` : '–'
    const cache = d.lastAt === null ? null : cacheView(d.lastAt, d.ttlMs, now)
    const left = cache === null ? '–' : cache.isExpired ? 'expired' : `${cache.minutes} min`
    // The desktop draws a Button's text in one color, so each figure carries its state as a colored dot.
    const cacheDot = cache === null ? '⚪' : stateDot(cache.isExpired ? 'red' : cache.color)
    // The desktop draws in a proportional body font, too wide for one row beside the button.
    const small = e.surface === 'desktop' ? { size: 'footnote' as const } : {}
    // Hidden off a subscription, where the API reports no 5-hour window.
    const lv = fiveH ? limitView(fiveH, now) : null

    const flip = () => {
      const after = !isCollapsed
      void update($, collapsed, () => after)
      void $.store.set(COLLAPSED_KEY, after)
    }
    // A Button holds strings and Text alone; no-break spaces (which the desktop keeps) set the gaps.
    const nb = '\u00a0'
    const sep = <Text {...small} dimColor>{`${nb}${nb}${nb}│${nb}${nb}${nb}`}</Text>
    const label = (text: string) => <Text {...small} dimColor>{`${text}${nb}`}</Text>
    const value = (text: string) => <Text {...small} bold>{text}</Text>
    const lead = (mark: string) => <Text {...small}>{`${mark}${nb}`}</Text>

    // Only a Button takes a click, so the figures themselves are one plain Button that folds the band.
    const figures = isCollapsed ? (
      <Button key="band" plain onPress={flip}>
        {lead(cacheDot)}
        {value(left)}
        {sep}
        {lead(dot)}
        {value(fill)}
        {lv ? sep : null}
        {lv ? lead(stateDot(lv.color)) : null}
        {lv ? label('5h:') : null}
        {lv ? value(lv.percent) : null}
      </Button>
    ) : (
      <Button key="band" plain onPress={flip}>
        {lead(cacheDot)}
        {label('Cache:')}
        {value(left)}
        {sep}
        {lead(dot)}
        {label('Context:')}
        {value(fill)}
        {lv ? sep : null}
        {lv ? lead(stateDot(lv.color)) : null}
        {lv ? label('5h:') : null}
        {lv ? value(lv.percent) : null}
        {lv?.reset ? <Text {...small} dimColor>{`${nb}${nb}↻${nb}${lv.reset}`}</Text> : null}
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
}

// One plugin hooks each event once, so where context-gauge and the built-in cache-tax
// (keeps the 1-hour cache warm, guards cold sends) and visible-compact (each compaction's
// before/after pane) all hook an event, one hook runs theirs in a row. Both are MIT, see licenses/.
//
// guard keeps one part's failure from taking the others down: a hook that throws before it
// called next passes the event on untouched; one that throws after keeps next's answer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pass = (e: any) => Promise<any>

async function guard(hook: (next: Pass) => unknown, e: unknown, next: Pass) {
  // Set inside the callback, so typed wide: the compiler cannot follow it there.
  let stage = 'before' as 'before' | 'inside' | 'after'
  let answer: unknown
  try {
    return await hook(async input => {
      stage = 'inside'
      answer = await next(input)
      stage = 'after'

      return answer
    })
  } catch (error) {
    if (stage === 'after') return answer
    // What threw lies beneath this part: not its to swallow.
    if (stage === 'inside') throw error
    return next(e)
  }
}

export const register: Register = (on, options) => {
  ctSetup()
  vcSetup(options)

  on('session.start', ($, e, next) =>
    guard(n => ctSessionStart($, e, n as never), e, a => guard(n => vcSessionStart($, a, n as never), a, b => guard(n => gaugeSessionStart($, b, n as never), b, next))) as never,
  )
  on('session.end', ($, e, next) =>
    guard(n => ctSessionEnd($, e, n as never), e, a => guard(n => vcSessionEnd($, a, n as never), a, b => guard(n => gaugeSessionEnd($, b, n as never), b, next))) as never,
  )
  on('session.compact', ($, e, next) =>
    guard(n => ctSessionCompact($, e, n as never), e, a => guard(n => vcSessionCompact($, a, n as never), a, b => guard(n => gaugeSessionCompact($, b, n as never), b, next))) as never,
  )
  on('session.measure', gaugeSessionMeasure)
  on('classic.SessionStart', ($, e, next) =>
    guard(n => ctClassicSessionStart($, e, n as never), e, a => guard(n => gaugeClassicSessionStart($, a, n as never), a, next)) as never,
  )
  on('classic.Stop', gaugeClassicStop)
  on('classic.PostCompact', gaugeClassicPostCompact)
  on('turn.step', async function* ($, e, next) {
    return yield* ctTurnStep($, e, ((a: typeof e) => gaugeTurnStep($, a, next)) as never)
  })
  on('turn.complete', ($, e, next) => guard(n => ctTurnComplete($, e, n as never), e, a => guard(n => gaugeTurnComplete($, a, n as never), a, next)) as never)
  on('prompt.submit', ctPromptSubmit)
  on('config.set', { key: 'theme' }, ctConfigSetTheme)
  on('command.run', { command: 'keepwarm' }, ctCommandRunKeepwarm)
  on('command.run', { command: 'cache-tax' }, ctCommandRunCacheTax)
  on('command.run', { command: 'show-last-compact' }, vcCommandRunShowLastCompact)
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) =>
    guard(n => ctUiRenderAbovePrompt($, e, n as never), e, a => guard(n => gaugeUiRenderAbovePrompt($, a, n as never), a, next)) as never,
  )
  on('ui.render', { component: 'Pane', requestId: 'visible-compact' }, vcUiRenderPaneVisibleCompact)
}

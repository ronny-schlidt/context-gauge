export type BarData = {
  lastAt: number | null
  ttlMs: number
  hitRate: number | null
  tokens: number | null
  window: number | null
}

// The 5-hour rate-limit window: percent used and when it resets, in clock milliseconds.
export type LimitData = { percent: number; resetsAt: number | null }

export type CompactStatus = 'queued' | 'running' | null

// The session's last compaction, as this mod saw it.
export type CompactRecord = { at: number; headline: string; summary: string | null }

// The Last compact button: idle, just shown, or waiting on visible-compact's command.
export type LastStatus = 'shown' | 'loading' | null

// visible-compact (merged in): the before/after pane.
/** Which columns the pane shows. */
/** The palette the pane draws in; plugins aren't told the app's theme. */
export type Theme = 'light' | 'dark'

export type ViewMode = 'after' | 'both' | 'before'

export type Side = 'before' | 'after'

/** One piece of a message, at most CHUNK_CHARS long, cut at a paragraph break where possible. */
export type Chunk = {
  /** Index of the message in its side's transcript. */
  m: number
  role: 'user' | 'assistant'
  /** This chunk's position within the message, and how many the message has. */
  i: number
  n: number
  text: string
}

export type ModelUsageSummary = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the index keeps for each compaction; the chunks themselves live in files beside it. */
export type CompactMeta = {
  id: string
  at: number
  durationMs: number
  trigger: 'manual' | 'auto' | 'plugin'
  /** Absent for the main conversation. */
  agentId?: string
  agentLabel?: string
  instructions?: string
  tokensBefore?: number
  tokensAfter?: number
  usage?: ModelUsageSummary
  messages: Record<Side, number>
  chunks: Record<Side, number>
}

export type BandView = 'full' | 'lean' | 'short'

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      data: BarData
      tick: number
      /** The band's look, switched by a click on the figures: everything, without Last compact, or short. */
      view: BandView
      compact: CompactStatus
      lastCompact: CompactRecord | null
      lastStatus: LastStatus
      limit: LimitData | null
      /** visible-compact: the saved compactions, the one shown (null follows the newest), its view, pages and palette. */
      vcIndex: CompactMeta[]
      vcSelected: string | null
      vcView: ViewMode
      vcPages: Record<Side, number>
      vcTheme: Theme
    }
  }
}

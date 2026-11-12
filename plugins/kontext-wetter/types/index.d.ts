export type BarData = {
  lastAt: number | null
  ttlMs: number
  hitRate: number | null
  tokens: number | null
  window: number | null
}

export type CompactStatus = 'queued' | 'running' | null

// The session's last compaction, as this mod saw it.
export type CompactRecord = { at: number; headline: string; summary: string | null }

// The Last compact button: idle, just shown, or waiting on visible-compact's command.
export type LastStatus = 'shown' | 'loading' | null

declare module 'claude-code' {
  interface PluginState {
    'kontext-wetter': {
      data: BarData
      tick: number
      collapsed: boolean
      compact: CompactStatus
      lastCompact: CompactRecord | null
      lastStatus: LastStatus
    }
  }
}

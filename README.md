# context-gauge

A Claude Code mod: one slim band above the prompt that shows

- **Cache**: minutes until the prompt cache expires (green, then orange, then red)
- **Hit**: the share of the last request's input that came from the cache
- **🟢 🟡 🟠 🔴**: how full the context is (up to 100k, 150k, 200k tokens, beyond)
- **Context**: tokens used out of the context window, e.g. `137k / 1M`
- **Compact**: compacts the conversation (highlighted once the dot turns red)
- **Last compact**: shows the last compaction's token counts and summary in the transcript

Click the figures to fold the band down to the dot, the minutes and the context.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-gauge --marketplace ronny-schlidt/context-gauge
```

From a shell:

```sh
claude plugin install context-gauge --marketplace ronny-schlidt/context-gauge
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ronny-schlidt/context-gauge`, then Add plugin.

The band shows in sessions started after the install.

## Update

```sh
claude plugin marketplace update context-gauge
claude plugin update context-gauge@context-gauge
```

## Optional

The Last compact button reads the mod's own record of compactions made while it was loaded. For older ones it falls back to the `/show-last-compact` command of the visible-compact mod when that is installed.

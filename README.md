# context-gauge

A Claude Code mod for the prompt cache and the context window, all in one plugin.

## The band above the prompt

```
🟢 Cache: 58 min   │   🟡 Context: 135k / 1M   │   🟢 5h: 26%  ↻ 3h 33m      [Compact] [Last compact]
```

Each figure has its own dot:

- **Cache**: minutes until the prompt cache expires. 🟢, 🟠 in the last quarter, 🔴 in the last tenth and once expired, ⚪ before the first response. The 1-hour or 5-minute lifetime is read from the transcript and remembered across sessions.
- **Context**: tokens used out of the context window. 🟢 up to 100k, 🟡 up to 150k, 🟠 up to 200k, 🔴 beyond.
- **5h**: share of the 5-hour usage limit used, and the time until it resets. 🟢, 🟠 from 60%, 🔴 from 85%. Hidden without a subscription.
- **Compact**: compacts the conversation (highlighted once the context dot turns red).
- **Last compact**: shows the last compaction's token counts and summary in the transcript.

Click the figures to switch between three looks: everything, the same without the Last compact button, and short (only the dots and numbers).

## Built in

Two MIT-licensed mods are bundled, so one install brings everything (their licenses are in `plugins/context-gauge/licenses/`):

- **[cache-tax](https://github.com/karanb192/claude-code-mods)** by Karan Bansal keeps the 1-hour cache warm during breaks and stops a cold send once with its estimated rewrite cost.
  - `/keepwarm` (6 hours), `/keepwarm 90m`, `/keepwarm always`, `/keepwarm status`, `/keepwarm off`
  - `/cache-tax` shows the card; `/cache-tax guard warn` only shows the price instead of stopping the send
  - Warming pings cost tokens.
- **[visible-compact](https://github.com/nvsravank/visible-compact)** by Sravan saves each compaction and shows the conversation before and after it side by side; `/show-last-compact` opens the pane. The plugin setting `storage` (`temp` or `home`) says where the compactions are kept.

If you installed cache-tax or visible-compact on their own before, uninstall them, or their hooks and commands run twice.

## Install

From a shell:

```sh
claude plugin marketplace add https://github.com/ronny-schlidt/context-gauge.git
claude plugin install context-gauge@context-gauge
```

At the prompt of a Claude Code terminal session:

```
/plugin install context-gauge --marketplace ronny-schlidt/context-gauge
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ronny-schlidt/context-gauge`, then Add plugin.

Everything shows in sessions started after the install.

## Update

```sh
claude plugin marketplace update context-gauge
claude plugin update context-gauge@context-gauge
```

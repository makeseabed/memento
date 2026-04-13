# Memento

> Observational memory for OpenClaw.

Most agent memory systems get the abstraction wrong — they either replay full transcripts (too noisy) or constantly reinject changing summaries (churn cache, fragment attention). Memento takes a different path.

It watches sessions as they happen, extracts genuinely notable observations — decisions, constraints, preferences — and maintains a compact, prioritized log that persists across sessions. Memory is split into two scopes: **shared** (follows the agent everywhere) and **session** (scoped to the current conversation). As observations accumulate, Memento periodically consolidates them, dropping stale context and preserving what matters. At the right boundaries, it feeds just enough back into context to maintain continuity without dragging history through every turn.

No vectors, no databases. Just a Markdown file that LLMs already understand.

## Install

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @makeseabed/memento
```

If you're running from a local OpenClaw checkout:

```bash
pnpm openclaw plugins install @makeseabed/memento
```

In most setups, that is enough to register and enable the plugin.

## Configuration

All config is optional. If omitted, Memento uses built-in defaults.

```json
{
  "model": "openai/gpt-5-mini",
  "observer": {
    "maxSessions": 10,
    "maxLinesPerTranscript": 300,
    "existingObservationsContext": 40
  },
  "watcher": {
    "turnThreshold": 10
  },
  "reflector": {
    "triggerWordThreshold": 8000,
    "backupRetentionCount": 10
  },
  "memoryFlush": {
    "flushLookbackHours": 2,
    "recoverLookbackHours": 4,
    "skipDedup": true
  },
  "logging": false
}
```

### Config surface

- `model`: shared model for observer and reflector unless overridden below
- `observer.maxSessions`: recent sessions to scan
- `observer.maxLinesPerTranscript`: transcript lines to read per session
- `observer.existingObservationsContext`: recent memory bullets used for dedup context
- `observer.model`: observer-specific model override
- `watcher.turnThreshold`: run observation after this many meaningful assistant replies written to the session transcript
- `reflector.triggerWordThreshold`: consolidate when memory gets too long
- `reflector.backupRetentionCount`: reflector backups to keep
- `reflector.model`: reflector-specific model override
- `memoryFlush.flushLookbackHours`: lookback window for pre-compaction capture
- `memoryFlush.recoverLookbackHours`: lookback window for reset recovery
- `memoryFlush.skipDedup`: skip dedup during flush and recovery flows
- `logging`: write `memento/memento.log` when true, off by default

### Environment overrides

Environment variable overrides are still supported in the current codepath and take precedence over config. The primary env key is now `MEMENTO_LOGGING`, with legacy `MEMENTO_LOG_FILE_ENABLED` still accepted for compatibility.

Examples:

- `MEMENTO_MODEL`
- `MEMENTO_OBSERVER_MODEL`
- `MEMENTO_REFLECTOR_MODEL`
- `MEMENTO_WATCHER_TURN_THRESHOLD`
- `MEMENTO_REFLECTOR_TRIGGER_WORD_THRESHOLD`
- `MEMENTO_LOGGING`

The source also supports overrides for the other numeric and boolean settings in `src/config.ts`.

## Files

Memento organizes memory under each agent's workspace:

**Shared memory** lands in `memento/shared/` — durable observations that follow the agent everywhere.

**Session memory** lands in `memento/sessions/<stableChatKey>/` — local observations scoped to a specific conversation. The chat key is derived from OpenClaw's real session key as a stable dashed name, for example `agent-main-discord-channel-1480872431068516454`.

Each store contains `observations.md`, a `backups/` directory, and a `last-observed-at` timestamp. Agent-level runtime files live at `memento/memento.log` and `memento/.observer-state.json`.

## Contributing

Memento is open source and contributions are welcome.

- Open an issue before starting significant work so we can align on direction.
- Keep PRs focused — one fix or feature per PR.
- Tests are required. Run `pnpm test` before submitting.
For bugs, include the relevant section of `memento/memento.log` and your OpenClaw version.

## Inspiration

Memento stands on the shoulders of some excellent work in the agent memory space.

Mastra AI's observational memory planted the conceptual seed, demonstrating that agents need more than context windows; they need a way to observe, distill, and remember what matters.

[Gavdalf's article](https://gavlahh.substack.com/p/your-ai-has-an-attention-problem) clarified why the observation layer matters and helped shape the framing behind Memento.

[Gavdalf's total-recall](https://github.com/gavdalf/total-recall) then provided practical scaffolding. Its prompt engineering and code patterns directly influenced Memento's implementation.

This project is our own take on the problem, but the conceptual and practical debt is real, and we're grateful for it.

## License

MIT

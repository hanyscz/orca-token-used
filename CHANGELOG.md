# Changelog

All notable changes to Token Pulse are documented in this file.

## [0.1.3] - 2026-11-17

### Added
- **Quotas tab with 240° circular arc gauges**: Added a 6th navigation tab (`Quotas`) displaying 5-hour and weekly (7-day) rate-limit gauges across Codex, Antigravity (split by Gemini Models and Claude/GPT model pools, with multi-account support), and Claude.
- **Dynamic window & local fallback rendering**: Accounts without a 5-hour window (such as Codex weekly-only plans) render the weekly gauge alongside an explicit `5h Window · N/A` and reset-credits tile; providers without subscription quota data fall back to local rolling 5h/7d token and USD usage.
- **Non-blocking `QuotaEngine`**: Queries `orca account list --json` asynchronously with a 15s timeout, in-flight deduplication, 5-minute TTL cache, and abort-on-deactivate lifecycle handling.
- **Refreshed directory screenshots**: Updated `assets/token-pulse-cover.png` and `assets/token-pulse-live.png` to reflect the updated UI.

### Fixed
- **Active transcript state precedence**: Prevented stale journal `settled` states from overriding newer active `working` transcript writes in `resolveSessionRunState`.
- **Quota edge cases**: Normalized 10-digit epoch seconds for reset timestamps, fixed future reset-credit expiry countdown formatting, guarded `#btn-refresh` when `window.orca` is unavailable, and checked worker shutdown state before persisting quota cache.
- **Publish script**: Added `CHANGELOG.md` to release staging, verified `orca plugin release-entry . --json` `contentHash` output, and updated the printed `orca.dev` directory URL.

## [0.1.2] - 2026-11-17

### Added
- **Nested subagents & status elevation**: Nested subagent cards under parent sessions and elevated parent status to `waiting` while child subagents are active.
- **Terminal tab & handoff title sync**: Bound runtime terminal handles via `tabId`, synchronized terminal tab/handoff titles across CLI sessions, and added click-to-focus terminal navigation.
- **Live dashboard telemetry**: Added provider logos, reasoning effort badges, collapsible status groups, and today's cumulative cost.
- **Documentation**: Documented local read-only data paths and updated `README.md` features.

## [0.1.1] - 2026-11-12

### Added
- Added compact sidebar screenshots (`assets/user-*.png`) and view table in `README.md`.

## [0.1.0] - 2026-11-12

### Added
- Initial release of Token Pulse for Orca: real-time output/input TPS, 60-second waveforms, session/today/week/month summaries, multi-agent transcript parsing (Claude Code, Codex, Gemini CLI, Antigravity), live online pricing from OpenRouter and models.dev, and light/dark Orca theme support.

# Token Pulse

Token Pulse is an Orca sidebar plugin for tracking token usage, generation speed, model pricing, and live input/output telemetry across Claude Code, Codex, Gemini CLI, and Antigravity.

## Install

From Orca's plugin directory, search for **Token Pulse**. You can also install the repository directly:

```bash
orca plugin install wilsonliu123/orca-token-used
```

The plugin uses Orca's `trusted-worker` profile. Orca will show the requested access and ask you to approve it before the worker runs.

## Features

- Live output and input token rates with 60-second waveforms.
- Session, day, week, and month token summaries, plus today's cumulative cost in the live dashboard.
- Claude Code, Codex, Gemini CLI, and Antigravity transcript parsing with provider logos and reasoning effort badges.
- Nested subagent cards under parent sessions with parent status elevation while child subagents are active, plus collapsible session groups.
- Terminal tab and handoff title synchronization across CLI sessions, with click-to-focus terminal navigation.
- Current model labels and provider-aware USD estimates.
- 5-hour and weekly (7-day) quota gauges across Codex, Antigravity (Gemini and Claude/GPT model pools), and Claude, paired with local rolling 5h/7d token and USD usage.
- Online pricing refresh from OpenRouter and models.dev, with offline built-in rates.
- Light and dark Orca themes.

## Views

These compact sidebar captures show the full navigation set and the status-bar summary:

| View | Screenshot |
| --- | --- |
| Live overview | ![Live overview](assets/user-live-overview.png) |
| Sessions | ![Sessions](assets/user-sessions.png) |
| Today | ![Today](assets/user-today.png) |
| Week | ![Week](assets/user-week.png) |
| Month | ![Month](assets/user-month.png) |
| Status bar | ![Status bar](assets/user-status-bar.png) |

The larger listing screenshots in the manifest are captured directly from Orca at the directory's minimum image size. These compact captures document the narrow sidebar layouts users see in normal use.

## Data access and privacy

The worker reads local files in read-only mode to calculate usage and match sessions to Orca workspaces. Depending on which agents are installed, the paths include:

- Claude Code: `~/.claude/projects/**/*.jsonl` and `~/.claude/settings.json`.
- Codex: `~/.codex/sessions/**/*.jsonl` and `~/.codex/config.toml`.
- Gemini CLI: `~/.gemini/tmp/**/chats/session-*.json` and `~/.gemini/settings.json`.
- Antigravity: `~/.gemini/antigravity*/brain/**`, `<Orca data>/antigravity-chat/**`, and `<Orca data>/antigravity-accounts/*/**`.
- Orca: `<Orca data>/agent-session-journal.db`, `<Orca data>/profiles/<active-profile>/profile-state.db`, and the runtime session directories under `<Orca data>/codex-runtime-home/` and `<Orca data>/codex-accounts/`.

Token Pulse uses Orca's current official workspace and agent APIs for focus, status, terminal identity, and terminal focus, and invokes `orca account list --json` asynchronously (cached for 5 minutes) to read local rate-limit quota windows and pool usage across Codex, Antigravity, and Claude. Detailed per-turn usage and subagent history still come from the local agent transcripts because the current host does not expose an official session-history API.

The settings files are parsed only for model and account-home metadata. Token Pulse uses local paths and `orca account list --json` output internally to display quotas and match sessions, and does not modify accounts or transmit credentials, emails, prompts, responses, transcript contents, or local paths.

The only outbound requests are public pricing reads from:

- `https://openrouter.ai/api/v1/models`
- `https://models.dev/api.json`

Transcript contents, prompts, responses, and local paths are not sent to those endpoints. Token Pulse has no analytics, telemetry, advertising, or account sign-in flow.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| Live pricing sync interval | 6 hours | How often online model rates are refreshed. |
| Live transcript refresh interval | 2 seconds | How often active transcripts are tailed. |
|                                  |           |                                             |

## Development

```bash
orca plugin dev watch .
orca plugin validate .
orca plugin test .
```

The plugin requires Orca `>=1.4.248`.

## Releases

Release a new version with:

```bash
scripts/publish-plugin.sh 0.1.2
```

The script updates the manifest version, validates and tests the plugin, commits the release, pushes `main`, creates the matching `v0.1.2` tag, and prints the Orca directory URL.

## License

MIT

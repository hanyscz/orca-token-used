# Plan: Terminal Tab & Handoff Title Synchronization Fix

**Generated**: November 13, 2026 (Revised after subagent architectural & edge-case review)

## Overview

Fix Live Monitor and Sessions title desynchronization, `local` workspace misattribution, and duplicate `0 tok` phantom cards when running CLI agents inside Orca Terminal tabs or handing off sessions from Orca Chat UI to a Terminal-launched agent.

Investigation against live Orca SQLite state (`profile-state.db`, `agent-session-journal.db`, and `~/.gemini/antigravity-cli/conversation_summaries.db`) identified three linked root causes:

1. **Missing `cwd` on Antigravity CLI transcripts (`src/parsers.ts`, `src/scanner.ts`, `src/journal.ts`)**: Antigravity CLI `transcript.jsonl` files place `Command Working Directory:` in the system prompt rather than `USER_INPUT.content`; authoritative workspace paths (`workspace_uris`), summary titles, and subagent hierarchy (`parent_conversation_id`, `nesting_depth`, `conversation_parents`) live in `conversation_summaries.db` and `history.jsonl`. Because `state.cwd` remained `null`, Antigravity CLI sessions fell back to `local`, failed `isSameOrChildWorktreePath` against `tabsByWorktree` (ignoring user-renamed tabs such as `#54` and `# debug`), and failed `canBindPtyToCliSession` (splitting one active terminal agent into an unbound `Terminal 1` `0 tok` card plus a separate `local` transcript card).
2. **Incomplete Terminal tab title extraction (`src/journal.ts`)**: `readOrcaJournalIndex` only read manual `customTitle` / `customLabel` fields, ignoring `generatedTitle` / `generatedLabel` (written by Orca for Terminal auto-naming and Chat UI → Terminal handoffs) and non-generic tab labels, while also needing to filter boilerplate handoff headers (e.g. `"Continue work from the prior Orca"` when Orca slices line 1 of a handoff prompt into `generatedTitle`).
3. **Terminal identifier, sequential/multi-tab matching & settle-timing gaps (`src/journal.ts`, `src/aggregator.ts`, `src/worker.ts`)**: `ptyCustomTitles` indexed only `ptyId` (omitting `tabId` and `pty:<ptyId>`), same-worktree terminal matching could cross-steal on `lastFocusedAt`, `agent.livePoll` polled transcripts before refreshing the journal, and `workspace.changed` tab-rename events could coalesce away while `profile-state.db` was still flushing.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Confirmed title resolution order for Terminal-backed sessions:
> 1. `customTitle` / `customLabel` (explicit user rename in Orca UI, preserving `#` prefixes such as `#54`, `# debug`, `# 优化 skills`)
> 2. `generatedTitle` / `generatedLabel` (Orca auto-generated or Chat UI → Terminal handoff tab title, excluding boilerplate handoff prompt prefixes like `"Continue work from the prior Orca"`)
> 3. Non-generic tab label (excluding generic labels like `Terminal 1`, `defaultTitle`, `agy`, `claude`, `codex`, `gemini`, shell names, and path fragments)
> 4. Conversation summary (`cliCustomTitle` → `journal` title → `conversation_summaries.db` title → prompt preview)
> 5. Generic PTY fallback (`Terminal 1` / `agy` / `<agent> session`) only when zero conversation turns or summaries exist yet (`0 tok`)

## Prerequisites

- Orca CLI `>=1.4.248` (`orca plugin validate .`, `orca plugin test .`, `orca plugin check .`)
- Node.js `>=22.16` (`v26.13.0` installed) with built-in `node:sqlite` (`Database ?? DatabaseSync` opened strictly with `{ readOnly: true, timeout: 300 }`), `node:fs`, `node:url`, and `node:test`

## Dependency Graph

```
T1 (Journal: Tab Titles + Antigravity Summary DB) ──┬── T4 (Scanner: CWD, Cache v4 & Subagent Hints) ── T6 (Aggregator: Binding & Title Chain) ── T5 (Worker: Workspace & Settle Sync) ──┐
                                                    │                                                                                                                                    │
T2 (Parsers: CLI Custom Title & Heuristic CWD) ─────┘                                                                                                                                    ├── T7 (Regression Suite) ── T8 (Live Orca Check)
                                                                                                                                                                                         │
T3 (Publish Script: Allow *-plan.md in Dirty Check) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Tasks

### T1: Terminal Tab Title Extraction & Antigravity Summary Reader
- **depends_on**: []
- **location**: `src/journal.ts`
- **description**:
  1. Update `loadSqliteConstructor()` to resolve `sqliteMod.Database ?? sqliteMod.DatabaseSync` for Node 26 compatibility while preserving `{ readOnly: true, timeout: 300 }` and `.close()` in `finally`.
  2. Export `isGenericTerminalTabLabel(raw: unknown, defaultTitle?: unknown): boolean` and `sanitizeTerminalGeneratedTitle(raw: unknown, defaultTitle?: unknown): string | null`:
     - Filter generic process/tab labels (`Terminal \d+`, `defaultTitle`, `agy`, `antigravity`, `claude`, `claude code`, `codex`, `gemini`, `zsh`, `bash`, `fish`, `sh`, `tmux`, `pwsh`, `node`, `~`, and truncated path prefixes `..` / `/`).
     - Detect boilerplate handoff/system headers in `generatedTitle` / `generatedLabel` (`/^\s*continue work from the prior orca\b/i`, `<USER_REQUEST>`, internal title-generator prompts): extract `Session:\s*([^\r\n]+)` if present, otherwise return `null` so resolution falls through cleanly to conversation summaries instead of displaying `"Continue work from the prior Orca"`.
  3. Expand `profile-state.db` (`tabsByWorktree` + `unifiedTabs`) parsing in `readOrcaJournalIndex`:
     - Filter `unifiedTabs` terminal entries strictly by `u.contentType === 'terminal'`, capturing `customLabel`, `generatedLabel`, `label`, `lastFocusedAt`, `worktreeId`, and `entityId` (and synthesizing a `TerminalTabMeta` if `unifiedTabs` contains an open terminal tab not yet flushed to `tabsByWorktree`).
     - For `u.contentType === 'agent-session'`, propagate non-generic `customLabel || generatedLabel || label` updates to `byOrcaSessionId` and **all** `byNativeId` entries matching `entry.orcaSessionId === orcaSessId`.
     - Resolve each terminal tab's `effectiveTitle` via `customTitle || customLabel` → sanitized `generatedTitle || generatedLabel` → non-generic `title || label`, while also storing `rawTabLabel` (`uMeta?.label || t.title || t.defaultTitle`) for `0 tok` fallback cards.
     - Populate `ptyCustomTitles` under `ptyId`, `tabId`, and `pty:${ptyId}` **only when `effectiveTitle !== null`**, and record all terminal tabs in `terminalTabs: TerminalTabMeta[]`.
  4. Add `readAntigravityConversationSummaries` + `readAntigravityHistoryTail` inside `readOrcaJournalIndex`:
     - Query `conversation_summaries.db` across `~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, `<orcaDir>/antigravity-chat/{antigravity-acp,antigravity-cli}`, and discovered Antigravity `accountHomes` in `readOnly: true` mode.
     - Decode `workspace_uris` via `JSON.parse` (decoding each `file://` URI with `fileURLToPath` and `decodeURIComponent` fallback), storing `workspacePaths: string[]` and preferring an entry matching known Orca worktrees / `terminalTabs` before `decoded[0]`.
     - Check `parent_conversation_id != '' OR nesting_depth > 0` plus `conversation_parents` (in an inner `try/catch`) to detect subagents, and **merge non-destructively field-by-field** across DB instances (`title: cleanTitle || existing?.title || null`, `workspacePath: newWs || existing?.workspacePath || null`, `isSubagent: Boolean(existing?.isSubagent || newIsSubagent)`).
     - Read the trailing 64 KiB of `history.jsonl` (skipping partial bytes up to the first `\n` when `startOffset > 0`), extracting `entry.workspace ?? entry.cwd ?? entry.project` and sanitized `display` preview for zero-latency turn-1 `cwd` matching.
- **validation**: `readOrcaJournalIndex` resolves `#54`, `# debug`, and non-boilerplate `generatedTitle` / `generatedLabel` across `ptyId` and `tabId`, filters `"Continue work from the prior Orca"`, merges multi-DB Antigravity summaries without blanking titles, and decodes multi-root `file://` `workspace_uris`.
- **status**: Completed
- **log**: Implemented `Database ?? DatabaseSync` SQLite loader, `inferAgentFromTerminalTitle`, `isGenericTerminalTabLabel`, `sanitizeTerminalGeneratedTitle`, `tabsByWorktree` + `unifiedTabs` terminal extraction (including `identity:wt2:local:<uuid>` path mapping and `ptyId`/`tabId`/`pty:<ptyId>` indexing), and multi-home `conversation_summaries.db` + trailing 64 KiB `history.jsonl` hydration with non-destructive merging and subagent detection.
- **files edited/created**: `src/journal.ts`

### T2: Parser CLI Rename & Handoff Prompt Metadata Separation
- **depends_on**: []
- **location**: `src/parsers.ts`
- **description**:
  1. Add `cliCustomTitle: string | null` and `cwdIsHeuristic?: boolean` to `SessionTranscriptState` (initialized to `null` / `false` in `createEmptySessionState`).
  2. In `applyClaudeLines`, store explicit Claude `/rename` `obj.customTitle` on `state.cliCustomTitle` (as well as `state.titleHint`) so explicit CLI renames remain distinguishable from auto-extracted prompt previews.
  3. Keep `sanitizePromptPreview` extracting `Session: <priorTitle>` on `Continue work from the prior Orca session` prompts strictly as a `state.titleHint` fallback so Orca's Terminal tab `customTitle` / `generatedTitle` cleanly supersedes the prior Chat UI session's name whenever present.
- **validation**: Parser unit checks pass; `cliCustomTitle` is populated only by explicit CLI rename entries while `titleHint` preserves handoff fallback and `#` prefixes.
- **status**: Completed
- **log**: Added `cliCustomTitle` and `cwdIsHeuristic` to `SessionTranscriptState`; separated Claude `/rename` `cliCustomTitle` from handoff `Session:` `titleHint` fallback.
- **files edited/created**: `src/parsers.ts`

### T3: Publish Script Dirty-Worktree Allowlist Update
- **depends_on**: []
- **location**: `scripts/publish-plugin.sh`
- **description**: Update **only** the `git status --porcelain` `case "$path"` allowlist (around line 65) in `scripts/publish-plugin.sh` to accept `*-plan.md` alongside `token-pulse-plan.md`, leaving the `git add` release staging list untouched so local plan files never block `--dry-run` checks and are never committed into release tags.
- **validation**: Allowlist check accepts `terminal-tab-title-sync-plan.md` while still rejecting unrelated dirty source files and never staging `*-plan.md`.
- **status**: Completed
- **log**: Updated line 65 `case "$path"` allowlist to include `*-plan.md` while keeping line 127 `git add` unchanged.
- **files edited/created**: `scripts/publish-plugin.sh`

### T4: Scanner Antigravity Workspace, Cache v4 & Subagent Hydration
- **depends_on**: [T1, T2]
- **location**: `src/scanner.ts`
- **description**:
  1. Bump `HISTORICAL_CACHE_STORAGE_KEY` from `'historicalSessions.v3'` to `'historicalSessions.v4'` so previously persisted historical summaries with `cwd: null` or missing `cliCustomTitle` re-parse cleanly once on upgrade, and persist `cliCustomTitle` in `CachedFileSummary` (only persisting non-heuristic `cwd` values when `cwdIsHeuristic` is false).
  2. Add `applyJournalSessionHints()` and run it across **all** `this.statesByFile.values()` in both `scan()` and `pollHotFiles()` (outside the unchanged-`offsetBytes` `continue` path, setting `this.dirtyHistoricalCache = true` whenever a `< todayStartMs` state's `cwd` or `isSubagent` updates):
     - For `antigravity` sessions, overwrite `state.cwd` from `journalIndex.antigravitySummaries.get(state.sessionId)?.workspacePath` whenever `state.cwd === null || state.cwdIsHeuristic` (clearing `cwdIsHeuristic = false`).
     - If `state.cwd` is still `null`, match `journalIndex.antigravityHistoryEntries` within `±15s` of `state.createdAtMs` (tie-breaking by prompt preview match against `state.titleHint` before timestamp distance) and set `state.cwdIsHeuristic = true` until `conversation_summaries.db` flushes.
     - Propagate `state.isSubagent = true` when `antigravitySummaries.get(state.sessionId)?.isSubagent` is `true`.
  3. Include `workspacePath` values from `journalIndex.terminalTabs` in `allKnownPaths` before calling `buildGeminiProjectHashLookup` so Gemini CLI sessions in Terminal-only workspaces resolve `state.cwd` on cold start.
- **validation**: Scanning an Antigravity CLI `transcript.jsonl` resolves its authoritative worktree path and subagent flag even when `conversation_summaries.db` flushes on a later tick with zero new transcript bytes, and upgrades heuristic `history.jsonl` `cwd` values once SQLite flushes.
- **status**: Completed
- **log**: Bumped cache key to `historicalSessions.v4`, added `applyJournalSessionHints(now)` across `scan()` and `pollHotFiles()`, hydrated Antigravity `cwd` and `isSubagent` from SQLite summaries and `history.jsonl`, and added terminal tab worktrees into Gemini hash lookup.
- **files edited/created**: `src/scanner.ts`

### T6: Aggregator Spawn-Affine / Sequential Binding & Title Priority Chain
- **depends_on**: [T1, T2, T4]
- **location**: `src/aggregator.ts`
- **description**:
  1. Extend `OrcaLiveAgentInfo` with `workspacePath?: string | null` and resolve a PTY entry's workspace path via `la.workspacePath ?? matchedTab?.workspacePath ?? extractWorkspacePathFromId(la.terminalId)`.
  2. Implement deterministic matching between `journal.terminalTabs` and CLI sessions (and align `canBindPtyToCliSession` for resumed sessions):
     - Hard eligibility filters: non-subagent, same/child worktree (`isSameOrChildWorktreePath`), agent compatibility (`!tab.agent || tab.agent === st.agent`), minimum time overlap (`tab.createdAt <= 0 || st.createdAtMs >= tab.createdAt - 15_000 || st.updatedAtMs >= tab.createdAt`), and for `jMeta !== undefined` require `!(jMeta.isLiveLease || jMeta.isTurnOpen) && tab.createdAt > 0 && st.updatedAtMs >= tab.createdAt && !st.filePath.includes('antigravity-acp')`.
     - Rank eligible `(tab, session)` pairs by: (a) open tab in `unifiedTabs` (`isOpenInUnifiedTabs`), (b) standalone CLI (`!jMeta`) ahead of closed native session resumed in terminal, (c) interval ownership (`st.createdAtMs >= tab.createdAt - 15_000` with no compatible newer `tab2` having `tab.createdAt < tab2.createdAt <= st.createdAtMs + 2_000`), (d) **latest `st.updatedAtMs`** (so starting a second CLI session sequentially in the same terminal tab hands the tab title forward to the active session), and (e) smallest `Math.abs(st.createdAtMs - tab.createdAt)`.
  3. Apply the confirmed title resolution chain consistently in `enrichSessions`, `buildLiveAgentCards`, and `pollSingleLiveAgent`:
     - `matchedTab?.effectiveTitle` (`customTitle/customLabel` → non-boilerplate `generatedTitle/generatedLabel` → non-generic tab label)
     - `st.cliCustomTitle`
     - `jMeta?.title`
     - `journal.antigravitySummaries?.get(st.sessionId)?.title`
     - `st.titleHint`
     - Provider/session fallback (`<Provider> · <id8>`), or for `0 tok` unbound live PTY cards: `matchedTab?.effectiveTitle || (!isGenericTerminalTabLabel(la.title) ? la.title : null) || matchedTab?.rawTabLabel || la.title?.trim() || "<agent> session"`.
  4. In `buildLiveAgentCards` / `matchPtyTerminalsToSessions`, look up `journal.terminalTabs` and `ptyCustomTitles` across `la.terminalId` (`ptyId`, `tabId`, `pty:${ptyId}`) so active PTY + CLI transcript merge into one card; in `pollSingleLiveAgent`, also match `sessionKey.startsWith('terminal:') && c.id === sessionKey.slice('terminal:'.length)` so an open `0 tok` detail drawer transitions seamlessly when its first turn arrives.
- **validation**: Active Terminal CLI sessions merge with their PTY entry into one card (zero duplicate `0 tok` card), preserve `Terminal 1` on `0 tok` unrenamed tabs when `la.title` is `"agy"`, hand titles forward across sequential sessions in one tab, and isolate parallel tabs in the same worktree.
- **status**: Completed
- **log**: Implemented global pair-ranking `matchTerminalTabsToCliSessions` with interval ownership + active-occupancy vs sequential-handoff disambiguation, unified the 5-level title chain across `enrichSessions`/`buildLiveAgentCards`/`pollSingleLiveAgent`, and supported `terminal:<ptyId>` detail-drawer transition.
- **files edited/created**: `src/aggregator.ts`

### T5: Worker Live Terminal Workspace, Poll Ordering & Settle Coalescing
- **depends_on**: [T1, T6]
- **location**: `src/worker.ts`
- **description**:
  1. Populate `workspacePath` on live agent entries from `terminalToWorkspacePath.get(id) ?? extractWorkspacePathFromId(id)` in both `agents.list` and `agent.status.changed`, preserving `prev?.agent` and `prev?.workspacePath` across updates.
  2. In `agent.livePoll`, call `scanner.refreshJournal(now, 800)` **before** `scanner.pollHotFiles(now, sessionKey)` so newly flushed `conversation_summaries.db` and `profile-state.db` tab titles apply on the exact same poll tick.
  3. In `orca.events.on('workspace.changed')`, track both `250ms` and `900ms` settle timers (clearing prior pending timers on re-trigger and in `activeCleanup`); when the `900ms` settle timer fires, refresh the journal (`scanner.refreshJournal(Date.now(), 0)`) and publish immediately—or if `refreshInFlight` is active, chain onto `refreshInFlight.finally(...)` (guarded by `!stopped`) so post-SQLite-flush tab renames are never coalesced away.
- **validation**: Worker lifecycle tests confirm `workspace.changed` triggers post-flush journal refresh even if an initial refresh is in flight, `agent.livePoll` hydrates fresh journal state before hot-file polling, and all timers clean up on `deactivate`.
- **status**: Completed
- **log**: Preserved live agent `workspacePath` (including `identity:wt2:local:<uuid>` lookup via `workspaceListCache`), refreshed journal before `pollHotFiles` in `agent.livePoll`, and added `900ms` post-flush settle timer in `workspace.changed` with `refreshInFlight.finally` chaining.
- **files edited/created**: `src/worker.ts`

### T7: Automated Regression & Integration Tests
- **depends_on**: [T3, T5, T6]
- **location**: `src/plugin.test.ts`
- **description**: Update the test SQLite helper (`sqliteMod.Database ?? sqliteMod.DatabaseSync`) and add targeted regression tests executed via `orca plugin test .` covering:
  1. **Screenshot reproduction (Antigravity CLI + `#54` / `# debug` Terminal tab)**: real SQLite `profile-state.db` + `conversation_summaries.db` + `transcript.jsonl` without `USER_INPUT` `cwd` resolves worktree path, merges PTY + transcript into a single Live card, and renders `#54` (not `Terminal 1`, `local`, or raw prompt).
  2. **Chat UI → Terminal handoff (normal + boilerplate `generatedTitle`)**:
     - Terminal tab with `customTitle: null`, `title: "agy"`, `defaultTitle: "Terminal 1"`, and `generatedTitle: "Token 流速圖表 UI/UX 重新設計"` displays `"Token 流速圖表 UI/UX 重新設計"`, and updates to `# handoff-fix` once `customTitle` is set.
     - Terminal tab whose `generatedTitle` was auto-sliced to boilerplate `"Continue work from the prior Orca"` is filtered out and falls back to `conversation_summaries.db` title / `Session: <priorTitle>` hint instead of showing boilerplate text.
  3. **Plain unrenamed Terminal fallback (`rawTabLabel`)**: terminal tab with `customTitle: null`, `generatedTitle: null`, `title: "Terminal 1"`, and live agent `la.title: "agy"` displays `"Terminal 1"` while at `0 tok`, then transitions to the conversation summary once turns exist.
  4. **Same-worktree multi-terminal isolation & sequential sessions**:
     - Two parallel same-agent terminal tabs (`# tab-1` at `t0`, `# tab-2` at `t0 + 60s`) keep their respective sessions even after `# tab-1` gets a newer `lastFocusedAt` at `t0 + 120s`.
     - Two sequential CLI sessions launched one after another inside a single terminal tab (`# tab-1`) hand `# tab-1` forward to the newly active second session while the exited first session reverts to its conversation summary.
  5. **Multi-DB Antigravity merge & subagent filtering**: newer empty `title: ""` in `~/.gemini/antigravity/conversation_summaries.db` does not overwrite valid `title` in `~/.gemini/antigravity-cli/conversation_summaries.db`, and child brains (`parent_conversation_id` / `nesting_depth > 0` / `conversation_parents`) contribute to period totals without appearing in Live/Sessions or claiming the parent tab's title.
  6. **Worker `workspace.changed` rename sync**: simulated tab rename writes to `profile-state.db` and emits `workspace.changed`, publishing updated `dashboard.updated` titles with zero host refusals.
- **validation**: `orca plugin test .` passes 100% with 0 failures and 0 host refusals.
- **status**: Completed
- **log**: Added 7 end-to-end SQLite/transcript/worker/shell regression tests (written RED first per `old-coder`, verified 15/15 passing and 5/5 manual mutants killed).
- **files edited/created**: `src/plugin.test.ts`

### T8: Live Orca Validation & Runtime Check
- **depends_on**: [T7]
- **location**: `orca-plugin.json`, `src/`
- **description**: Run `orca plugin validate .`, `orca plugin test .`, and `orca plugin check .`, verify the `scripts/publish-plugin.sh` allowlist guard cleanly accepts `*-plan.md` without modifying git state, reload the dev plugin in Orca if active, and inspect `orca plugin logs local.token-pulse` and `orca plugin shot` to confirm live Terminal tabs and handoff sessions display synchronized tab titles and worktree labels.
- **validation**: `orca plugin validate .`, `orca plugin test .`, and `orca plugin check .` exit 0 with zero panel/worker errors.
- **status**: Completed
- **log**: Verified `orca plugin validate .`, `orca plugin check .`, `orca plugin test .` (15/15 pass), 5/5 mutation tests killed, `orca plugin dev reload .`, and `orca plugin shot local.token-pulse` confirming `# debug` (`orca-token-used / main`) renders as a single merged card with zero duplicate `0 tok` `Terminal 1` card.
- **files edited/created**: `terminal-tab-title-sync-plan.md`

## Parallel Execution Groups

| Wave | Tasks | Can Start When |
|------|-------|----------------|
| 1 | T1, T2, T3 | Immediately (disjoint files: `src/journal.ts`, `src/parsers.ts`, `scripts/publish-plugin.sh`) |
| 2 | T4 | T1 and T2 complete (`src/scanner.ts`) |
| 3 | T6 | T1, T2, T4 complete (`src/aggregator.ts`, exports `OrcaLiveAgentInfo.workspacePath`) |
| 4 | T5 | T1 and T6 complete (`src/worker.ts`) |
| 5 | T7 | T3, T5, T6 complete (`src/plugin.test.ts`) |
| 6 | T8 | T7 complete (validation & live Orca check) |

## Testing Strategy

- **Unit & SQLite Fixture Tests (`orca plugin test .`)**: Create temporary SQLite `profile-state.db` and multi-DB `conversation_summaries.db` fixtures plus temporary `history.jsonl` and `.jsonl` transcripts in `os.tmpdir()` to test real `node:sqlite` queries, URI decoding, WAL/read-only behavior, handoff prompts, sequential sessions, and multi-tab disambiguation end-to-end.
- **Contract & Render Verification (`orca plugin validate .` & `orca plugin check .`)**: Verify manifest schema compliance, TypeScript types against `.orca/types`, and headless panel rendering without runtime errors or capability refusals.
- **Red-Green Discipline (`old-coder` workflow)**: Before implementing fixes in code, write/run failing specification tests first, implement minimal surgical changes, and verify full gauntlet pass (`validate`, `test`, `check`).

## Risks & Mitigations

- **SQLite WAL lock contention with Orca or Antigravity CLI**: Always open `profile-state.db` and `conversation_summaries.db` with `{ readOnly: true, timeout: 300 }`, wrap queries in `try/catch`, and close handles in `finally` so active writers are never blocked.
- **Windows / multi-root URI path encoding in `workspace_uris`**: Parse JSON arrays and decode `file://` URIs via `node:url` `fileURLToPath` (with `decodeURIComponent` fallback), preferring paths matching known Orca worktrees / `terminalTabs`.
- **Delayed `conversation_summaries.db` flush or historical cache staleness**: Combine `history.jsonl` turn-1 heuristic matching with `applyJournalSessionHints` across all cached states on every poll tick, and bump `HISTORICAL_CACHE_STORAGE_KEY` to `v4`.
- **Cross-stealing vs. sequential sessions in Terminal tabs**: Combine spawn-interval ownership (`createdAt` vs `createdAtMs`) for parallel tabs with `updatedAtMs` priority inside the owned interval so sequential CLI sessions in the same tab seamlessly inherit the tab's title.

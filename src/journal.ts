import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentKind } from './protocol'

interface SqliteStatement {
  all(): Array<Record<string, unknown>>
  get(): Record<string, unknown> | undefined
}

interface SqliteReadOnlyDb {
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteDbConstructor = new (
  dbPath: string,
  options?: { readOnly?: boolean; timeout?: number }
) => SqliteReadOnlyDb

export interface JournalSessionMeta {
  orcaSessionId: string
  nativeId: string
  provider: AgentKind
  title: string | null
  workspacePath: string | null
  model: string | null
  updatedAt: number
  turnUpdatedAt?: number
  isLiveLease: boolean
  isTurnOpen: boolean
  lastTurnState?: 'open' | 'settled' | null
}

export type TerminalTabTitleSource = 'custom' | 'generated' | 'label' | null

export interface TerminalTabTitleOverride {
  ptyId: string
  workspacePath: string
  agent: AgentKind | null
  customTitle: string
  createdAt: number
  lastFocusedAt: number
}

export interface TerminalTabMeta {
  ptyId: string
  tabId: string
  workspacePath: string
  agent: AgentKind | null
  effectiveTitle: string | null
  titleSource: TerminalTabTitleSource
  rawTabLabel: string | null
  createdAt: number
  lastFocusedAt: number
  isOpenInUnifiedTabs: boolean
}

export interface AntigravityConversationSummaryMeta {
  conversationId: string
  parentConversationId: string | null
  title: string | null
  workspacePath: string | null
  workspacePaths: string[]
  isSubagent: boolean
  updatedAtMs: number
}

export interface AntigravityHistoryEntry {
  timestampMs: number
  workspacePath: string
  conversationId: string | null
  displayPreview: string | null
}

export interface JournalIndex {
  byNativeId: Map<string, JournalSessionMeta>
  byOrcaSessionId: Map<string, JournalSessionMeta>
  accountHomes: Map<AgentKind, Set<string>>
  /** Latest observed live/recent activity timestamp per workspacePath */
  workspaceActivityMs: Map<string, number>
  /** Non-generic terminal tab titles keyed by ptyId, tabId, and `pty:<ptyId>` */
  ptyCustomTitles?: Map<string, string>
  /** Active PTY terminal tabs with user-defined/generated title (legacy override shape) */
  terminalTabOverrides?: TerminalTabTitleOverride[]
  /** All discovered Orca terminal tabs (renamed, generated, and plain) */
  terminalTabs?: TerminalTabMeta[]
  /** Authoritative Antigravity workspace paths, titles, and subagent flags from conversation_summaries.db */
  antigravitySummaries?: Map<string, AntigravityConversationSummaryMeta>
  /** Explicit conversationId -> workspacePath mappings from history.jsonl */
  antigravityHistoryByConversationId?: Map<string, string>
  /** Recent Antigravity CLI prompt history entries for zero-latency turn-1 cwd matching */
  antigravityHistoryEntries?: AntigravityHistoryEntry[]
  /** Configured default model slugs read from local CLI settings (`agy`, `codex`, `claude`, `gemini`) */
  cliConfiguredModels?: Partial<Record<AgentKind, string>>
}

export interface OrcaActiveWorktreeSelection {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
}

function loadSqliteConstructor(): SqliteDbConstructor | null {
  try {
    const req = createRequire(import.meta.url)
    const sqliteMod = req('node:sqlite') as {
      Database?: SqliteDbConstructor
      DatabaseSync?: SqliteDbConstructor
    }
    return sqliteMod.Database ?? sqliteMod.DatabaseSync ?? null
  } catch {
    return null
  }
}

function canonicalDirKey(dirPath: string): string | null {
  try {
    const st = fs.statSync(dirPath)
    if (st.dev || st.ino) {
      return `${st.dev}:${st.ino}`
    }
    return fs.realpathSync.native(dirPath)
  } catch {
    return null
  }
}

export function defaultOrcaAppDataDirs(homeDir = os.homedir()): string[] {
  const envOverride = process.env.TOKEN_PULSE_ORCA_DATA_DIR || process.env.ORCA_USER_DATA_PATH
  const rawCandidates: string[] = []
  if (envOverride && envOverride.trim()) {
    rawCandidates.push(envOverride.trim())
  } else if (process.platform === 'darwin') {
    rawCandidates.push(path.join(homeDir, 'Library', 'Application Support', 'orca'))
    rawCandidates.push(path.join(homeDir, 'Library', 'Application Support', 'Orca'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    rawCandidates.push(path.join(appData, 'orca'))
    rawCandidates.push(path.join(appData, 'Orca'))
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
    rawCandidates.push(path.join(xdg, 'orca'))
    rawCandidates.push(path.join(xdg, 'Orca'))
  }

  // Deduplicate by (dev, ino) + native realpath so case-insensitive APFS/NTFS never scans `orca` and `Orca` twice
  const seenKeys = new Set<string>()
  const uniqueDirs: string[] = []
  for (const candidate of rawCandidates) {
    const key = canonicalDirKey(candidate)
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    try {
      uniqueDirs.push(fs.realpathSync.native(candidate))
    } catch {
      uniqueDirs.push(candidate)
    }
  }
  return uniqueDirs
}

export function extractWorkspacePathFromId(workspaceId: unknown): string | null {
  if (typeof workspaceId !== 'string' || !workspaceId) return null
  const withoutPtySuffix = workspaceId.includes('@@')
    ? workspaceId.slice(0, workspaceId.indexOf('@@'))
    : workspaceId
  const sepIdx = withoutPtySuffix.indexOf('::')
  const candidate = sepIdx >= 0 ? withoutPtySuffix.slice(sepIdx + 2) : withoutPtySuffix
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) ? candidate : null
}

function listCandidateProfileStateDbs(orcaDir: string): string[] {
  let profileId = 'local-default'
  const indexPath = path.join(orcaDir, 'orca-profile-index.json')
  try {
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        activeProfileId?: unknown
      }
      if (typeof idx?.activeProfileId === 'string' && idx.activeProfileId.trim()) {
        profileId = idx.activeProfileId.trim()
      }
    }
  } catch {
    // Fallback to local-default
  }

  if (path.basename(profileId) !== profileId || profileId === '.' || profileId === '..') {
    profileId = 'local-default'
  }

  // Read only the active profile. Other profiles may contain unrelated user data.
  return [path.join(orcaDir, 'profiles', profileId, 'profile-state.db')]
}

/**
 * Reads Orca's left-sidebar focused worktree (`workspaceSession.activeWorktreeId`) from the active
 * profile's `profile-state.db` strictly in `readOnly: true` mode (~0.5ms).
 * This resolves same-named worktrees across different Orca projects (`Project -> main`) with 100% accuracy.
 */
export function readOrcaActiveWorktreeSelection(
  orcaDirs = defaultOrcaAppDataDirs()
): OrcaActiveWorktreeSelection {
  const empty: OrcaActiveWorktreeSelection = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorktreePath: null
  }

  const DatabaseSyncCtor = loadSqliteConstructor()
  if (!DatabaseSyncCtor) return empty

  for (const orcaDir of orcaDirs) {
    for (const dbPath of listCandidateProfileStateDbs(orcaDir)) {
      if (!fs.existsSync(dbPath)) continue
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 300 })
        const wtRow = db
          .prepare(
            "SELECT payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND part_key = '[\"activeWorktreeId\"]' LIMIT 1"
          )
          .get()
        const repoRow = db
          .prepare(
            "SELECT payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND part_key = '[\"activeRepoId\"]' LIMIT 1"
          )
          .get()

        const parsedWt =
          typeof wtRow?.payload === 'string' ? (JSON.parse(wtRow.payload) as unknown) : null
        const parsedRepo =
          typeof repoRow?.payload === 'string' ? (JSON.parse(repoRow.payload) as unknown) : null

        const activeWorktreeId =
          typeof parsedWt === 'string' && parsedWt.trim() ? parsedWt.trim() : null
        const activeRepoId =
          typeof parsedRepo === 'string' && parsedRepo.trim() ? parsedRepo.trim() : null

        if (activeWorktreeId || activeRepoId) {
          return {
            activeRepoId,
            activeWorktreeId,
            activeWorktreePath: extractWorkspacePathFromId(activeWorktreeId)
          }
        }
      } catch {
        // Ignore locked or uninitialized profile-state.db
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  return empty
}

export function readProfileStateTerminalToTabId(
  orcaDirs = defaultOrcaAppDataDirs()
): Map<string, string> {
  const map = new Map<string, string>()
  const DatabaseSyncCtor = loadSqliteConstructor()
  if (!DatabaseSyncCtor) return map

  for (const orcaDir of orcaDirs) {
    for (const dbPath of listCandidateProfileStateDbs(orcaDir)) {
      if (!fs.existsSync(dbPath)) continue
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 300 })
        const tabRows = db
          .prepare(
            "SELECT part_key, payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND (part_key LIKE '[\"tabsByWorktree\",%' OR part_key LIKE '[\"unifiedTabs\",%')"
          )
          .all() as Array<{ part_key?: string; payload?: string }>

        for (const r of tabRows) {
          if (!r?.part_key || !r.payload) continue
          let arr: unknown
          try {
            arr = JSON.parse(r.payload)
          } catch {
            continue
          }
          if (!Array.isArray(arr)) continue

          if (r.part_key.startsWith('["unifiedTabs",')) {
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue
              const u = item as Record<string, unknown>
              const tabId = typeof u.id === 'string' ? u.id.trim() : ''
              const entityId = typeof u.entityId === 'string' ? u.entityId.trim() : ''
              if (tabId) {
                map.set(tabId, tabId)
                if (entityId) map.set(entityId, tabId)
              }
            }
          } else if (r.part_key.startsWith('["tabsByWorktree",')) {
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue
              const t = item as Record<string, unknown>
              const tabId = typeof t.id === 'string' ? t.id.trim() : ''
              const ptyId = typeof t.ptyId === 'string' ? t.ptyId.trim() : ''
              const terminalId = typeof t.terminalId === 'string' ? t.terminalId.trim() : ''
              if (tabId) {
                map.set(tabId, tabId)
                if (ptyId) map.set(ptyId, tabId)
                if (terminalId) map.set(terminalId, tabId)
                if (Array.isArray(t.terminals)) {
                  for (const sub of t.terminals) {
                    if (sub && typeof sub === 'object') {
                      const stId =
                        typeof (sub as { id?: unknown }).id === 'string'
                          ? (sub as { id: string }).id.trim()
                          : ''
                      if (stId) map.set(stId, tabId)
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // Ignore locked or corrupt profile-state.db
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  return map
}

function mapProviderToAgent(provider: unknown): AgentKind | null {
  const p = String(provider || '').toLowerCase().trim()
  if (p === 'claude' || p === 'claude-code') return 'claude'
  if (p === 'codex' || p === 'openai-codex') return 'codex'
  if (p === 'antigravity' || p === 'agy') return 'antigravity'
  if (p === 'gemini' || p === 'gemini-cli') return 'gemini'
  return null
}

export function inferAgentFromTerminalTitle(rawTitle: unknown): AgentKind | null {
  if (typeof rawTitle !== 'string') return null
  const t = rawTitle.trim().toLowerCase()
  if (t === 'agy' || t.startsWith('agy ') || t === 'antigravity') return 'antigravity'
  if (t === 'claude' || t.startsWith('claude ')) return 'claude'
  if (t === 'codex' || t.startsWith('codex ')) return 'codex'
  if (t === 'gemini' || t.startsWith('gemini ')) return 'gemini'
  return null
}

/**
 * Normalizes a conversation/tab title while strictly preserving user-written `#` prefixes
 * (e.g. `# 优化 skills`, `# orca plugins init`, `#QA`, `# Wilson`).
 */
export function cleanConversationTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : null
}

function isGenericChatTabLabel(label: string | null): boolean {
  if (!label) return true
  return /^(codex|claude|claude code|antigravity|gemini|agent|new)\s+chat$/i.test(label.trim())
}

/**
 * Returns true if `raw` is a generic terminal/shell/process placeholder or boilerplate header
 * rather than a meaningful conversation or user-assigned tab title.
 */
export function isGenericTerminalTabLabel(raw: unknown, defaultTitle?: unknown): boolean {
  const s = cleanConversationTitle(raw)
  if (!s) return true
  const def = cleanConversationTitle(defaultTitle)
  if (def && s.toLowerCase() === def.toLowerCase()) return true

  if (/^terminal(?:\s+\d+)?$/i.test(s)) return true
  if (
    /^(agy|antigravity|claude|claude code|codex|openai codex|gemini|gemini cli|zsh|bash|fish|sh|dash|ksh|csh|tcsh|tmux|screen|pwsh|powershell|cmd|cmd\.exe|node|python|python3)$/i.test(
      s
    )
  ) {
    return true
  }
  if (/^(codex|claude|claude code|antigravity|gemini|agent|new)\s+(chat|session|terminal)$/i.test(s)) {
    return true
  }
  if (
    s === '~' ||
    s.startsWith('~/') ||
    s.startsWith('~\\') ||
    s.startsWith('/') ||
    s.startsWith('..') ||
    /^[A-Za-z]:[\\/]/.test(s)
  ) {
    return true
  }
  if (/^continue work from the prior orca\b/i.test(s)) return true
  if (s.includes("Name this chat from the user's first request.") || s.includes('<USER_REQUEST>')) {
    return true
  }
  return false
}

/**
 * Sanitizes Orca's `generatedTitle` / `generatedLabel`, rescuing `Session: <name>` if a full
 * handoff header was captured and rejecting truncated boilerplate like `"Continue work from the prior Orca"`.
 */
export function sanitizeTerminalGeneratedTitle(
  raw: unknown,
  defaultTitle?: unknown
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let s = raw
  const userReqMatch = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)
  if (userReqMatch) {
    s = userReqMatch[1]
  }
  if (/^\s*continue work from the prior orca\b/i.test(s)) {
    const sessMatch = s.match(/Session:\s*([^\r\n]+)/i)
    if (sessMatch?.[1]?.trim()) {
      s = sessMatch[1].trim()
    } else {
      return null
    }
  }
  s = s.replace(/<[^>]+>/g, ' ')
  const cleaned = cleanConversationTitle(s)
  if (!cleaned || isGenericTerminalTabLabel(cleaned, defaultTitle)) return null
  return cleaned
}

/**
 * Normalizes human-readable CLI setting model names (e.g. `"Gemini 4 Carbon (Medium)"` or
 * `"openai-codex/gpt-6.1-sol"`) into clean canonical display slugs (`"gemini-4-carbon"`, `"gpt-6.1-sol"`).
 */
export function normalizeConfiguredModelSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  const slashIdx = s.lastIndexOf('/')
  if (slashIdx >= 0) {
    s = s.slice(slashIdx + 1).trim()
  }
  // Strip trailing reasoning/tier parentheses such as " (Medium)", " (High)", " (Thinking)"
  s = s.replace(/\s*\([^)]+\)\s*$/, '').trim()
  if (!s) return null
  if (/\s/.test(s)) {
    s = s.toLowerCase().replace(/\s+/g, '-')
  }
  return s
}

export function normalizeReasoningLevel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase().replace(/[_-]+/g, ' ')
  if (!value) return null
  const aliases: Record<string, string> = {
    xhigh: 'XHigh',
    'extra high': 'XHigh',
    high: 'High',
    medium: 'Medium',
    med: 'Medium',
    low: 'Low',
    minimal: 'Minimal',
    none: 'None',
    adaptive: 'Adaptive',
    max: 'Max'
  }
  return aliases[value] ?? value.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function readLocalCliConfiguredModels(
  homeDir: string,
  orcaDirs: string[]
): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {}

  // 1) Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)
  try {
    const agSettingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')
    if (fs.existsSync(agSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(agSettingsPath, 'utf8')) as { model?: unknown }
      const m = normalizeConfiguredModelSlug(parsed?.model)
      if (m) out.antigravity = m
    }
  } catch {
    // Ignore
  }

  // 2) Codex CLI (`~/.codex/config.toml` or Orca `codex-runtime-home/home/config.toml`)
  const codexConfigs = [
    path.join(homeDir, '.codex', 'config.toml'),
    ...orcaDirs.map((d) => path.join(d, 'codex-runtime-home', 'home', 'config.toml'))
  ]
  for (const cfgPath of codexConfigs) {
    try {
      if (!fs.existsSync(cfgPath)) continue
      const text = fs.readFileSync(cfgPath, 'utf8')
      const match = text.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m)
      const m = normalizeConfiguredModelSlug(match?.[1])
      if (m) {
        out.codex = m
        break
      }
    } catch {
      // Ignore
    }
  }

  // 3) Claude Code (`~/.claude/settings.json`)
  try {
    const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json')
    if (fs.existsSync(claudeSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) as { model?: unknown }
      const m = normalizeConfiguredModelSlug(parsed?.model)
      if (m) out.claude = m
    }
  } catch {
    // Ignore
  }

  // 4) Gemini CLI (`~/.gemini/settings.json`)
  try {
    const gemSettingsPath = path.join(homeDir, '.gemini', 'settings.json')
    if (fs.existsSync(gemSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(gemSettingsPath, 'utf8')) as {
        model?: string | { name?: unknown }
      }
      const rawModel =
        typeof parsed?.model === 'string'
          ? parsed.model
          : parsed?.model && typeof parsed.model === 'object'
            ? parsed.model.name
            : null
      const m = normalizeConfiguredModelSlug(rawModel)
      if (m) out.gemini = m
    }
  } catch {
    // Ignore
  }

  return out
}

function parseJournalTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw)
    if (Number.isFinite(num) && num > 0) {
      return num > 1e12 ? num : num * 1000
    }
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function decodeFileUriOrPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  let decoded = s
  if (s.startsWith('file://')) {
    try {
      decoded = fileURLToPath(s)
    } catch {
      try {
        decoded = decodeURIComponent(s.replace(/^file:\/\/(?:localhost)?/i, ''))
      } catch {
        decoded = s.replace(/^file:\/\/(?:localhost)?/i, '')
      }
    }
  }
  const cleaned = decoded.trim().replace(/[\\/]+$/, '')
  return cleaned.length > 0 ? cleaned : null
}

function normalizePathForMatch(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  try {
    return fs.realpathSync.native(trimmed)
  } catch {
    return path.resolve(trimmed)
  }
}

function decodeWorkspaceUris(
  rawUris: unknown,
  preferredNormPaths: Set<string>
): { primary: string | null; all: string[] } {
  const candidates: string[] = []
  if (Array.isArray(rawUris)) {
    for (const item of rawUris) {
      const dec = decodeFileUriOrPath(item)
      if (dec && !candidates.includes(dec)) candidates.push(dec)
    }
  } else if (typeof rawUris === 'string' && rawUris.trim()) {
    const trimmed = rawUris.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const dec = decodeFileUriOrPath(item)
            if (dec && !candidates.includes(dec)) candidates.push(dec)
          }
        }
      } catch {
        // Fall through to regex extraction
      }
    }
    if (candidates.length === 0) {
      const matches = trimmed.match(/file:\/\/[^\s"',\]]+/g)
      if (matches) {
        for (const m of matches) {
          const dec = decodeFileUriOrPath(m)
          if (dec && !candidates.includes(dec)) candidates.push(dec)
        }
      } else {
        const single = decodeFileUriOrPath(trimmed)
        if (single) candidates.push(single)
      }
    }
  }

  if (candidates.length === 0) return { primary: null, all: [] }
  if (preferredNormPaths.size > 0 && candidates.length > 1) {
    for (const c of candidates) {
      const cNorm = normalizePathForMatch(c)
      for (const pref of preferredNormPaths) {
        if (cNorm === pref || cNorm.startsWith(pref + path.sep)) {
          return { primary: c, all: candidates }
        }
      }
    }
  }
  return { primary: candidates[0], all: candidates }
}

function collectAntigravityDataDirs(
  homeDir: string,
  orcaDirs: string[],
  accountHomes: Set<string>
): string[] {
  const rawDirs: string[] = [
    path.join(homeDir, '.gemini', 'antigravity-cli'),
    path.join(homeDir, '.gemini', 'antigravity')
  ]
  for (const orcaDir of orcaDirs) {
    rawDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-cli'))
    rawDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-acp'))
    const agAccs = path.join(orcaDir, 'antigravity-accounts')
    try {
      if (fs.existsSync(agAccs)) {
        for (const ent of fs.readdirSync(agAccs, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            rawDirs.push(path.join(agAccs, ent.name))
            rawDirs.push(path.join(agAccs, ent.name, 'antigravity-cli'))
            rawDirs.push(path.join(agAccs, ent.name, 'antigravity-acp'))
          }
        }
      }
    } catch {
      // Ignore unreadable account dir
    }
  }
  for (const h of accountHomes) {
    rawDirs.push(h)
    rawDirs.push(path.join(h, 'antigravity-cli'))
    rawDirs.push(path.join(h, 'antigravity-acp'))
  }

  const seenKeys = new Set<string>()
  const out: string[] = []
  for (const d of rawDirs) {
    const key = canonicalDirKey(d)
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    try {
      out.push(fs.realpathSync.native(d))
    } catch {
      out.push(d)
    }
  }
  return out
}

function readAntigravityMetadata(
  agDirs: string[],
  DatabaseCtor: SqliteDbConstructor | null,
  preferredNormPaths: Set<string>
): {
  summaries: Map<string, AntigravityConversationSummaryMeta>
  historyByConvId: Map<string, string>
  historyEntries: AntigravityHistoryEntry[]
} {
  const summaries = new Map<string, AntigravityConversationSummaryMeta>()
  const historyByConvId = new Map<string, string>()
  const historyEntries: AntigravityHistoryEntry[] = []

  if (DatabaseCtor) {
    for (const agDir of agDirs) {
      const dbPath = path.join(agDir, 'conversation_summaries.db')
      if (!fs.existsSync(dbPath)) continue
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseCtor(dbPath, { readOnly: true, timeout: 300 })

        const parentByChildId = new Map<string, string>()
        try {
          const pRows = db.prepare('SELECT * FROM conversation_parents').all()
          for (const pr of pRows) {
            const childId = pr.conversation_id ?? pr.child_conversation_id ?? pr.child_id
            const parentId = pr.parent_conversation_id ?? pr.parent_id
            if (
              typeof childId === 'string' &&
              childId.trim() &&
              typeof parentId === 'string' &&
              parentId.trim()
            ) {
              parentByChildId.set(childId.trim(), parentId.trim())
            }
          }
        } catch {
          // Optional table
        }

        const colRows = db.prepare('PRAGMA table_info(conversation_summaries)').all()
        const availableCols = new Set(
          colRows
            .map((c) => (typeof c.name === 'string' ? c.name : ''))
            .filter((n) => n.length > 0)
        )
        if (!availableCols.has('conversation_id')) continue

        const wantedCols = [
          'conversation_id',
          'title',
          'workspace_uris',
          'last_modified_time',
          'updated_at',
          'parent_conversation_id',
          'nesting_depth'
        ].filter((c) => availableCols.has(c))

        const sRows = db
          .prepare(`SELECT ${wantedCols.join(', ')} FROM conversation_summaries`)
          .all()

        for (const r of sRows) {
          const convId = typeof r.conversation_id === 'string' ? r.conversation_id.trim() : ''
          if (!convId) continue

          const cleanTitle = cleanConversationTitle(r.title)
          const decoded = decodeWorkspaceUris(r.workspace_uris, preferredNormPaths)
          const rowUpdatedMs = parseJournalTimestampMs(r.last_modified_time ?? r.updated_at)
          const parentCol =
            typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id.trim() : ''
          const parentConversationId = parentCol || parentByChildId.get(convId) || null
          const depthNum = Number(r.nesting_depth) || 0
          const rowIsSubagent = Boolean(parentConversationId || depthNum > 0)

          const existing = summaries.get(convId)
          if (!existing) {
            summaries.set(convId, {
              conversationId: convId,
              parentConversationId,
              title: cleanTitle,
              workspacePath: decoded.primary,
              workspacePaths: decoded.all,
              isSubagent: rowIsSubagent,
              updatedAtMs: rowUpdatedMs
            })
          } else {
            const isNewer = rowUpdatedMs >= existing.updatedAtMs
            const mergedPaths = Array.from(
              new Set(
                isNewer
                  ? [...decoded.all, ...existing.workspacePaths]
                  : [...existing.workspacePaths, ...decoded.all]
              )
            )
            // Pick preferred path from mergedPaths if neither DB had a preferred primary yet
            let mergedPrimary = isNewer
              ? decoded.primary || existing.workspacePath
              : existing.workspacePath || decoded.primary
            if (preferredNormPaths.size > 0 && mergedPaths.length > 1) {
              for (const mp of mergedPaths) {
                const mpNorm = normalizePathForMatch(mp)
                if (
                  Array.from(preferredNormPaths).some(
                    (pref) => mpNorm === pref || mpNorm.startsWith(pref + path.sep)
                  )
                ) {
                  mergedPrimary = mp
                  break
                }
              }
            }
            summaries.set(convId, {
              conversationId: convId,
              parentConversationId: isNewer
                ? parentConversationId || existing.parentConversationId
                : existing.parentConversationId || parentConversationId,
              title: isNewer ? cleanTitle || existing.title : existing.title || cleanTitle,
              workspacePath: mergedPrimary,
              workspacePaths: mergedPaths,
              isSubagent: Boolean(existing.isSubagent || rowIsSubagent),
              updatedAtMs: Math.max(existing.updatedAtMs, rowUpdatedMs)
            })
          }
        }
      } catch {
        // Ignore locked/uninitialized conversation_summaries.db
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  // Read trailing 64 KiB of history.jsonl for zero-latency turn-1 workspace resolution
  const HISTORY_TAIL_BYTES = 64 * 1024
  for (const agDir of agDirs) {
    const histPath = path.join(agDir, 'history.jsonl')
    if (!fs.existsSync(histPath)) continue
    let fd: number | null = null
    try {
      const stat = fs.statSync(histPath)
      if (stat.size <= 0) continue
      const startOffset = Math.max(0, stat.size - HISTORY_TAIL_BYTES)
      const toRead = stat.size - startOffset
      const buf = Buffer.allocUnsafe(toRead)
      fd = fs.openSync(histPath, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, toRead, startOffset)
      if (bytesRead <= 0) continue

      let sliceStart = 0
      if (startOffset > 0) {
        const firstNl = buf.subarray(0, bytesRead).indexOf(0x0a)
        if (firstNl < 0) continue
        sliceStart = firstNl + 1
      }
      const text = buf.subarray(sliceStart, bytesRead).toString('utf8')
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const wsPath = decodeFileUriOrPath(obj.workspace ?? obj.cwd ?? obj.project)
        if (!wsPath) continue

        const rawConvId = obj.conversationId ?? obj.conversation_id ?? obj.sessionId
        const convId =
          typeof rawConvId === 'string' && rawConvId.trim() ? rawConvId.trim() : null
        if (convId) {
          historyByConvId.set(convId, wsPath)
        }
        const tsMs = parseJournalTimestampMs(
          obj.timestamp ?? obj.createdAt ?? obj.created_at ?? obj.time
        )
        const rawDisplay =
          typeof obj.display === 'string'
            ? obj.display
            : typeof obj.prompt === 'string'
              ? obj.prompt
              : null
        const displayPreview = rawDisplay
          ? cleanConversationTitle(rawDisplay.replace(/<[^>]+>/g, ' '))
          : null
        if (tsMs > 0) {
          historyEntries.push({
            timestampMs: tsMs,
            workspacePath: wsPath,
            conversationId: convId,
            displayPreview
          })
        }
      }
    } catch {
      // Ignore unreadable history.jsonl
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Ignore
        }
      }
    }
  }

  historyEntries.sort((a, b) => b.timestampMs - a.timestampMs)
  if (historyEntries.length > 200) {
    historyEntries.length = 200
  }

  return { summaries, historyByConvId, historyEntries }
}

/**
 * Reads Orca's `agent-session-journal.db`, `profile-state.db` tab headers, and local Antigravity
 * `conversation_summaries.db` / `history.jsonl` strictly in `readOnly: true` mode.
 */
export function readOrcaJournalIndex(
  orcaDirs = defaultOrcaAppDataDirs(),
  homeDir = os.homedir(),
  extraKnownPaths?: Iterable<string>
): JournalIndex {
  const byNativeId = new Map<string, JournalSessionMeta>()
  const byOrcaSessionId = new Map<string, JournalSessionMeta>()
  const workspaceActivityMs = new Map<string, number>()
  const ptyCustomTitles = new Map<string, string>()
  const terminalTabOverrides: TerminalTabTitleOverride[] = []
  const terminalTabs: TerminalTabMeta[] = []
  const cliConfiguredModels = readLocalCliConfiguredModels(homeDir, orcaDirs)
  const accountHomes = new Map<AgentKind, Set<string>>([
    ['claude', new Set()],
    ['codex', new Set()],
    ['antigravity', new Set()],
    ['gemini', new Set()]
  ])

  const DatabaseSyncCtor = loadSqliteConstructor()
  if (!DatabaseSyncCtor) {
    const agDirs = collectAntigravityDataDirs(
      homeDir,
      orcaDirs,
      accountHomes.get('antigravity')!
    )
    const agMeta = readAntigravityMetadata(agDirs, null, new Set())
    return {
      byNativeId,
      byOrcaSessionId,
      accountHomes,
      workspaceActivityMs,
      ptyCustomTitles,
      terminalTabOverrides,
      terminalTabs,
      antigravitySummaries: agMeta.summaries,
      antigravityHistoryByConversationId: agMeta.historyByConvId,
      antigravityHistoryEntries: agMeta.historyEntries,
      cliConfiguredModels
    }
  }

  for (const orcaDir of orcaDirs) {
    const dbPath = path.join(orcaDir, 'agent-session-journal.db')
    if (fs.existsSync(dbPath)) {
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 500 })
        const rows = db
          .prepare('SELECT session_id, record_json FROM agent_session_records')
          .all() as Array<{ session_id?: string; record_json?: string }>

        for (const row of rows) {
          if (!row?.record_json || !row.session_id) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(row.record_json) as Record<string, unknown>
          } catch {
            continue
          }

          const agent = mapProviderToAgent(parsed.provider)
          if (!agent) continue

          const accHome = parsed.accountHome as { path?: unknown } | undefined
          if (accHome && typeof accHome.path === 'string' && accHome.path.trim()) {
            accountHomes.get(agent)?.add(accHome.path.trim())
          }

          const loc = parsed.location as { workspaceId?: unknown } | undefined
          const launchDir =
            typeof parsed.launchDirectory === 'string' ? parsed.launchDirectory.trim() : null
          const workspacePath = extractWorkspacePathFromId(loc?.workspaceId) || launchDir || null
          const opts = parsed.options as { model?: unknown } | undefined
          const model = normalizeConfiguredModelSlug(opts?.model)
          const title = cleanConversationTitle(parsed.conversationName)
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0

          const lease = parsed.lease as
            | { claimStatus?: unknown; lastRenewedAt?: unknown }
            | null
            | undefined
          const isLiveLease = lease?.claimStatus === 'live'
          const renewedAt = typeof lease?.lastRenewedAt === 'number' ? lease.lastRenewedAt : 0

          const lastTurn = parsed.lastTurn as { state?: unknown; at?: unknown } | null | undefined
          const rawTurnState =
            typeof lastTurn?.state === 'string' ? lastTurn.state.toLowerCase().trim() : ''
          const lastTurnState: 'open' | 'settled' | null =
            rawTurnState === 'open' ? 'open' : rawTurnState === 'settled' ? 'settled' : null
          const isTurnOpen = lastTurnState === 'open'
          const turnAt = typeof lastTurn?.at === 'number' ? lastTurn.at : 0
          const turnUpdatedAt = turnAt > 0 ? turnAt : isTurnOpen ? updatedAt : 0

          const effectiveActivity = Math.max(updatedAt, renewedAt, turnAt)
          if (workspacePath && effectiveActivity > 0) {
            const score =
              effectiveActivity + (isTurnOpen ? 10_000_000 : isLiveLease ? 1_000_000 : 0)
            const prevScore = workspaceActivityMs.get(workspacePath) ?? 0
            if (score > prevScore) {
              workspaceActivityMs.set(workspacePath, score)
            }
          }

          const chain = Array.isArray(parsed.providerHandleChain) ? parsed.providerHandleChain : []
          const nativeIds = new Set<string>()
          for (const item of chain) {
            if (!item || typeof item !== 'object') continue
            const handle = (item as { handle?: Record<string, unknown> }).handle
            if (!handle || typeof handle !== 'object') continue
            for (const key of ['sessionId', 'threadId', 'nativeId', 'id']) {
              const val = handle[key]
              if (typeof val === 'string' && val.trim()) {
                nativeIds.add(val.trim())
              }
            }
          }

          const baseMeta: JournalSessionMeta = {
            orcaSessionId: row.session_id,
            nativeId: Array.from(nativeIds)[0] ?? row.session_id,
            provider: agent,
            title,
            workspacePath,
            model,
            updatedAt: Math.max(updatedAt, renewedAt),
            turnUpdatedAt,
            isLiveLease,
            isTurnOpen,
            lastTurnState
          }
          byOrcaSessionId.set(row.session_id, baseMeta)

          for (const nativeId of nativeIds) {
            const existing = byNativeId.get(nativeId)
            if (!existing || baseMeta.updatedAt >= existing.updatedAt) {
              byNativeId.set(nativeId, {
                ...baseMeta,
                nativeId,
                title: title || existing?.title || null,
                workspacePath: workspacePath || existing?.workspacePath || null,
                model: model || existing?.model || null
              })
            }
          }
        }
      } catch {
        // Ignore locked/corrupt DB and continue
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close errors
        }
      }
    }

    // Read user-visible tab headers (`tabsByWorktree` + `unifiedTabs`) from `profile-state.db`
    for (const profileDbPath of listCandidateProfileStateDbs(orcaDir)) {
      if (!fs.existsSync(profileDbPath)) continue
      let pDb: SqliteReadOnlyDb | null = null
      try {
        pDb = new DatabaseSyncCtor(profileDbPath, { readOnly: true, timeout: 300 })
        const tabRows = pDb
          .prepare(
            "SELECT part_key, payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND (part_key LIKE '[\"tabsByWorktree\",%' OR part_key LIKE '[\"unifiedTabs\",%')"
          )
          .all() as Array<{ part_key?: string; payload?: string }>

        type UnifiedTerminalItem = {
          id: string
          entityId: string
          worktreeId: string
          customLabel: string | null
          generatedLabel: string | null
          label: string | null
          lastFocusedAt: number
          isExplicitTerminal: boolean
        }
        const unifiedTerminalMeta = new Map<string, UnifiedTerminalItem>()
        const unifiedTerminalByEntity = new Map<string, UnifiedTerminalItem>()
        const rawWorktreeTerminalTabs: Array<Record<string, unknown>> = []

        for (const r of tabRows) {
          if (!r?.part_key || !r.payload) continue
          let arr: unknown
          try {
            arr = JSON.parse(r.payload)
          } catch {
            continue
          }
          if (!Array.isArray(arr)) continue

          if (r.part_key.startsWith('["unifiedTabs",')) {
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue
              const u = item as Record<string, unknown>
              const id = typeof u.id === 'string' ? u.id.trim() : ''
              const contentType =
                typeof u.contentType === 'string' ? u.contentType.trim() : undefined
              const customLabel = cleanConversationTitle(u.customLabel)
              const generatedLabel = sanitizeTerminalGeneratedTitle(u.generatedLabel)
              const label = cleanConversationTitle(u.label)
              const lastFocusedAt = typeof u.lastFocusedAt === 'number' ? u.lastFocusedAt : 0

              if (
                contentType === 'agent-session' ||
                id.startsWith('structured-agent-session-')
              ) {
                const orcaSessId =
                  typeof u.entityId === 'string' && u.entityId.trim()
                    ? u.entityId.trim()
                    : id.startsWith('structured-agent-session-')
                      ? id.slice('structured-agent-session-'.length)
                      : ''
                const jEntry = orcaSessId ? byOrcaSessionId.get(orcaSessId) : undefined
                const effectiveTitle =
                  customLabel ||
                  generatedLabel ||
                  (!isGenericChatTabLabel(label) ? label : null)
                if (jEntry && effectiveTitle) {
                  if (customLabel || generatedLabel || !jEntry.title) {
                    jEntry.title = effectiveTitle
                    for (const natEntry of byNativeId.values()) {
                      if (natEntry.orcaSessionId === orcaSessId) {
                        natEntry.title = effectiveTitle
                      }
                    }
                  }
                }
              } else if (
                (contentType === 'terminal' || contentType === undefined) &&
                id
              ) {
                const entityId =
                  typeof u.entityId === 'string' && u.entityId.trim() ? u.entityId.trim() : ''
                const worktreeId =
                  typeof u.worktreeId === 'string' && u.worktreeId.trim()
                    ? u.worktreeId.trim()
                    : ''
                const meta: UnifiedTerminalItem = {
                  id,
                  entityId,
                  worktreeId,
                  customLabel,
                  generatedLabel,
                  label,
                  lastFocusedAt,
                  isExplicitTerminal: contentType === 'terminal'
                }
                unifiedTerminalMeta.set(id, meta)
                if (entityId) {
                  unifiedTerminalByEntity.set(entityId, meta)
                }
              }
            }
          } else if (r.part_key.startsWith('["tabsByWorktree",')) {
            for (const item of arr) {
              if (item && typeof item === 'object') {
                rawWorktreeTerminalTabs.push(item as Record<string, unknown>)
              }
            }
          }
        }

        const matchedUnifiedIds = new Set<string>()
        const worktreeIdToPath = new Map<string, string>()
        const registerPtyTitleKeys = (ptyId: string, tabId: string, title: string) => {
          if (ptyId) {
            ptyCustomTitles.set(ptyId, title)
            ptyCustomTitles.set(`pty:${ptyId}`, title)
          }
          if (tabId) {
            ptyCustomTitles.set(tabId, title)
          }
        }

        for (const t of rawWorktreeTerminalTabs) {
          const tabId = typeof t.id === 'string' ? t.id.trim() : ''
          const ptyId = typeof t.ptyId === 'string' ? t.ptyId.trim() : ''
          const rawWtId = typeof t.worktreeId === 'string' ? t.worktreeId.trim() : ''
          const uMeta =
            (tabId ? unifiedTerminalMeta.get(tabId) : undefined) ??
            (ptyId ? unifiedTerminalByEntity.get(ptyId) : undefined)
          if (uMeta) matchedUnifiedIds.add(uMeta.id)

          const defaultTitle = typeof t.defaultTitle === 'string' ? t.defaultTitle : null
          const customPart = cleanConversationTitle(t.customTitle) || uMeta?.customLabel || null
          const generatedPart =
            sanitizeTerminalGeneratedTitle(t.generatedTitle, defaultTitle) ||
            uMeta?.generatedLabel ||
            null
          const rawLabelCandidate = cleanConversationTitle(t.title) || uMeta?.label || null
          const nonGenericLabel =
            rawLabelCandidate && !isGenericTerminalTabLabel(rawLabelCandidate, defaultTitle)
              ? rawLabelCandidate
              : null

          const effectiveTitle = customPart ?? generatedPart ?? nonGenericLabel ?? null
          const titleSource: TerminalTabTitleSource = customPart
            ? 'custom'
            : generatedPart
              ? 'generated'
              : nonGenericLabel
                ? 'label'
                : null
          const rawTabLabel =
            uMeta?.label ||
            cleanConversationTitle(t.title) ||
            cleanConversationTitle(defaultTitle) ||
            null

          if (effectiveTitle) {
            registerPtyTitleKeys(ptyId, tabId, effectiveTitle)
          }

          const wsPath =
            extractWorkspacePathFromId(t.worktreeId) ||
            extractWorkspacePathFromId(uMeta?.worktreeId) ||
            (typeof t.startupCwd === 'string' && t.startupCwd.trim()
              ? t.startupCwd.trim()
              : null) ||
            extractWorkspacePathFromId(ptyId)
          if (wsPath && rawWtId) {
            worktreeIdToPath.set(rawWtId, wsPath)
          }
          if (!wsPath || (!ptyId && !tabId)) continue

          const agent =
            mapProviderToAgent(t.launchAgent) ??
            inferAgentFromTerminalTitle(t.title) ??
            inferAgentFromTerminalTitle(uMeta?.label)
          const createdAt = typeof t.createdAt === 'number' ? t.createdAt : 0
          const lastFocusedAt = uMeta?.lastFocusedAt ?? createdAt

          terminalTabs.push({
            ptyId: ptyId || tabId,
            tabId: tabId || ptyId,
            workspacePath: wsPath,
            agent,
            effectiveTitle,
            titleSource,
            rawTabLabel,
            createdAt,
            lastFocusedAt,
            isOpenInUnifiedTabs: uMeta !== undefined
          })

          if (effectiveTitle && ptyId) {
            terminalTabOverrides.push({
              ptyId,
              workspacePath: wsPath,
              agent,
              customTitle: effectiveTitle,
              createdAt,
              lastFocusedAt
            })
          }
        }

        // Synthesize terminal tab entries for open `unifiedTabs` terminal items not yet flushed to `tabsByWorktree`
        for (const uMeta of unifiedTerminalMeta.values()) {
          if (!uMeta.isExplicitTerminal || matchedUnifiedIds.has(uMeta.id)) continue
          const ptyId = uMeta.entityId || uMeta.id
          const tabId = uMeta.id
          const nonGenericLabel =
            uMeta.label && !isGenericTerminalTabLabel(uMeta.label) ? uMeta.label : null
          const effectiveTitle = uMeta.customLabel ?? uMeta.generatedLabel ?? nonGenericLabel ?? null
          const titleSource: TerminalTabTitleSource = uMeta.customLabel
            ? 'custom'
            : uMeta.generatedLabel
              ? 'generated'
              : nonGenericLabel
                ? 'label'
                : null
          if (effectiveTitle) {
            registerPtyTitleKeys(ptyId, tabId, effectiveTitle)
          }
          const wsPath =
            (uMeta.worktreeId ? worktreeIdToPath.get(uMeta.worktreeId) : undefined) ||
            extractWorkspacePathFromId(uMeta.worktreeId) ||
            extractWorkspacePathFromId(ptyId)
          if (!wsPath) continue
          const agent = inferAgentFromTerminalTitle(uMeta.label)
          terminalTabs.push({
            ptyId,
            tabId,
            workspacePath: wsPath,
            agent,
            effectiveTitle,
            titleSource,
            rawTabLabel: uMeta.label,
            createdAt: 0,
            lastFocusedAt: uMeta.lastFocusedAt,
            isOpenInUnifiedTabs: true
          })
          if (effectiveTitle && ptyId) {
            terminalTabOverrides.push({
              ptyId,
              workspacePath: wsPath,
              agent,
              customTitle: effectiveTitle,
              createdAt: 0,
              lastFocusedAt: uMeta.lastFocusedAt
            })
          }
        }
        break
      } catch {
        // Ignore locked profile-state.db
      } finally {
        try {
          pDb?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  const preferredNormPaths = new Set<string>()
  if (extraKnownPaths) {
    for (const kp of extraKnownPaths) {
      if (kp) preferredNormPaths.add(normalizePathForMatch(kp))
    }
  }
  for (const jm of byOrcaSessionId.values()) {
    if (jm.workspacePath) preferredNormPaths.add(normalizePathForMatch(jm.workspacePath))
  }
  for (const tt of terminalTabs) {
    if (tt.workspacePath) preferredNormPaths.add(normalizePathForMatch(tt.workspacePath))
  }
  for (const wp of workspaceActivityMs.keys()) {
    if (wp) preferredNormPaths.add(normalizePathForMatch(wp))
  }
  preferredNormPaths.delete('')

  const agDirs = collectAntigravityDataDirs(
    homeDir,
    orcaDirs,
    accountHomes.get('antigravity')!
  )
  const agMeta = readAntigravityMetadata(agDirs, DatabaseSyncCtor, preferredNormPaths)

  return {
    byNativeId,
    byOrcaSessionId,
    accountHomes,
    workspaceActivityMs,
    ptyCustomTitles,
    terminalTabOverrides,
    terminalTabs,
    antigravitySummaries: agMeta.summaries,
    antigravityHistoryByConversationId: agMeta.historyByConvId,
    antigravityHistoryEntries: agMeta.historyEntries,
    cliConfiguredModels
  }
}

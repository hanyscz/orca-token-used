import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractWorkspacePathFromId,
  inferAgentFromTerminalTitle,
  isGenericTerminalTabLabel,
  type JournalIndex,
  type TerminalTabMeta
} from './journal'
import type { ParsedTurnUsage, SessionTranscriptState, SpawnedSubagentMeta } from './parsers'
import { type PricingEngine, providerLabelForAgent } from './pricing'
import type {
  AgentKind,
  AgentRunState,
  AgentSummaryRow,
  DashboardSnapshot,
  LiveAgentCard,
  PeriodSummary,
  TimeBucket,
  TokenBreakdown,
  TpsStats,
  WorktreeSessionItem,
  OrcaLiveAgentInfo
} from './protocol'

export { type OrcaLiveAgentInfo }

export const ALL_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'gemini']

const DEFAULT_MODEL_DISPLAY: Record<AgentKind, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-6.1-sol',
  antigravity: 'gemini-3-pro',
  gemini: 'gemini-2.5-pro'
}

export interface KnownOrcaWorkspace {
  id: string
  project: string
  name: string
  path: string
  branch: string | null
}

export interface WorkspaceRuntimeContext {
  focusedId?: string | null
  focusedProject?: string | null
  focusedName: string | null
  focusedBranch: string | null
  focusedPath: string | null
  knownWorkspaces?: KnownOrcaWorkspace[]
  liveAgents: OrcaLiveAgentInfo[]
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    costUsd: 0
  }
}

export function emptyTpsStats(): TpsStats {
  return {
    liveTps: 0,
    avgTps: 0,
    peakTps: 0
  }
}

export function stripGitRefPrefix(branch: string | null | undefined): string | null {
  if (!branch) return null
  const trimmed = branch.trim()
  if (!trimmed) return null
  return trimmed.replace(/^refs\/heads\//, '')
}

const realpathCache = new Map<string, string>()

export function normalizeFsPath(p: string | null | undefined): string | null {
  if (!p) return null
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return null
  const cached = realpathCache.get(trimmed)
  if (cached) return cached
  let resolved: string
  try {
    resolved = fs.realpathSync.native(trimmed)
  } catch {
    try {
      resolved = fs.realpathSync(trimmed)
    } catch {
      resolved = path.resolve(trimmed)
    }
  }
  if (realpathCache.size > 2000) realpathCache.clear()
  realpathCache.set(trimmed, resolved)
  return resolved
}

export function isSameOrChildWorktreePath(
  sessionPath: string | null | undefined,
  worktreePath: string | null | undefined
): boolean {
  const sNorm = normalizeFsPath(sessionPath)
  const wNorm = normalizeFsPath(worktreePath)
  if (!sNorm || !wNorm) return false
  if (sNorm === wNorm) return true
  return sNorm.startsWith(wNorm + path.sep)
}

interface EnrichedSession {
  state: SessionTranscriptState
  isSubagent: boolean
  title: string
  matchedTab?: TerminalTabMeta
  projectName: string | null
  workspacePath: string | null
  workspaceName: string
  modelLabel: string
  reasoningLevels: string[]
  providerLabel: string
  tokens: TokenBreakdown
  tps: TpsStats
  sparkline: number[]
}

function mapOrcaAgentKind(raw: string | null | undefined): AgentKind | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('claude')) return 'claude'
  if (s.includes('codex')) return 'codex'
  if (s.includes('antigravity')) return 'antigravity'
  if (s.includes('gemini')) return 'gemini'
  return null
}

function parentSessionKey(agent: AgentKind, parentId: string | null): string | null {
  const value = parentId?.trim() ?? ''
  if (!value) return null
  return value.includes(':') ? value : `${agent}:${value}`
}

function computeTurnSummary(
  agent: AgentKind,
  turns: Iterable<ParsedTurnUsage>,
  pricing: PricingEngine,
  fallbackModel: string | null
): { tokens: TokenBreakdown; tps: TpsStats; sparkline: number[]; topModel: string } {
  const tokens = emptyTokenBreakdown()
  let weightedGenTokens = 0
  let weightedDurSec = 0
  let peakTps = 0
  let latestTps = 0
  let latestTs = 0
  const sparkPoints: Array<{ ts: number; tps: number }> = []
  const modelCounts = new Map<string, number>()

  for (const t of turns) {
    tokens.input += t.input
    tokens.output += t.output
    tokens.reasoning += t.reasoning
    tokens.cacheRead += t.cacheRead
    tokens.cacheWrite += t.cacheWrite
    tokens.total += t.total

    const turnModel = t.model || fallbackModel
    if (turnModel) {
      modelCounts.set(turnModel, (modelCounts.get(turnModel) ?? 0) + t.total)
    }

    tokens.costUsd += pricing.computeCostUsd(
      agent,
      turnModel,
      {
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite
      },
      t.explicitCostUsd
    )

    if (t.tps !== null && t.durationSec !== null && t.tps > 0) {
      weightedGenTokens += t.output + t.reasoning
      weightedDurSec += t.durationSec
      if (t.tps > peakTps) peakTps = t.tps
      if (t.timestampMs >= latestTs) {
        latestTs = t.timestampMs
        latestTps = t.tps
      }
      sparkPoints.push({ ts: t.timestampMs, tps: t.tps })
    }
  }

  sparkPoints.sort((a, b) => a.ts - b.ts)
  const sparkline = sparkPoints.slice(-16).map((p) => +p.tps.toFixed(1))

  const avgTps = weightedDurSec > 0 ? +(weightedGenTokens / weightedDurSec).toFixed(1) : 0
  let topModel = fallbackModel || DEFAULT_MODEL_DISPLAY[agent]
  let bestCount = -1
  for (const [m, cnt] of modelCounts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt
      topModel = m
    }
  }

  return {
    tokens: {
      ...tokens,
      costUsd: +tokens.costUsd.toFixed(6)
    },
    tps: {
      liveTps: +(latestTps || avgTps).toFixed(1),
      avgTps,
      peakTps: +peakTps.toFixed(1)
    },
    sparkline,
    topModel
  }
}

interface IndexedWorkspace extends KnownOrcaWorkspace {
  normPath: string
}

function indexKnownWorkspaces(known: KnownOrcaWorkspace[]): IndexedWorkspace[] {
  const seen = new Set<string>()
  const out: IndexedWorkspace[] = []
  for (const w of known) {
    const normPath = normalizeFsPath(w.path)
    if (!normPath || seen.has(normPath)) continue
    seen.add(normPath)
    out.push({
      ...w,
      project: w.project?.trim() || path.basename(normPath),
      name: w.name?.trim() || path.basename(normPath),
      branch: stripGitRefPrefix(w.branch),
      normPath
    })
  }
  out.sort((a, b) => b.normPath.length - a.normPath.length)
  return out
}

function resolveProjectAndWorktree(
  sessionPath: string | null,
  indexedWorkspaces: IndexedWorkspace[],
  homeNorm: string | null
): { projectName: string | null; workspaceName: string } {
  if (!sessionPath) {
    return { projectName: null, workspaceName: 'local' }
  }
  const sNorm = normalizeFsPath(sessionPath)
  if (sNorm) {
    for (const w of indexedWorkspaces) {
      if (sNorm === w.normPath || sNorm.startsWith(w.normPath + path.sep)) {
        return {
          projectName: w.project,
          workspaceName: w.name
        }
      }
    }
  }

  const base = path.basename(sNorm || sessionPath) || 'local'
  const parentDir = path.dirname(sNorm || sessionPath)
  const parentBase = path.basename(parentDir)
  const ignoredParents = new Set(['', '/', 'Users', 'home', 'var', 'tmp', 'private'])
  const isHomeDir = homeNorm && parentDir === homeNorm
  const projectName =
    !isHomeDir && parentBase && !ignoredParents.has(parentBase) ? parentBase : null

  return { projectName, workspaceName: base }
}

function getEffectiveTerminalTabs(journal: JournalIndex): TerminalTabMeta[] {
  if (journal.terminalTabs && journal.terminalTabs.length > 0) {
    return journal.terminalTabs
  }
  return (journal.terminalTabOverrides ?? []).map((ov) => ({
    ptyId: ov.ptyId,
    tabId: ov.ptyId,
    workspacePath: ov.workspacePath,
    agent: ov.agent,
    effectiveTitle: ov.customTitle,
    titleSource: 'custom',
    rawTabLabel: null,
    createdAt: ov.createdAt,
    lastFocusedAt: ov.lastFocusedAt,
    isOpenInUnifiedTabs: true
  }))
}

function findTerminalTabById(
  tabs: TerminalTabMeta[],
  terminalId: string | null | undefined,
  tabId?: string | null
): TerminalTabMeta | undefined {
  const cleanTabId = tabId?.trim()
  if (cleanTabId) {
    const tabMatch = tabs.find((t) => t.tabId === cleanTabId)
    if (tabMatch) return tabMatch
  }
  if (!terminalId) return undefined
  return tabs.find(
    (t) =>
      t.ptyId === terminalId ||
      t.tabId === terminalId ||
      `pty:${t.ptyId}` === terminalId ||
      (terminalId.startsWith('pty:') && t.ptyId === terminalId.slice(4))
  )
}

function lookupPtyCustomTitle(
  journal: JournalIndex,
  terminalId: string | null | undefined
): string | undefined {
  if (!terminalId || !journal.ptyCustomTitles) return undefined
  const direct = journal.ptyCustomTitles.get(terminalId)
  if (direct) return direct
  if (terminalId.startsWith('pty:')) {
    return journal.ptyCustomTitles.get(terminalId.slice(4))
  }
  return journal.ptyCustomTitles.get(`pty:${terminalId}`)
}

function matchTerminalTabsToCliSessions(
  dedupedStates: Iterable<SessionTranscriptState>,
  journal: JournalIndex,
  hasJournalRecords: boolean
): Map<string, TerminalTabMeta> {
  const tabBySessionKey = new Map<string, TerminalTabMeta>()
  const tabs = getEffectiveTerminalTabs(journal)
  if (tabs.length === 0) return tabBySessionKey

  const candidates = Array.from(dedupedStates).filter((st) => {
    if (st.isSubagent || st.turnsByKey.size <= 0) return false
    if (
      st.agent === 'antigravity' &&
      st.filePath.includes('antigravity-acp') &&
      hasJournalRecords
    ) {
      return false
    }
    const jMeta = journal.byNativeId.get(st.sessionId)
    if (jMeta) {
      if (jMeta.isLiveLease || jMeta.isTurnOpen) return false
      if (st.filePath.includes('antigravity-acp')) return false
    }
    return true
  })
  if (candidates.length === 0) return tabBySessionKey

  let maxCandidateUpdatedMs = 0
  for (const st of candidates) {
    if (st.updatedAtMs > maxCandidateUpdatedMs) maxCandidateUpdatedMs = st.updatedAtMs
  }

  type PairCandidate = {
    tabIdx: number
    tab: TerminalTabMeta
    st: SessionTranscriptState
    sKey: string
    isStandaloneCli: boolean
    ownsInterval: boolean
    isOccupying: boolean
  }
  const pairs: PairCandidate[] = []

  for (let tabIdx = 0; tabIdx < tabs.length; tabIdx++) {
    const tab = tabs[tabIdx]
    for (const st of candidates) {
      if (tab.agent && st.agent !== tab.agent) continue
      const jMeta = journal.byNativeId.get(st.sessionId)
      const sessWs = jMeta?.workspacePath || st.cwd
      if (!isSameOrChildWorktreePath(sessWs, tab.workspacePath)) continue
      if (jMeta && !(tab.createdAt > 0 && st.updatedAtMs >= tab.createdAt)) continue
      if (
        tab.createdAt > 0 &&
        st.createdAtMs < tab.createdAt - 15_000 &&
        st.updatedAtMs < tab.createdAt
      ) {
        continue
      }

      const spawnedAfterTab = tab.createdAt > 0 && st.createdAtMs >= tab.createdAt - 15_000
      let hasNewerCompatibleTabBeforeSpawn = false
      if (spawnedAfterTab) {
        const tabOpenRank = tab.isOpenInUnifiedTabs ? 1 : 0
        for (let j = 0; j < tabs.length; j++) {
          if (j === tabIdx) continue
          const other = tabs[j]
          if ((other.isOpenInUnifiedTabs ? 1 : 0) < tabOpenRank) continue
          if (other.agent && other.agent !== st.agent) continue
          if (!isSameOrChildWorktreePath(sessWs, other.workspacePath)) continue
          if (other.createdAt > tab.createdAt && other.createdAt <= st.createdAtMs + 2_000) {
            hasNewerCompatibleTabBeforeSpawn = true
            break
          }
        }
      }

      const isOccupying =
        (st.lastEventState === 'working' || st.lastEventState === 'waiting') &&
        maxCandidateUpdatedMs - st.updatedAtMs <= 90_000

      pairs.push({
        tabIdx,
        tab,
        st,
        sKey: `${st.agent}:${st.sessionId}`,
        isStandaloneCli: jMeta === undefined,
        ownsInterval: spawnedAfterTab && !hasNewerCompatibleTabBeforeSpawn,
        isOccupying
      })
    }
  }

  pairs.sort((a, b) => {
    const openDiff = (b.tab.isOpenInUnifiedTabs ? 1 : 0) - (a.tab.isOpenInUnifiedTabs ? 1 : 0)
    if (openDiff !== 0) return openDiff
    const cliDiff = (b.isStandaloneCli ? 1 : 0) - (a.isStandaloneCli ? 1 : 0)
    if (cliDiff !== 0) return cliDiff
    const intervalDiff = (b.ownsInterval ? 1 : 0) - (a.ownsInterval ? 1 : 0)
    if (intervalDiff !== 0) return intervalDiff
    const titledDiff = (b.tab.effectiveTitle !== null ? 1 : 0) - (a.tab.effectiveTitle !== null ? 1 : 0)
    if (titledDiff !== 0) return titledDiff
    const occDiff = (b.isOccupying ? 1 : 0) - (a.isOccupying ? 1 : 0)
    if (occDiff !== 0) return occDiff

    const aDist = Math.abs(a.st.createdAtMs - a.tab.createdAt)
    const bDist = Math.abs(b.st.createdAtMs - b.tab.createdAt)
    // Concurrent active sessions cannot share one PTY sequentially: prefer spawn proximity to tab
    if (a.isOccupying && b.isOccupying && aDist !== bDist) {
      return aDist - bDist
    }
    if (b.st.updatedAtMs !== a.st.updatedAtMs) return b.st.updatedAtMs - a.st.updatedAtMs
    if (aDist !== bDist) return aDist - bDist
    return b.tab.lastFocusedAt - a.tab.lastFocusedAt
  })

  const claimedTabs = new Set<number>()
  const claimedSessions = new Set<string>()
  for (const p of pairs) {
    if (claimedTabs.has(p.tabIdx) || claimedSessions.has(p.sKey)) continue
    claimedTabs.add(p.tabIdx)
    claimedSessions.add(p.sKey)
    tabBySessionKey.set(p.sKey, p.tab)
  }

  return tabBySessionKey
}

interface SpawnedSubagentIndex {
  byParentAndAgentId: Map<string, Map<string, SpawnedSubagentMeta>>
  fallbackByAgentId: Map<string, { updatedAtMs: number; meta: SpawnedSubagentMeta }>
}

/**
 * Indexes parent `Task`/`Agent` subagent spawn metadata by `(agent:parentSessionId, agentId)`
 * and maintains an `agent:agentId` fallback map for child transcripts missing `parentSessionId`.
 */
function indexSpawnedSubagents(sessions: Iterable<SessionTranscriptState>): SpawnedSubagentIndex {
  const byParentAndAgentId = new Map<string, Map<string, SpawnedSubagentMeta>>()
  const fallbackByAgentId = new Map<string, { updatedAtMs: number; meta: SpawnedSubagentMeta }>()

  for (const st of sessions) {
    if (st.isInternalHelper || !st.spawnedSubagentsByAgentId) continue
    const entries = Object.entries(st.spawnedSubagentsByAgentId)
    if (entries.length === 0) continue

    const pKey = `${st.agent}:${st.sessionId}`
    let byAgentId = byParentAndAgentId.get(pKey)
    if (!byAgentId) {
      byAgentId = new Map<string, SpawnedSubagentMeta>()
      byParentAndAgentId.set(pKey, byAgentId)
    }

    for (const [rawAgentId, meta] of entries) {
      const agentId = rawAgentId.trim()
      if (!agentId || !meta) continue
      const prev = byAgentId.get(agentId)
      const merged: SpawnedSubagentMeta = prev
        ? {
            name: meta.name ?? prev.name,
            role: meta.role ?? prev.role,
            description: meta.description ?? prev.description
          }
        : meta
      byAgentId.set(agentId, merged)

      const fallbackKey = `${st.agent}:${agentId}`
      const existingFallback = fallbackByAgentId.get(fallbackKey)
      if (!existingFallback || st.updatedAtMs >= existingFallback.updatedAtMs) {
        fallbackByAgentId.set(fallbackKey, { updatedAtMs: st.updatedAtMs, meta: merged })
      }
    }
  }

  return { byParentAndAgentId, fallbackByAgentId }
}

function lookupSpawnedSubagentMeta(
  st: SessionTranscriptState,
  index: SpawnedSubagentIndex
): SpawnedSubagentMeta | undefined {
  const rawSubagentId = st.subagentId?.trim() || null
  const strippedSessionId = st.sessionId.startsWith('agent-')
    ? st.sessionId.slice('agent-'.length).trim()
    : null
  const candidates = [rawSubagentId, strippedSessionId, st.sessionId.trim()].filter(
    (v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx
  )
  if (candidates.length === 0) return undefined

  const pKey = parentSessionKey(st.agent, st.parentSessionId)
  if (pKey) {
    const byAgentId = index.byParentAndAgentId.get(pKey)
    if (!byAgentId) return undefined
    for (const agentId of candidates) {
      const hit = byAgentId.get(agentId)
      if (hit) return hit
    }
    return undefined
  }

  for (const agentId of candidates) {
    const hit = index.fallbackByAgentId.get(`${st.agent}:${agentId}`)
    if (hit) return hit.meta
  }
  return undefined
}

function formatSpawnedSubagentTitle(meta: SpawnedSubagentMeta | undefined): string | null {
  if (!meta) return null
  const description = meta.description?.trim() || null
  const rawRole = meta.role?.trim() || null
  const role = rawRole && rawRole.toLowerCase() !== 'default' ? rawRole : null
  const name = meta.name?.trim() || null

  if (description) {
    return role && !description.toLowerCase().startsWith(role.toLowerCase())
      ? `${role}: ${description}`
      : description
  }
  return name || role || null
}

function formatLocalSubagentTitle(st: SessionTranscriptState): string | null {
  const rawRole = st.subagentRole?.trim() || null
  const role = rawRole && rawRole.toLowerCase() !== 'default' ? rawRole : null
  const name = st.subagentName?.trim() || null
  if (role && name && role.toLowerCase() !== name.toLowerCase()) {
    return `${role} · ${name}`
  }
  return role || name || null
}

function enrichSessions(
  sessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  indexedWorkspaces: IndexedWorkspace[],
  parentContextSessions: Iterable<SessionTranscriptState> = sessions
): EnrichedSession[] {
  const homeNorm = normalizeFsPath(os.homedir())
  const spawnedSubagentIndex = indexSpawnedSubagents(parentContextSessions)

  // Deduplicate by `${agent}:${sessionId}` so archived or multi-home copies never double-count
  const dedupedStates = new Map<string, SessionTranscriptState>()
  for (const st of sessions) {
    if (st.isInternalHelper) continue
    const key = `${st.agent}:${st.sessionId}`
    const prev = dedupedStates.get(key)
    if (
      !prev ||
      st.turnsByKey.size > prev.turnsByKey.size ||
      (st.turnsByKey.size === prev.turnsByKey.size && st.updatedAtMs > prev.updatedAtMs)
    ) {
      dedupedStates.set(key, st)
    }
  }

  const hasJournalRecords = journal.byNativeId.size > 0
  const tabBySessionKey = matchTerminalTabsToCliSessions(
    dedupedStates.values(),
    journal,
    hasJournalRecords
  )

  const out: EnrichedSession[] = []

  for (const st of dedupedStates.values()) {
    const jMeta = journal.byNativeId.get(st.sessionId)
    const workspacePath = jMeta?.workspacePath || st.cwd || null
    const { projectName, workspaceName } = resolveProjectAndWorktree(
      workspacePath,
      indexedWorkspaces,
      homeNorm
    )
    const fallbackModel =
      jMeta?.model ||
      st.latestModel ||
      journal.cliConfiguredModels?.[st.agent] ||
      DEFAULT_MODEL_DISPLAY[st.agent]
    const summary = computeTurnSummary(st.agent, st.turnsByKey.values(), pricing, fallbackModel)

    if (summary.tokens.total <= 0 && !jMeta) continue

    const agSummary =
      st.agent === 'antigravity' ? journal.antigravitySummaries?.get(st.sessionId) : undefined
    const agSummaryTitle = agSummary?.title ?? null
    const agSubagentName = agSummary?.agentName?.trim() || null

    const isUnlinkedAcpSubagent =
      st.agent === 'antigravity' &&
      st.filePath.includes('antigravity-acp') &&
      hasJournalRecords &&
      !jMeta
    const isSubagent = Boolean(st.isSubagent || isUnlinkedAcpSubagent || agSummary?.isSubagent)

    const sKey = `${st.agent}:${st.sessionId}`
    const matchedTab = tabBySessionKey.get(sKey)
    const baseTitle = matchedTab?.effectiveTitle || st.cliCustomTitle || jMeta?.title || null
    const fallbackIdTitle = `${providerLabelForAgent(st.agent, summary.topModel)} · ${st.sessionId.slice(0, 8)}`
    const title = isSubagent
      ? baseTitle ||
        agSummaryTitle ||
        agSubagentName ||
        formatSpawnedSubagentTitle(lookupSpawnedSubagentMeta(st, spawnedSubagentIndex)) ||
        formatLocalSubagentTitle(st) ||
        st.titleHint ||
        fallbackIdTitle
      : baseTitle ||
        agSummaryTitle ||
        st.titleHint ||
        fallbackIdTitle

    // Prefer Orca's journal model when present, otherwise use the session's latest active model
    // so mid-session `/model` switches are reflected immediately instead of sticking to an earlier
    // higher-token model (`summary.topModel`).
    const modelLabel = jMeta?.model || st.latestModel || summary.topModel || fallbackModel
    const providerLabel = providerLabelForAgent(st.agent, modelLabel)

    out.push({
      state: st,
      isSubagent,
      title,
      matchedTab,
      projectName,
      workspacePath,
      workspaceName,
      modelLabel,
      reasoningLevels: st.reasoningLevels,
      providerLabel,
      tokens: summary.tokens,
      tps: summary.tps,
      sparkline: summary.sparkline
    })
  }
  return out
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

function buildDayBuckets(now: number): TimeBucket[] {
  const dayStart = startOfLocalDay(now)
  const buckets: TimeBucket[] = []
  for (let h = 0; h < 24; h++) {
    const start = new Date(dayStart)
    start.setHours(h, 0, 0, 0)
    const end = new Date(dayStart)
    end.setHours(h + 1, 0, 0, 0)
    buckets.push({
      key: `h-${h}`,
      label: `${String(h).padStart(2, '0')}:00`,
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalTokens: 0,
      costUsd: 0,
      byAgent: { claude: 0, codex: 0, antigravity: 0, gemini: 0 }
    })
  }
  return buckets
}

function buildMultiDayBuckets(now: number, days: number): TimeBucket[] {
  const todayStart = startOfLocalDay(now)
  const buckets: TimeBucket[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = new Date(todayStart)
    start.setDate(start.getDate() - offset)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    const mm = String(start.getMonth() + 1).padStart(2, '0')
    const dd = String(start.getDate()).padStart(2, '0')
    buckets.push({
      key: `${start.getFullYear()}-${mm}-${dd}`,
      label: `${mm}/${dd}`,
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalTokens: 0,
      costUsd: 0,
      byAgent: { claude: 0, codex: 0, antigravity: 0, gemini: 0 }
    })
  }
  return buckets
}

function aggregatePeriod(
  enriched: EnrichedSession[],
  buckets: TimeBucket[],
  prevStartMs: number,
  prevEndMs: number,
  pricing: PricingEngine
): PeriodSummary {
  if (buckets.length === 0) {
    return {
      tokens: emptyTokenBreakdown(),
      tps: emptyTpsStats(),
      previousTotalTokens: null,
      deltaPercent: null,
      buckets: [],
      byAgent: []
    }
  }

  const rangeStartMs = buckets[0].startMs
  const rangeEndMs = buckets[buckets.length - 1].endMs

  const totalTokens = emptyTokenBreakdown()
  let prevTotalTokens = 0

  let totalGenOut = 0
  let totalDurSec = 0
  let peakTps = 0
  let latestTps = 0
  let latestTs = 0

  const perAgentTurns: Record<AgentKind, ParsedTurnUsage[]> = {
    claude: [],
    codex: [],
    antigravity: [],
    gemini: []
  }
  const perAgentFallbackModel: Record<AgentKind, string> = { ...DEFAULT_MODEL_DISPLAY }

  for (const session of enriched) {
    const agent = session.state.agent
    if (session.modelLabel) {
      perAgentFallbackModel[agent] = session.modelLabel
    }

    for (const turn of session.state.turnsByKey.values()) {
      const ts = turn.timestampMs
      if (ts >= prevStartMs && ts < prevEndMs) {
        prevTotalTokens += turn.total
      }
      if (ts < rangeStartMs || ts >= rangeEndMs) {
        continue
      }

      const resolvedTurnModel = turn.model || session.modelLabel
      const turnCost = pricing.computeCostUsd(
        agent,
        resolvedTurnModel,
        {
          input: turn.input,
          output: turn.output,
          reasoning: turn.reasoning,
          cacheRead: turn.cacheRead,
          cacheWrite: turn.cacheWrite
        },
        turn.explicitCostUsd
      )

      totalTokens.input += turn.input
      totalTokens.output += turn.output
      totalTokens.reasoning += turn.reasoning
      totalTokens.cacheRead += turn.cacheRead
      totalTokens.cacheWrite += turn.cacheWrite
      totalTokens.total += turn.total
      totalTokens.costUsd += turnCost

      perAgentTurns[agent].push(
        turn.model ? turn : { ...turn, model: resolvedTurnModel }
      )

      if (turn.tps !== null && turn.durationSec !== null && turn.tps > 0) {
        totalGenOut += turn.output + turn.reasoning
        totalDurSec += turn.durationSec
        if (turn.tps > peakTps) peakTps = turn.tps
        if (ts >= latestTs) {
          latestTs = ts
          latestTps = turn.tps
        }
      }

      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i]
        if (ts >= b.startMs && ts < b.endMs) {
          b.totalTokens += turn.total
          b.costUsd = +(b.costUsd + turnCost).toFixed(6)
          b.byAgent[agent] += turn.total
          break
        }
      }
    }
  }

  totalTokens.costUsd = +totalTokens.costUsd.toFixed(6)
  const avgTps = totalDurSec > 0 ? +(totalGenOut / totalDurSec).toFixed(1) : 0

  const byAgent: AgentSummaryRow[] = ALL_AGENTS.map((agent) => {
    const sub = computeTurnSummary(agent, perAgentTurns[agent], pricing, perAgentFallbackModel[agent])
    const sharePercent =
      totalTokens.total > 0 ? +((sub.tokens.total / totalTokens.total) * 100).toFixed(1) : 0
    return {
      agent,
      providerLabel: providerLabelForAgent(agent, sub.topModel),
      sharePercent,
      tokens: sub.tokens,
      tps: sub.tps,
      topModel: sub.topModel
    }
  }).sort((a, b) => b.tokens.total - a.tokens.total)

  const deltaPercent =
    prevTotalTokens > 0
      ? +(((totalTokens.total - prevTotalTokens) / prevTotalTokens) * 100).toFixed(1)
      : null

  return {
    tokens: totalTokens,
    tps: {
      liveTps: +(latestTps || avgTps).toFixed(1),
      avgTps,
      peakTps: +peakTps.toFixed(1)
    },
    previousTotalTokens: prevTotalTokens > 0 ? prevTotalTokens : null,
    deltaPercent,
    buckets,
    byAgent
  }
}

export function buildDashboardSnapshot(
  rawSessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  runtime: WorkspaceRuntimeContext,
  now = Date.now()
): DashboardSnapshot {
  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const enrichedAll = enrichSessions(rawSessions, journal, pricing, indexedWorkspaces)
  const userSessions = enrichedAll.filter((s) => !s.isSubagent)

  const focusedPathNorm = normalizeFsPath(runtime.focusedPath)
  const matchedFocusedWs =
    (runtime.focusedId
      ? indexedWorkspaces.find((w) => w.id === runtime.focusedId)
      : undefined) ??
    (focusedPathNorm
      ? indexedWorkspaces.find(
          (w) => focusedPathNorm === w.normPath || focusedPathNorm.startsWith(w.normPath + path.sep)
        )
      : undefined)

  const effectivePathNorm = matchedFocusedWs?.normPath ?? focusedPathNorm
  const effectiveProject =
    matchedFocusedWs?.project ||
    runtime.focusedProject ||
    (effectivePathNorm
      ? resolveProjectAndWorktree(effectivePathNorm, indexedWorkspaces, null).projectName
      : null)

  const effectiveName =
    matchedFocusedWs?.name ??
    runtime.focusedName ??
    (effectivePathNorm ? path.basename(effectivePathNorm) : null)

  const effectiveBranch = stripGitRefPrefix(matchedFocusedWs?.branch ?? runtime.focusedBranch)

  // 1. Focused Project + Worktree conversations (sorted newest to oldest, excluding subagent brains)
  const worktreeUserSessions = effectivePathNorm
    ? userSessions.filter((s) => isSameOrChildWorktreePath(s.workspacePath, effectivePathNorm))
    : userSessions

  // Focused Project + Worktree ALL sessions (including subagents) for accurate Day/Week/Month worktree spend
  const worktreeAllSessions = effectivePathNorm
    ? enrichedAll.filter((s) => isSameOrChildWorktreePath(s.workspacePath, effectivePathNorm))
    : enrichedAll

  const ptyBySessionKey = matchPtyTerminalsToSessions(
    userSessions,
    journal,
    runtime.liveAgents,
    now,
    enrichedAll
  )

  const sessionsList: WorktreeSessionItem[] = [...worktreeUserSessions]
    .sort((a, b) => b.state.updatedAtMs - a.state.updatedAtMs)
    .slice(0, 80)
    .map((s) => {
      const sKey = `${s.state.agent}:${s.state.sessionId}`
      const jMeta = journal.byNativeId.get(s.state.sessionId)
      const matchedPty = ptyBySessionKey.get(sKey)
      let runState = resolveSessionRunState(
        s.state,
        jMeta,
        matchedPty?.state ?? null,
        now,
        matchedPty?.stateStartedAt ?? 0
      )
      if (
        runState === 'done' &&
        hasActiveChildSubagent(s.state.agent, s.state.sessionId, enrichedAll, journal, now)
      ) {
        runState = 'waiting'
      }
      const active = runState === 'working' || runState === 'waiting' || runState === 'blocked'
      return {
        sessionId: s.state.sessionId,
        agent: s.state.agent,
        providerLabel: s.providerLabel,
        modelLabel: s.modelLabel,
        reasoningLevels: s.reasoningLevels,
        title: s.title,
        projectName: s.projectName,
        workspaceName: s.workspaceName,
        workspacePath: s.workspacePath,
        updatedAt: s.state.updatedAtMs,
        createdAt: s.state.createdAtMs,
        active,
        tps: s.tps,
        tokens: s.tokens
      }
    })

  // 2. Live running / recently active agent cards
  const allMainCards = buildLiveAgentCards({
    userSessions,
    journal,
    runtime,
    effectivePathNorm,
    effectiveProject,
    effectiveName,
    now,
    allSessions: enrichedAll
  })
  const recentCutoffMs = now - LIVE_RECENT_MS
  const allSubagentCards = buildLiveAgentCards({
    userSessions: enrichedAll.filter((s) => s.isSubagent && (
      Math.max(s.state.updatedAtMs, s.state.lastMtimeMs) >= recentCutoffMs ||
      !effectivePathNorm || isSameOrChildWorktreePath(s.workspacePath, effectivePathNorm)
    )),
    journal,
    runtime: { ...runtime, liveAgents: [] },
    effectivePathNorm,
    effectiveProject,
    effectiveName,
    now,
    allSessions: enrichedAll
  })

  // Keep the recent lists compact, but always show each producer and its parent chain.
  const allCards = [...allMainCards, ...allSubagentCards]
  const byKey = new Map(allCards.map((card) => [card.sessionKey, card]))
  const visible = new Set<LiveAgentCard>()
  const recentChildren = allSubagentCards.filter((card) =>
    card.state !== 'done' || !effectivePathNorm || isSameOrChildWorktreePath(card.workspacePath, effectivePathNorm)
  )
  for (const seed of [
    ...allMainCards.slice(0, 12),
    ...recentChildren.slice(0, 12),
    ...allCards.filter((card) => card.liveOutRate > 0)
  ]) {
    let card: LiveAgentCard | undefined = seed
    while (card && !visible.has(card)) {
      visible.add(card)
      card = card.parentSessionKey ? byKey.get(card.parentSessionKey) : undefined
    }
  }
  const liveCards = allMainCards.filter((card) => visible.has(card))
  const subagentCards = allSubagentCards.filter((card) => visible.has(card))
  const liveTpsSum = [...visible].reduce((sum, card) => sum + card.liveOutRate, 0)

  const liveTokens = emptyTokenBreakdown()
  let maxPeakTps = 0
  let fallbackAvgSum = 0
  let fallbackAvgCount = 0

  for (const c of liveCards) {
    liveTokens.input += c.tokens.input
    liveTokens.output += c.tokens.output
    liveTokens.reasoning += c.tokens.reasoning
    liveTokens.cacheRead += c.tokens.cacheRead
    liveTokens.cacheWrite += c.tokens.cacheWrite
    liveTokens.total += c.tokens.total
    liveTokens.costUsd += c.tokens.costUsd

    if (c.tps.peakTps > maxPeakTps) maxPeakTps = c.tps.peakTps
    if (c.tps.avgTps > 0) {
      fallbackAvgSum += c.tps.avgTps
      fallbackAvgCount++
    }
  }
  liveTokens.costUsd = +liveTokens.costUsd.toFixed(6)

  const avgAcrossLive = fallbackAvgCount > 0 ? +(fallbackAvgSum / fallbackAvgCount).toFixed(1) : 0

  // 3. Day / Week / Month periods for both 'all' and 'worktree' scopes
  const todayStart = startOfLocalDay(now).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const buildScopePeriods = (scopeSessions: EnrichedSession[]) => {
    const dayBuckets = buildDayBuckets(now)
    const weekBuckets = buildMultiDayBuckets(now, 7)
    const monthBuckets = buildMultiDayBuckets(now, 30)

    const weekStart = weekBuckets[0].startMs
    const monthStart = monthBuckets[0].startMs

    return {
      day: aggregatePeriod(scopeSessions, dayBuckets, yesterdayStart, todayStart, pricing),
      week: aggregatePeriod(
        scopeSessions,
        weekBuckets,
        weekStart - 7 * 86_400_000,
        weekStart,
        pricing
      ),
      month: aggregatePeriod(
        scopeSessions,
        monthBuckets,
        monthStart - 30 * 86_400_000,
        monthStart,
        pricing
      )
    }
  }

  return {
    generatedAt: now,
    workspace: {
      id: matchedFocusedWs?.id ?? runtime.focusedId ?? null,
      project: effectiveProject,
      name: effectiveName,
      branch: effectiveBranch,
      path: effectivePathNorm ?? runtime.focusedPath
    },
    pricing: pricing.getStatus(),
    live: {
      tokens: liveTokens,
      tps: {
        liveTps: +liveTpsSum.toFixed(1),
        avgTps: avgAcrossLive,
        peakTps: +maxPeakTps.toFixed(1)
      },
      agents: liveCards,
      subagents: subagentCards
    },
    sessions: sessionsList,
    periods: {
      all: buildScopePeriods(enrichedAll),
      worktree: buildScopePeriods(worktreeAllSessions)
    }
  }
}

export const LIVE_SERIES_SECONDS = 60
const LIVE_RATE_WINDOW_SECONDS = 8
const LIVE_RECENT_MS = 15 * 60_000

export function resolveSessionRunState(
  st: SessionTranscriptState,
  jMeta: import('./journal').JournalSessionMeta | undefined,
  ptyState: AgentRunState | null,
  now: number,
  ptyStateStartedAt = 0
): AgentRunState {
  if (ptyState === 'blocked') return 'blocked'
  const lastTouchMs = Math.max(st.updatedAtMs || 0, st.lastMtimeMs || 0)

  if (jMeta) {
    if (jMeta.isTurnOpen) {
      // Guard against orphaned `open` turn if transcript already recorded final DONE after turn opened
      if (
        st.lastEventState === 'done' &&
        (jMeta.turnUpdatedAt ?? 0) > 0 &&
        st.updatedAtMs > (jMeta.turnUpdatedAt ?? 0) + 2_000 &&
        now - lastTouchMs > 60_000
      ) {
        return 'done'
      }
      return st.lastEventState === 'waiting' ? 'waiting' : 'working'
    }
    if (st.lastEventState === 'done') {
      return 'done'
    }
    const journalRefMs =
      (jMeta.turnUpdatedAt ?? 0) > 0 ? (jMeta.turnUpdatedAt ?? 0) : (jMeta.updatedAt ?? 0)
    const hasNewerTranscriptActivity = journalRefMs > 0 && lastTouchMs > journalRefMs + 2_000
    if (jMeta.lastTurnState === 'settled' && !hasNewerTranscriptActivity) {
      return 'done'
    }
    if (st.lastEventState === 'waiting' && now - lastTouchMs <= 30 * 60_000) {
      return 'waiting'
    }
    if (st.lastEventState === 'working' && now - lastTouchMs <= 45_000) {
      return 'working'
    }
    return 'done'
  }

  // CLI session (non-journal)
  if (ptyState === 'working') {
    // If transcript explicitly finished (`done`) after `ptyStateStartedAt` (or has had no writes for >45s), it is already done
    if (
      st.lastEventState === 'done' &&
      ((ptyStateStartedAt > 0 && st.updatedAtMs >= ptyStateStartedAt + 500) ||
        (now - lastTouchMs > 45_000 &&
          (ptyStateStartedAt <= 0 || ptyStateStartedAt <= st.updatedAtMs + 2_000)))
    ) {
      return 'done'
    }
    return st.lastEventState === 'waiting' ? 'waiting' : 'working'
  }
  if (
    st.lastEventState === 'waiting' &&
    ptyState !== 'done' &&
    now - lastTouchMs <= 30 * 60_000
  ) {
    return 'waiting'
  }
  if (st.lastEventState === 'done') {
    return 'done'
  }
  if (ptyState === 'waiting' && (st.lastEventState === null || st.turnsByKey.size === 0)) {
    return 'waiting'
  }
  if (st.lastEventState === 'working' && now - lastTouchMs <= 90_000) {
    return 'working'
  }
  return 'done'
}

function hasActiveChildSubagent(
  parentAgent: AgentKind,
  parentSessionId: string,
  allSessions: Iterable<EnrichedSession> | undefined,
  journal: JournalIndex,
  now: number,
  cards?: LiveAgentCard[]
): boolean {
  const pKey = `${parentAgent}:${parentSessionId}`
  if (allSessions) {
    for (const sub of allSessions) {
      if (!sub.isSubagent) continue
      const rawParent = sub.state.parentSessionId?.trim() ?? ''
      if (!rawParent) continue
      const matches =
        rawParent === parentSessionId ||
        rawParent === pKey ||
        parentSessionKey(sub.state.agent, sub.state.parentSessionId) === pKey
      if (!matches) continue

      const jMeta = journal.byNativeId.get(sub.state.sessionId)
      const subState = resolveSessionRunState(sub.state, jMeta, null, now)
      if (subState === 'working' || subState === 'waiting') {
        return true
      }
    }
  }
  if (cards) {
    for (const c of cards) {
      const matches =
        c.parentSessionKey === pKey ||
        c.parentSessionKey === parentSessionId
      if (matches && (c.state === 'working' || c.state === 'waiting')) {
        return true
      }
    }
  }
  return false
}

function isRealPtyAgentEntry(la: OrcaLiveAgentInfo, hasJournalRecords: boolean): boolean {
  const tid = typeof la.terminalId === 'string' ? la.terminalId.trim() : ''
  if (!tid) {
    // Orca reports Structured Native Chat agents in `agents.list` with `terminalId: null`;
    // those are authoritatively tracked by exact UUID in Orca session records.
    return !hasJournalRecords
  }
  if (tid.startsWith('structured-agent-session-')) return false
  return true
}

function canBindPtyToCliSession(
  s: EnrichedSession,
  la: OrcaLiveAgentInfo,
  mappedKind: AgentKind | null,
  termWsPath: string | null,
  journal: JournalIndex,
  now: number,
  allSessions?: EnrichedSession[]
): boolean {
  const jMeta = journal.byNativeId.get(s.state.sessionId)
  if (jMeta) {
    if (jMeta.isLiveLease || jMeta.isTurnOpen) return false
    if (s.state.filePath.includes('antigravity-acp')) return false
  }
  if (s.state.agent === 'antigravity' && s.state.filePath.includes('antigravity-acp')) {
    return false
  }
  if (mappedKind && s.state.agent !== mappedKind) return false
  if (termWsPath) {
    if (
      !s.workspacePath ||
      (!isSameOrChildWorktreePath(s.workspacePath, termWsPath) &&
        !isSameOrChildWorktreePath(termWsPath, s.workspacePath))
    ) {
      return false
    }
  }
  const lastTouchMs = Math.max(s.state.updatedAtMs || 0, s.state.lastMtimeMs || 0)
  const hasActiveChildren = hasActiveChildSubagent(
    s.state.agent,
    s.state.sessionId,
    allSessions,
    journal,
    now
  )
  // Never bind an active `working` PTY onto an old CLI transcript that already finished >60s ago
  // unless the parent has active child subagents running
  if (
    la.state === 'working' &&
    s.state.lastEventState === 'done' &&
    !hasActiveChildren &&
    now - lastTouchMs > 60_000
  ) {
    return false
  }
  // If `terminalId` had no workspace path (e.g. synthetic ID), require recent activity within 15m
  if (!termWsPath && !hasActiveChildren && now - lastTouchMs > 15 * 60_000) {
    return false
  }
  return hasActiveChildren || lastTouchMs >= now - 6 * 3600_000
}

function selectBestSessionForPty(
  sortedByRecent: EnrichedSession[],
  claimedKeys: Set<string>,
  la: OrcaLiveAgentInfo,
  matchedTab: TerminalTabMeta | undefined,
  mappedKind: AgentKind | null,
  termWsPath: string | null,
  journal: JournalIndex,
  now: number,
  allSessions?: EnrichedSession[]
): EnrichedSession | undefined {
  if (matchedTab) {
    const prebound = sortedByRecent.find((s) => {
      const sKey = `${s.state.agent}:${s.state.sessionId}`
      if (claimedKeys.has(sKey)) return false
      if (s.matchedTab !== matchedTab) return false
      return canBindPtyToCliSession(s, la, mappedKind, termWsPath, journal, now, allSessions)
    })
    if (prebound) return prebound
  }
  return sortedByRecent.find((s) => {
    const sKey = `${s.state.agent}:${s.state.sessionId}`
    if (claimedKeys.has(sKey)) return false
    if (s.matchedTab && s.matchedTab !== matchedTab) return false
    return canBindPtyToCliSession(s, la, mappedKind, termWsPath, journal, now, allSessions)
  })
}

function matchPtyTerminalsToSessions(
  userSessions: EnrichedSession[],
  journal: JournalIndex,
  liveAgents: OrcaLiveAgentInfo[],
  now: number,
  allSessions?: EnrichedSession[]
): Map<string, OrcaLiveAgentInfo> {
  const recentLiveCutoffMs = now - LIVE_RECENT_MS
  const hasJournalRecords = journal.byNativeId.size > 0
  const terminalTabs = getEffectiveTerminalTabs(journal)
  const sortedByRecent = [...userSessions].sort(
    (a, b) => b.state.updatedAtMs - a.state.updatedAtMs
  )
  const claimed = new Set<string>()
  const out = new Map<string, OrcaLiveAgentInfo>()

  for (const la of liveAgents) {
    if (!isRealPtyAgentEntry(la, hasJournalRecords)) continue
    if (la.state === 'done' && la.stateStartedAt > 0 && la.stateStartedAt < recentLiveCutoffMs) {
      continue
    }
    const matchedTab = findTerminalTabById(terminalTabs, la.terminalId, la.tabId)
    const mappedKind =
      mapOrcaAgentKind(la.agent) ??
      matchedTab?.agent ??
      inferAgentFromTerminalTitle(la.title)
    const termWsPath =
      la.workspacePath ??
      matchedTab?.workspacePath ??
      extractWorkspacePathFromId(la.terminalId)
    const matched = selectBestSessionForPty(
      sortedByRecent,
      claimed,
      la,
      matchedTab,
      mappedKind,
      termWsPath,
      journal,
      now,
      allSessions
    )
    if (matched) {
      const sKey = `${matched.state.agent}:${matched.state.sessionId}`
      claimed.add(sKey)
      out.set(sKey, la)
    }
  }
  return out
}

export function compute60sIoSeries(
  turns: Iterable<ParsedTurnUsage>,
  isWorking: boolean,
  now: number
): {
  outSeries: number[]
  inSeries: number[]
  seriesEndSec: number
  liveOutRate: number
  liveInRate: number
} {
  const outRaw = new Float64Array(LIVE_SERIES_SECONDS)
  const inRaw = new Float64Array(LIVE_SERIES_SECONDS)
  const safeNow = Number.isFinite(now) && now > 0 ? now : Date.now()
  const endSec = Math.floor(safeNow / 1000)
  const startSec = endSec - (LIVE_SERIES_SECONDS - 1)

  const addGaussianBell = (
    arr: Float64Array,
    centerSec: number,
    sigmaSec: number,
    totalTokens: number
  ): void => {
    if (!(totalTokens > 0) || !Number.isFinite(totalTokens)) return
    const sigma = Math.max(0.85, sigmaSec)
    const radius = Math.ceil(sigma * 3.8)
    const firstSec = Math.floor(centerSec) - radius
    const lastSec = Math.ceil(centerSec) + radius
    if (lastSec < startSec || firstSec > endSec) return

    const count = lastSec - firstSec + 1
    const weights = new Float64Array(count)
    let weightSum = 0
    const invTwoVar = 0.5 / (sigma * sigma)
    for (let k = 0; k < count; k++) {
      const secMid = firstSec + k + 0.5
      const d = secMid - centerSec
      const w = Math.exp(-d * d * invTwoVar)
      weights[k] = w
      weightSum += w
    }
    if (!(weightSum > 0)) return

    const scale = totalTokens / weightSum
    const clipStart = Math.max(startSec, firstSec)
    const clipEnd = Math.min(endSec, lastSec)
    for (let s = clipStart; s <= clipEnd; s++) {
      arr[s - startSec] += weights[s - firstSec] * scale
    }
  }

  const addSmoothStreamWave = (
    arr: Float64Array,
    spanStartMs: number,
    spanEndMs: number,
    totalTokens: number
  ): void => {
    if (!(totalTokens > 0) || !Number.isFinite(totalTokens)) return
    const sMs = Math.min(spanStartMs, spanEndMs)
    const eMs = Math.max(sMs + 400, Math.max(spanStartMs, spanEndMs))
    const durSec = (eMs - sMs) / 1000
    const startS = sMs / 1000
    const endS = eMs / 1000

    // Short turns (< 2.8s): single silky Gaussian bell peak
    if (durSec <= 2.8) {
      const center = (startS + endS) * 0.5
      const sigma = Math.max(1.05, durSec * 0.48)
      addGaussianBell(arr, center, sigma, totalTokens)
      return
    }

    // Longer streaming turns: world-time-invariant overlapping Gaussian wavelets
    // Eliminates flat-topped square-wave plateaus while conserving 100% of tokens
    const numPulses = Math.max(2, Math.min(48, Math.round(durSec / 1.75)))
    const margin = Math.min(1.15, durSec * 0.2)
    const innerSpan = Math.max(0.2, durSec - margin * 2)
    const step = numPulses > 1 ? innerSpan / (numPulses - 1) : 0
    const sigma = Math.max(1.15, Math.min(1.75, Math.max(step * 0.88, 1.15)))
    const radius = Math.ceil(sigma * 3.6)

    const firstSec = Math.floor(startS) - radius
    const lastSec = Math.ceil(endS) + radius
    if (lastSec < startSec || firstSec > endSec) return

    const phase = (Math.abs(Math.floor(sMs / 100)) % 628) / 100
    const centers = new Float64Array(numPulses)
    const amps = new Float64Array(numPulses)
    for (let m = 0; m < numPulses; m++) {
      centers[m] = startS + margin + (numPulses > 1 ? m * step : innerSpan * 0.5)
      const arch = Math.pow(Math.sin((Math.PI * (m + 0.75)) / (numPulses + 0.5)), 0.58)
      const cadence = 1 + 0.19 * Math.sin(m * 2.13 + phase) + 0.1 * Math.cos(m * 3.37 - phase)
      amps[m] = Math.max(0.2, arch * cadence)
    }

    const count = lastSec - firstSec + 1
    const weights = new Float64Array(count)
    const invTwoVar = 0.5 / (sigma * sigma)
    let weightSum = 0

    for (let k = 0; k < count; k++) {
      const secMid = firstSec + k + 0.5
      let w = 0
      for (let m = 0; m < numPulses; m++) {
        const d = secMid - centers[m]
        if (Math.abs(d) <= sigma * 3.8) {
          w += amps[m] * Math.exp(-d * d * invTwoVar)
        }
      }
      weights[k] = w
      weightSum += w
    }
    if (!(weightSum > 0)) return

    const scale = totalTokens / weightSum
    const clipStart = Math.max(startSec, firstSec)
    const clipEnd = Math.min(endSec, lastSec)
    for (let s = clipStart; s <= clipEnd; s++) {
      arr[s - startSec] += weights[s - firstSec] * scale
    }
  }

  const sampleStartMs = safeNow - LIVE_RATE_WINDOW_SECONDS * 1000
  let outRate = 0
  let inRate = 0
  const relevanceCutoffMs = (startSec - 6) * 1000
  for (const turn of turns) {
    const turnEndMs = turn.timestampMs
    if (!Number.isFinite(turnEndMs) || turnEndMs < relevanceCutoffMs || turnEndMs > safeNow) continue
    const durMs =
      turn.durationSec !== null && Number.isFinite(turn.durationSec) && turn.durationSec > 0
        ? turn.durationSec * 1000
        : 1200
    const turnStartMs = turnEndMs - Math.min(120_000, Math.max(400, durMs))

    const outTokens = Math.max(0, (turn.output || 0) + (turn.reasoning || 0))
    if (outTokens > 0) {
      addSmoothStreamWave(outRaw, turnStartMs, turnEndMs, outTokens)
    }

    const inTokens = Math.max(
      0,
      (turn.input || 0) + (turn.cacheRead || 0) + (turn.cacheWrite || 0)
    )
    if (inTokens > 0) {
      addSmoothStreamWave(inRaw, turnStartMs, turnEndMs, inTokens)
    }

    if (isWorking && turnEndMs > sampleStartMs) {
      const fraction = Math.min(1, (turnEndMs - sampleStartMs) / durMs)
      outRate += outTokens * fraction / LIVE_RATE_WINDOW_SECONDS
      inRate += inTokens * fraction / LIVE_RATE_WINDOW_SECONDS
    }
  }

  const outSeries = Array.from(outRaw, (v) =>
    +(Number.isFinite(v) && v > 0.04 ? v : 0).toFixed(1)
  )
  const inSeries = Array.from(inRaw, (v) =>
    +(Number.isFinite(v) && v > 0.04 ? v : 0).toFixed(1)
  )

  return {
    outSeries,
    inSeries,
    seriesEndSec: endSec,
    liveOutRate: +outRate.toFixed(1),
    liveInRate: +inRate.toFixed(1)
  }
}

const STATE_SORT_WEIGHT: Record<AgentRunState, number> = {
  working: 0,
  blocked: 1,
  waiting: 2,
  done: 3
}

function liveCardTps(tps: TpsStats, liveOutRate: number): TpsStats {
  return { ...tps, liveTps: liveOutRate, peakTps: Math.max(tps.peakTps, liveOutRate) }
}

function buildLiveAgentCards(params: {
  userSessions: EnrichedSession[]
  journal: JournalIndex
  runtime: WorkspaceRuntimeContext
  effectivePathNorm: string | null
  effectiveProject: string | null
  effectiveName: string | null
  now: number
  allSessions?: EnrichedSession[]
}): LiveAgentCard[] {
  const {
    userSessions,
    journal,
    runtime,
    effectivePathNorm,
    effectiveProject,
    effectiveName,
    now,
    allSessions
  } = params
  const recentLiveCutoffMs = now - LIVE_RECENT_MS
  const sortedByRecent = [...userSessions].sort(
    (a, b) => b.state.updatedAtMs - a.state.updatedAtMs
  )
  const claimedSessionKeys = new Set<string>()
  const cards: LiveAgentCard[] = []

  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const homeNorm = normalizeFsPath(os.homedir())
  const hasJournalRecords = journal.byNativeId.size > 0
  const terminalTabs = getEffectiveTerminalTabs(journal)

  for (let idx = 0; idx < runtime.liveAgents.length; idx++) {
    const la = runtime.liveAgents[idx]
    if (!isRealPtyAgentEntry(la, hasJournalRecords)) {
      continue
    }
    // Filter out stale `done` terminals older than 15 minutes
    if (
      la.state === 'done' &&
      la.stateStartedAt > 0 &&
      la.stateStartedAt < recentLiveCutoffMs
    ) {
      continue
    }

    const matchedTab = findTerminalTabById(terminalTabs, la.terminalId, la.tabId)
    const mappedKind =
      mapOrcaAgentKind(la.agent) ??
      matchedTab?.agent ??
      inferAgentFromTerminalTitle(la.title)
    const termWsPath =
      la.workspacePath ??
      matchedTab?.workspacePath ??
      extractWorkspacePathFromId(la.terminalId)
    const ptyCustomTitle =
      lookupPtyCustomTitle(journal, la.terminalId) ?? matchedTab?.effectiveTitle ?? undefined

    const matchedSession = selectBestSessionForPty(
      sortedByRecent,
      claimedSessionKeys,
      la,
      matchedTab,
      mappedKind,
      termWsPath,
      journal,
      now,
      allSessions
    )

    if (matchedSession) {
      const sKey = `${matchedSession.state.agent}:${matchedSession.state.sessionId}`
      claimedSessionKeys.add(sKey)
      let resolvedState = resolveSessionRunState(
        matchedSession.state,
        undefined,
        la.state,
        now,
        la.stateStartedAt || 0
      )
      const isWorking = resolvedState === 'working'
      if (
        hasActiveChildSubagent(
          matchedSession.state.agent,
          matchedSession.state.sessionId,
          allSessions,
          journal,
          now
        )
      ) {
        resolvedState = 'waiting'
      }
      const io = compute60sIoSeries(
        matchedSession.state.turnsByKey.values(),
        isWorking,
        now
      )
      cards.push({
        id: la.terminalId || sKey,
        sessionKey: sKey,
        parentSessionKey: parentSessionKey(
          matchedSession.state.agent,
          matchedSession.state.parentSessionId
        ),
        terminalId: la.terminalId,
        agent: matchedSession.state.agent,
        providerLabel: matchedSession.providerLabel,
        modelLabel: matchedSession.modelLabel,
        reasoningLevels: matchedSession.reasoningLevels,
        state: resolvedState,
        title: ptyCustomTitle || matchedSession.title,
        projectName: matchedSession.projectName,
        workspaceName: matchedSession.workspaceName,
        workspacePath: matchedSession.workspacePath,
        updatedAt: Math.max(matchedSession.state.updatedAtMs, la.stateStartedAt || 0),
        tps: liveCardTps(matchedSession.tps, io.liveOutRate),
        sparkline: matchedSession.sparkline,
        outSeries: io.outSeries,
        inSeries: io.inSeries,
        seriesEndSec: io.seriesEndSec,
        liveOutRate: io.liveOutRate,
        liveInRate: io.liveInRate,
        tokens: matchedSession.tokens
      })
    } else if (mappedKind && la.state !== 'done' && la.terminalId) {
      const fallbackModel =
        journal.cliConfiguredModels?.[mappedKind] || DEFAULT_MODEL_DISPLAY[mappedKind]
      const resolvedWs = resolveProjectAndWorktree(
        termWsPath ?? effectivePathNorm,
        indexedWorkspaces,
        homeNorm
      )
      const fallbackKey = `terminal:${la.terminalId || idx}`
      const io = compute60sIoSeries([], false, now)
      const nonGenericLaTitle =
        la.title && !isGenericTerminalTabLabel(la.title, matchedTab?.rawTabLabel)
          ? la.title.trim()
          : null
      const zeroTurnTitle =
        ptyCustomTitle ||
        nonGenericLaTitle ||
        matchedTab?.rawTabLabel ||
        la.title?.trim() ||
        `${mappedKind} session`
      cards.push({
        id: la.terminalId || fallbackKey,
        sessionKey: fallbackKey,
        parentSessionKey: null,
        terminalId: la.terminalId,
        agent: mappedKind,
        providerLabel: providerLabelForAgent(mappedKind, fallbackModel),
        modelLabel: fallbackModel,
        reasoningLevels: [],
        state: la.state,
        title: zeroTurnTitle,
        projectName: resolvedWs.projectName ?? effectiveProject,
        workspaceName:
          resolvedWs.workspaceName !== 'local'
            ? resolvedWs.workspaceName
            : effectiveName || 'local',
        workspacePath: termWsPath ?? effectivePathNorm,
        updatedAt: la.stateStartedAt || now,
        tps: emptyTpsStats(),
        sparkline: [],
        outSeries: io.outSeries,
        inSeries: io.inSeries,
        seriesEndSec: io.seriesEndSec,
        liveOutRate: io.liveOutRate,
        liveInRate: io.liveInRate,
        tokens: emptyTokenBreakdown()
      })
    }
  }

  for (const s of sortedByRecent) {
    const sKey = `${s.state.agent}:${s.state.sessionId}`
    if (claimedSessionKeys.has(sKey)) continue
    const jMeta = journal.byNativeId.get(s.state.sessionId)
    if (s.tokens.total <= 0 && !jMeta?.isTurnOpen) continue
    const hasActiveChild = hasActiveChildSubagent(
      s.state.agent,
      s.state.sessionId,
      allSessions,
      journal,
      now
    )
    const isRecentlyActive =
      Boolean(jMeta?.isTurnOpen) ||
      Boolean(jMeta?.isLiveLease) ||
      hasActiveChild ||
      s.state.updatedAtMs >= recentLiveCutoffMs
    if (!isRecentlyActive) continue

    claimedSessionKeys.add(sKey)
    let state = resolveSessionRunState(s.state, jMeta, null, now)
    const isWorking = state === 'working'
    if (hasActiveChild) {
      state = 'waiting'
    }
    const io = compute60sIoSeries(s.state.turnsByKey.values(), isWorking, now)
    cards.push({
      id: sKey,
      sessionKey: sKey,
      parentSessionKey: parentSessionKey(s.state.agent, s.state.parentSessionId),
      terminalId: null,
      agent: s.state.agent,
      providerLabel: s.providerLabel,
      modelLabel: s.modelLabel,
      reasoningLevels: s.reasoningLevels,
      state,
      title: s.title,
      projectName: s.projectName,
      workspaceName: s.workspaceName,
      workspacePath: s.workspacePath,
      updatedAt: s.state.updatedAtMs,
      tps: liveCardTps(s.tps, io.liveOutRate),
      sparkline: s.sparkline,
      outSeries: io.outSeries,
      inSeries: io.inSeries,
      seriesEndSec: io.seriesEndSec,
      liveOutRate: io.liveOutRate,
      liveInRate: io.liveInRate,
      tokens: s.tokens
    })
  }

  cards.sort((a, b) => {
    const sw = STATE_SORT_WEIGHT[a.state] - STATE_SORT_WEIGHT[b.state]
    if (sw !== 0) return sw
    const aFocused =
      effectivePathNorm && a.workspacePath
        ? isSameOrChildWorktreePath(a.workspacePath, effectivePathNorm)
        : false
    const bFocused =
      effectivePathNorm && b.workspacePath
        ? isSameOrChildWorktreePath(b.workspacePath, effectivePathNorm)
        : false
    if (aFocused !== bFocused) return aFocused ? -1 : 1
    return b.updatedAt - a.updatedAt
  })

  return cards
}

export function pollSingleLiveAgent(
  sessionKey: string,
  rawSessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  runtime: WorkspaceRuntimeContext,
  now = Date.now()
): LiveAgentCard | null {
  if (!sessionKey || typeof sessionKey !== 'string') return null
  const recentCutoff = now - 6 * 3600_000
  const hotRaw = rawSessions.filter(
    (st) =>
      st.updatedAtMs >= recentCutoff ||
      `${st.agent}:${st.sessionId}` === sessionKey ||
      st.sessionId === sessionKey
  )
  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const enrichedAll = enrichSessions(hotRaw, journal, pricing, indexedWorkspaces, rawSessions)
  const userSessions = enrichedAll.filter((s) => !s.isSubagent)
  const focusedPathNorm = normalizeFsPath(runtime.focusedPath)
  const liveCards = buildLiveAgentCards({
    userSessions,
    journal,
    runtime,
    effectivePathNorm: focusedPathNorm,
    effectiveProject: runtime.focusedProject ?? null,
    effectiveName: runtime.focusedName ?? null,
    now,
    allSessions: enrichedAll
  })

  const terminalLookupId = sessionKey.startsWith('terminal:')
    ? sessionKey.slice('terminal:'.length)
    : null
  const hit = liveCards.find(
    (c) =>
      c.sessionKey === sessionKey ||
      c.id === sessionKey ||
      (terminalLookupId !== null && c.id === terminalLookupId)
  )
  if (hit) return hit

  // Fallback if user keeps an agent detail view open after 15m idle cutoff
  const fallback = enrichedAll.find(
    (s) => `${s.state.agent}:${s.state.sessionId}` === sessionKey || s.state.sessionId === sessionKey
  )
  if (!fallback) return null

  const jMeta = journal.byNativeId.get(fallback.state.sessionId)
  let state = resolveSessionRunState(fallback.state, jMeta, null, now)
  const isWorking = state === 'working'
  if (
    hasActiveChildSubagent(
      fallback.state.agent,
      fallback.state.sessionId,
      enrichedAll,
      journal,
      now
    )
  ) {
    state = 'waiting'
  }
  const io = compute60sIoSeries(
    fallback.state.turnsByKey.values(),
    isWorking,
    now
  )
  const sKey = `${fallback.state.agent}:${fallback.state.sessionId}`
  return {
    id: sKey,
    sessionKey: sKey,
    parentSessionKey: parentSessionKey(fallback.state.agent, fallback.state.parentSessionId),
    terminalId: null,
    agent: fallback.state.agent,
    providerLabel: fallback.providerLabel,
    modelLabel: fallback.modelLabel,
    reasoningLevels: fallback.reasoningLevels,
    state,
    title: fallback.title,
    projectName: fallback.projectName,
    workspaceName: fallback.workspaceName,
    workspacePath: fallback.workspacePath,
    updatedAt: fallback.state.updatedAtMs,
    tps: liveCardTps(fallback.tps, io.liveOutRate),
    sparkline: fallback.sparkline,
    outSeries: io.outSeries,
    inSeries: io.inSeries,
    seriesEndSec: io.seriesEndSec,
    liveOutRate: io.liveOutRate,
    liveInRate: io.liveInRate,
    tokens: fallback.tokens
  }
}

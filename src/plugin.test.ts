import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import {
  buildDashboardSnapshot,
  compute60sIoSeries,
  isSameOrChildWorktreePath,
  pollSingleLiveAgent
} from './aggregator'
import {
  cleanConversationTitle,
  extractWorkspacePathFromId,
  type JournalIndex,
  normalizeConfiguredModelSlug,
  readOrcaActiveWorktreeSelection,
  readOrcaJournalIndex
} from './journal'
import {
  escapeHtml,
  formatProjectWorktreeLabel,
  renderDashboardShellHtml,
  renderIoWaveformSvg
} from './panel/app'
import { formatTokens, formatUsd, getMessages, resolveLocale } from './panel/i18n'
import {
  applyAntigravityLines,
  applyClaudeLines,
  applyCodexLines,
  createEmptySessionState,
  parseGeminiSessionJson,
  readCompleteJsonlChunk
} from './parsers'
import {
  normalizeModelId,
  parseModelsDevPayload,
  parseOpenRouterPayload,
  PricingEngine
} from './pricing'
import { TranscriptScanner } from './scanner'
import * as workerModule from './worker'

function createTestJournalIndex(overrides: Partial<JournalIndex> = {}): JournalIndex {
  return {
    byNativeId: new Map(),
    byOrcaSessionId: new Map(),
    accountHomes: new Map(),
    workspaceActivityMs: new Map(),
    ...overrides
  }
}

describe('readCompleteJsonlChunk incremental streaming & UTF-8 safety', () => {
  test('holds partial trailing line until newline arrives and resets on file truncation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-chunk-test-'))
    const logPath = path.join(tmpDir, 'stream.jsonl')
    try {
      const line1 = JSON.stringify({ seq: 1, title: '第一筆繁體中文測試' })
      const line2 = JSON.stringify({ seq: 2, title: '第二筆串流中斷測試🚀' })

      const halfIdx = Math.floor(line2.length / 2)
      fs.writeFileSync(logPath, `${line1}\n${line2.slice(0, halfIdx)}`, 'utf8')

      const c1 = readCompleteJsonlChunk(logPath, 0)
      assert.equal(c1.lines.length, 1)
      assert.deepEqual(JSON.parse(c1.lines[0]), { seq: 1, title: '第一筆繁體中文測試' })

      const c2 = readCompleteJsonlChunk(logPath, c1.nextOffset)
      assert.equal(c2.lines.length, 0)
      assert.equal(c2.nextOffset, c1.nextOffset)

      fs.appendFileSync(logPath, `${line2.slice(halfIdx)}\n`, 'utf8')
      const c3 = readCompleteJsonlChunk(logPath, c2.nextOffset)
      assert.equal(c3.lines.length, 1)
      assert.deepEqual(JSON.parse(c3.lines[0]), { seq: 2, title: '第二筆串流中斷測試🚀' })

      const lineRotated = JSON.stringify({ seq: 99 })
      fs.writeFileSync(logPath, `${lineRotated}\n`, 'utf8')
      const c4 = readCompleteJsonlChunk(logPath, c3.nextOffset)
      assert.equal(c4.lines.length, 1)
      assert.deepEqual(JSON.parse(c4.lines[0]), { seq: 99 })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('4-Agent Transcript Parsers & TPS Accuracy', () => {
  test('Claude Code deduplicates multi-poll streaming message.id chunks, skips <synthetic>, and filters <0.2s noise', () => {
    const st = createEmptySessionState('claude-s1', 'claude', '/tmp/claude-s1.jsonl')
    applyClaudeLines(st, [
      JSON.stringify({
        type: 'user',
        cwd: '/Users/dev/project-alpha',
        timestamp: '2026-11-11T06:00:00.000Z',
        message: { role: 'user', content: 'Build the token pulse dashboard' }
      }),
      JSON.stringify({
        type: 'api-request',
        timestamp: '2026-11-11T06:00:01.000Z',
        params: { model: 'claude-fable-5' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:01.050Z',
        message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:01.100Z',
        message: {
          id: 'msg_01',
          model: 'claude-fable-5',
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 500,
            output_tokens: 15
          }
        }
      })
    ])

    applyClaudeLines(st, [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:05.000Z',
        message: {
          id: 'msg_01',
          model: 'claude-fable-5',
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 500,
            output_tokens: 240
          }
        }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:05.050Z',
        message: {
          id: 'msg_02',
          model: 'claude-fable-5',
          usage: { input_tokens: 100, output_tokens: 20 }
        }
      })
    ])

    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.latestModel, 'claude-fable-5')
    assert.equal(st.titleHint, 'Build the token pulse dashboard')
    assert.equal(st.turnsByKey.size, 2)

    const t1 = st.turnsByKey.get('msg_01')!
    assert.equal(t1.input, 1200)
    assert.equal(t1.cacheRead, 8000)
    assert.equal(t1.cacheWrite, 500)
    assert.equal(t1.output, 240)
    assert.equal(t1.total, 9940)
    assert.equal(t1.tps, 60)

    const t2 = st.turnsByKey.get('msg_02')!
    assert.equal(t2.tps, null)
  })

  test('Codex subtracts cached_input_tokens, deduplicates heartbeats, and tags subagent rollouts', () => {
    const st = createEmptySessionState('codex-raw', 'codex', '/tmp/rollout-1.jsonl')
    applyCodexLines(st, [
      JSON.stringify({
        timestamp: '2026-11-11T06:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a0c6de-1111-2222-3333-444455556666',
          cwd: '/Users/dev/project-alpha',
          source: { subagent: { parent_id: 'root-1' } }
        }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:01.000Z',
        type: 'turn_context',
        payload: { cwd: '/Users/dev/project-alpha', model: 'gpt-6.1-sol' }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Audit adversarial P0/P1 edge cases' }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 10500 },
            last_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 8500,
              output_tokens: 500,
              reasoning_output_tokens: 200
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:06.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 10500 },
            last_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 8500,
              output_tokens: 500,
              reasoning_output_tokens: 200
            }
          }
        }
      })
    ])

    assert.equal(st.sessionId, '01a0c6de-1111-2222-3333-444455556666')
    assert.equal(st.isSubagent, true)
    assert.equal(st.latestModel, 'gpt-6.1-sol')
    assert.equal(st.turnsByKey.size, 1)

    const turn = Array.from(st.turnsByKey.values())[0]!
    assert.equal(turn.input, 1500)
    assert.equal(turn.cacheRead, 8500)
    assert.equal(turn.output, 300)
    assert.equal(turn.reasoning, 200)
    assert.equal(turn.total, 10500)
    assert.equal(turn.tps, 100)
  })

  test('Antigravity computes TPS for start-timed & out-of-order steps, guards 1s quantization spikes, and filters helpers', () => {
    const st = createEmptySessionState('ag-brain-1', 'antigravity', '/tmp/transcript.jsonl')
    applyAntigravityLines(st, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:00:00Z',
        content: 'Command Working Directory: /Users/dev/project-alpha\n<USER_REQUEST>實測並執行對抗性審查</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:00Z',
        input_tokens: 4000,
        cache_read_tokens: 20000,
        output_tokens: 500
      }),
      JSON.stringify({
        step_index: 2,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:10Z'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:22Z'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:12Z',
        input_tokens: 2000,
        cache_read_tokens: 24000,
        output_tokens: 400
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:22Z',
        input_tokens: 1000,
        output_tokens: 600
      }),
      JSON.stringify({
        step_index: 6,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:23Z'
      })
    ])

    assert.equal(st.isInternalHelper, false)
    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.titleHint, '實測並執行對抗性審查')
    assert.equal(st.turnsByKey.get('ag-step-1')?.tps, 50)
    assert.equal(st.turnsByKey.get('ag-step-3')?.tps, 40)
    assert.equal(st.turnsByKey.get('ag-step-5')?.tps, null)

    const helper = createEmptySessionState('ag-helper', 'antigravity', '/tmp/helper.jsonl')
    applyAntigravityLines(helper, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:00:00Z',
        content: "Name this chat from the user's first request."
      })
    ])
    assert.equal(helper.isInternalHelper, true)

    const commitHelper = createEmptySessionState('ag-commit-helper', 'antigravity', '/tmp/commit-helper.jsonl')
    applyAntigravityLines(commitHelper, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:01:00Z',
        content: 'You are generating a single git commit message.\nReturn only the commit message text.'
      })
    ])
    assert.equal(commitHelper.isInternalHelper, true)

    const askAndDone = createEmptySessionState('ag-state-1', 'antigravity', '/tmp/state.jsonl')
    applyAntigravityLines(askAndDone, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:02:00Z',
        content: '<USER_REQUEST>Build dashboard</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-11T07:02:04Z',
        tool_calls: [{ name: 'ask_question', args: {} }],
        input_tokens: 1200,
        output_tokens: 80
      })
    ])
    assert.equal(askAndDone.lastEventState, 'waiting')
    applyAntigravityLines(askAndDone, [
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-11T07:02:15Z',
        tool_calls: [],
        input_tokens: 1500,
        output_tokens: 240
      })
    ])
    assert.equal(askAndDone.lastEventState, 'done')

    const handover = createEmptySessionState('ag-handover', 'antigravity', '/tmp/handover.jsonl')
    applyAntigravityLines(handover, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:05:00Z',
        content:
          'Continue work from the prior Orca session.\nSession: QBiBot Release 2.0 Audit\nOriginal working directory: /Users/dev/qbibotlive/release-2.0\n...[truncated]'
      })
    ])
    assert.equal(handover.cwd, '/Users/dev/qbibotlive/release-2.0')
    assert.equal(handover.titleHint, 'QBiBot Release 2.0 Audit')
  })

  test('Gemini CLI parses monolithic session JSON, folder-key project mapping, cached subtraction, and TPS', () => {
    const projMap = new Map([['folder-hash-xyz', '/Users/dev/project-alpha']])
    const raw = JSON.stringify({
      sessionId: 'gem-sess-1',
      startTime: '2026-11-11T06:30:00.000Z',
      lastUpdated: '2026-11-11T06:30:08.000Z',
      messages: [
        { type: 'user', timestamp: '2026-11-11T06:30:00.000Z', content: 'Optimize bundle performance' },
        {
          id: 'g-1',
          type: 'gemini',
          model: 'gemini-3-pro',
          timestamp: '2026-11-11T06:30:08.000Z',
          tokens: { input: 5000, cached: 3000, output: 320, thoughts: 80 }
        }
      ]
    })

    const st = parseGeminiSessionJson(
      '/Users/dev/.gemini/tmp/folder-hash-xyz/chats/session-1.json',
      raw,
      projMap
    )!
    assert.ok(st)
    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.latestModel, 'gemini-3-pro')
    const turn = st.turnsByKey.get('g-1')!
    assert.equal(turn.input, 2000)
    assert.equal(turn.cacheRead, 3000)
    assert.equal(turn.output, 320)
    assert.equal(turn.reasoning, 80)
    assert.equal(turn.tps, 50)
  })
})

describe('Live Online Model Pricing Engine', () => {
  test('normalizes model IDs, converts OpenRouter per-token rates, rejects negative sentinels, and computes cache-discounted USD', async () => {
    assert.equal(
      normalizeModelId('us.anthropic.claude-sonnet-4.6-20251001[1m]:thinking'),
      'claude-sonnet-4-6'
    )
    assert.equal(normalizeModelId('opus[1m]'), 'opus')

    const orParsed = parseOpenRouterPayload({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
            input_cache_write: '0.00000375'
          }
        },
        {
          id: 'openai/auto-router',
          pricing: { prompt: '-1', completion: '-1' }
        }
      ]
    })
    assert.deepEqual(orParsed['claude-sonnet-4-6'], {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    })
    assert.equal(orParsed['auto-router'], undefined)

    const mdParsed = parseModelsDevPayload({
      openai: {
        models: {
          'gpt-5-mini': { cost: { input: 0.25, output: 2.0, cache_read: 0.025 } },
          'gpt-5': { cost: { input: 1.25, output: 10.0, cache_read: 0.125 } }
        }
      }
    })
    assert.equal(mdParsed['gpt-5-mini'].input, 0.25)

    const mockFetch: typeof fetch = async (url) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'anthropic/claude-sonnet-4.6',
                pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }
              }
            ]
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              'gpt-5': { cost: { input: 1.25, output: 10.0, cache_read: 0.125 } },
              'gpt-5-mini': { cost: { input: 0.25, output: 2.0, cache_read: 0.025 } }
            }
          }
        }),
        { status: 200 }
      )
    }

    const engine = new PricingEngine(mockFetch)
    const status = await engine.syncOnline(2000)
    assert.equal(status.source, 'online')
    assert.equal(engine.resolveRate('codex', 'gpt-5-mini-preview').input, 0.25)

    const cost = engine.computeCostUsd('claude', 'claude-fable-5', {
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000
    })
    assert.equal(+cost.toFixed(2), 18.3)

    const offlineEngine = new PricingEngine(async () => {
      throw new Error('offline')
    })
    offlineEngine.loadFromCache(engine.toStorableCatalog())
    const failStatus = await offlineEngine.syncOnline(200)
    assert.equal(failStatus.source, 'cache')
    assert.ok(failStatus.lastError?.includes('offline'))
  })
})

describe('Aggregator, Left-Sidebar Project/Worktree Focus, Pure-Icon UI & i18n', () => {
  test('scopes conversations strictly to focused Orca Project -> Worktree, sorts newest-to-oldest, excludes subagents from cards, and uses pure SVG icon tabs', () => {
    assert.equal(resolveLocale('zh-TW'), 'zh-TW')
    assert.equal(resolveLocale('zh-Hant-HK'), 'zh-TW')
    assert.equal(resolveLocale('zh-CN'), 'zh-CN')
    assert.equal(resolveLocale('ja-JP'), 'ja')
    assert.equal(resolveLocale('ko-KR'), 'ko')
    assert.equal(resolveLocale('en-US'), 'en')

    assert.equal(
      extractWorkspacePathFromId('d950d0e9::/Users/wilsonliu/orca/orca-token-used@@pty123'),
      '/Users/wilsonliu/orca/orca-token-used'
    )
    assert.equal(formatProjectWorktreeLabel('PulseBoard', 'main', 'main'), 'PulseBoard / main')
    assert.equal(
      isSameOrChildWorktreePath('/Users/dev/wt-a/packages/ui', '/Users/dev/wt-a'),
      true
    )
    assert.equal(
      isSameOrChildWorktreePath('/Users/dev/wt-a-other', '/Users/dev/wt-a'),
      false
    )

    const now = Date.parse('2026-11-11T08:00:00.000Z')

    // Project A (`orca-token-used`), worktree `main`: 2 user sessions + 1 subagent
    const sOlderA = createEmptySessionState('s-older-a', 'claude', '/tmp/older-a.jsonl')
    sOlderA.cwd = '/Users/dev/orca-token-used'
    sOlderA.latestModel = 'claude-fable-5'
    sOlderA.createdAtMs = now - 3600_000
    sOlderA.updatedAtMs = now - 1800_000
    sOlderA.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 1800_000,
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 2000,
      cacheWrite: 0,
      total: 3500,
      durationSec: 10,
      tps: 50,
      model: 'claude-fable-5',
      explicitCostUsd: null
    })

    const sNewerA = createEmptySessionState('s-newer-a', 'codex', '/tmp/newer-a.jsonl')
    sNewerA.cwd = '/Users/dev/orca-token-used/src'
    sNewerA.latestModel = 'gpt-6.1-sol'
    sNewerA.createdAtMs = now - 600_000
    sNewerA.updatedAtMs = now - 10_000
    sNewerA.titleHint = 'Fix <script>alert("xss")</script> bug'
    sNewerA.turnsByKey.set('t2', {
      turnKey: 't2',
      timestampMs: now - 10_000,
      input: 2000,
      output: 800,
      reasoning: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      total: 8000,
      durationSec: 10,
      tps: 100,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const sSubagentA = createEmptySessionState('s-sub-a', 'codex', '/tmp/sub-a.jsonl')
    sSubagentA.cwd = '/Users/dev/orca-token-used'
    sSubagentA.isSubagent = true
    sSubagentA.updatedAtMs = now - 8_000
    sSubagentA.turnsByKey.set('t-sub', {
      turnKey: 't-sub',
      timestampMs: now - 8_000,
      input: 500,
      output: 500,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1000,
      durationSec: 5,
      tps: 100,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    // Project B (`PulseBoard`), ALSO having worktree named `main`
    const sProjectB = createEmptySessionState('s-pulse-b', 'antigravity', '/tmp/pulse-b.jsonl')
    sProjectB.cwd = '/Users/dev/PulseBoard'
    sProjectB.updatedAtMs = now - 5_000
    sProjectB.titleHint = 'PulseBoard UI redesign'
    sProjectB.turnsByKey.set('t3', {
      turnKey: 't3',
      timestampMs: now - 5_000,
      input: 1_000_000,
      output: 100_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1_100_000,
      durationSec: 6,
      tps: 50,
      model: null, // Antigravity turn has null model; resolved via journal (`gemini-4-carbon`)
      explicitCostUsd: null
    })

    // Second Antigravity session using cheaper `gemini-4-argon` via journal (verifies perAgentFallbackModel does not clobber `sProjectB` cost)
    const sAgLight = createEmptySessionState('s-ag-light', 'antigravity', '/tmp/ag-light.jsonl')
    sAgLight.cwd = '/Users/dev/PulseBoard'
    sAgLight.updatedAtMs = now - 4_000
    sAgLight.turnsByKey.set('t4', {
      turnKey: 't4',
      timestampMs: now - 4_000,
      input: 100_000,
      output: 10_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 110_000,
      durationSec: 5,
      tps: 40,
      model: null,
      explicitCostUsd: null
    })

    const journal = createTestJournalIndex({
      byNativeId: new Map([
        [
          's-older-a',
          {
            orcaSessionId: 'orca-1',
            nativeId: 's-older-a',
            provider: 'claude',
            title: '舊的對話標題',
            workspacePath: '/Users/dev/orca-token-used',
            model: 'claude-fable-5',
            updatedAt: now - 1800_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ],
        [
          's-newer-a',
          {
            orcaSessionId: 'orca-a2',
            nativeId: 's-newer-a',
            provider: 'codex',
            title: null,
            workspacePath: '/Users/dev/orca-token-used',
            model: 'gpt-6.1-terra',
            updatedAt: now - 10_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ],
        [
          's-pulse-b',
          {
            orcaSessionId: 'orca-b1',
            nativeId: 's-pulse-b',
            provider: 'antigravity',
            title: 'PulseBoard UI redesign',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-carbon',
            updatedAt: now - 5_000,
            isLiveLease: true,
            isTurnOpen: false
          }
        ],
        [
          's-ag-light',
          {
            orcaSessionId: 'orca-b2',
            nativeId: 's-ag-light',
            provider: 'antigravity',
            title: 'PulseBoard quick fix',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-argon',
            updatedAt: now - 4_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ]
      ])
    })

    const knownWorkspaces = [
      {
        id: 'repo-a::/Users/dev/orca-token-used',
        project: 'orca-token-used',
        name: 'main',
        path: '/Users/dev/orca-token-used',
        branch: 'refs/heads/main'
      },
      {
        id: 'repo-b::/Users/dev/PulseBoard',
        project: 'PulseBoard',
        name: 'main',
        path: '/Users/dev/PulseBoard',
        branch: 'refs/heads/main'
      }
    ]

    const snapA = buildDashboardSnapshot(
      [sOlderA, sNewerA, sSubagentA, sProjectB, sAgLight],
      journal,
      new PricingEngine(),
      {
        focusedId: 'repo-a::/Users/dev/orca-token-used',
        focusedProject: 'orca-token-used',
        focusedName: 'main',
        focusedBranch: 'refs/heads/main',
        focusedPath: '/Users/dev/orca-token-used',
        knownWorkspaces,
        liveAgents: [
          {
            terminalId: 'stale-done-pty',
            title: 'aggy-finished-2h-ago',
            agent: 'claude',
            state: 'done',
            stateStartedAt: now - 2 * 3600_000
          }
        ]
      },
      now
    )

    assert.equal(snapA.workspace.project, 'orca-token-used')
    assert.equal(snapA.workspace.name, 'main')
    assert.equal(snapA.workspace.branch, 'main')
    assert.equal(snapA.sessions.length, 2)
    assert.equal(snapA.sessions[0].sessionId, 's-newer-a')
    assert.equal(snapA.sessions[0].projectName, 'orca-token-used')
    assert.equal(snapA.sessions[1].sessionId, 's-older-a')
    assert.equal(snapA.sessions[1].title, '舊的對話標題')

    // Stale (>15m) `state: 'done'` terminal must NOT appear in Live view
    assert.ok(!snapA.live.agents.some((la) => la.id === 'stale-done-pty'))

    assert.equal(snapA.periods.worktree.day.tokens.total, 12500)
    assert.equal(snapA.periods.all.day.tokens.total, 1_222_500)

    // Per-agent cost breakdown MUST sum identically to total period cost even across mixed-model null-turn-model sessions
    const byAgentCostSum = snapA.periods.all.day.byAgent.reduce((acc, r) => acc + r.tokens.costUsd, 0)
    assert.ok(
      Math.abs(byAgentCostSum - snapA.periods.all.day.tokens.costUsd) < 1e-4,
      `Expected byAgent sum ${byAgentCostSum} to match period cost ${snapA.periods.all.day.tokens.costUsd}`
    )

    const htmlSessions = renderDashboardShellHtml({
      snap: snapA,
      tab: 'sessions',
      scope: 'worktree',
      locale: 'zh-TW',
      nowMs: now
    })
    assert.ok(htmlSessions.includes(getMessages('zh-TW').appTitle))
    assert.ok(htmlSessions.includes('orca-token-used / main'))
    // Must NOT show PulseBoard pills or manual switcher inside orca-token-used's Sessions view
    assert.ok(!htmlSessions.includes('PulseBoard / main'))
    assert.ok(htmlSessions.includes('OpenAI · gpt-6.1-terra'))
    assert.ok(!htmlSessions.includes('<script>alert("xss")</script>'))
    assert.ok(htmlSessions.includes(escapeHtml('Fix <script>alert("xss")</script> bug')))

    assert.equal(getMessages('en').appTitle, 'Token Pulse')
    assert.equal(getMessages('zh-TW').appTitle, 'Token 算力脈衝')
    assert.ok(htmlSessions.includes('tp-brand-emblem'))

    const navBtnMatches = [
      ...htmlSessions.matchAll(/<button[^>]*class="(tp-nav-btn[^"]*)"[^>]*>([\s\S]*?)<\/button>/g)
    ]
    assert.equal(navBtnMatches.length, 5)
    let activeNavCount = 0
    for (const m of navBtnMatches) {
      const cls = m[1]
      const inner = m[2].trim()
      assert.ok(inner.startsWith('<svg'))
      const strippedSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').trim()
      if (cls.split(/\s+/).includes('active')) {
        activeNavCount++
        assert.equal(strippedSvg, `<span class="tp-nav-label">${getMessages('zh-TW').navShort.sessions}</span>`)
      } else {
        assert.equal(strippedSvg, '')
      }
    }
    assert.equal(activeNavCount, 1)

    // Verify 60s dual I/O series & smooth flowing spline SVG (Output upper half, Input lower half, NaN-free, no protruding dot)
    const ioZero = renderIoWaveformSvg([], 'out')
    assert.ok(!ioZero.html.includes('NaN') && !ioZero.html.includes('Infinity'))
    assert.ok(!ioZero.html.includes('tp-io-live-dot'))
    assert.ok(ioZero.html.includes('clipPath'))
    assert.equal(ioZero.scaleMax, 20)

    const ioSpiky = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now)
    assert.equal(ioSpiky.outSeries.length, 60)
    assert.equal(ioSpiky.inSeries.length, 60)
    assert.equal(ioSpiky.seriesEndSec, Math.floor(now / 1000))
    assert.ok(ioSpiky.outSeries.some((v) => v > 0))
    assert.ok(ioSpiky.inSeries.some((v) => v > 0))

    // Verify zero flat-topped rectangular plateaus (no 4+ identical consecutive peak values)
    const nonZeroOut = ioSpiky.outSeries.filter((v) => v > 1)
    assert.ok(new Set(nonZeroOut).size >= 4, 'Multi-second output span should form a smooth rounded wave, not a flat square-wave plateau')

    // Verify strict world-time invariance: advancing `now` by +1000ms shifts `outSeries` & `inSeries` left by 1 second identically
    const ioNextSec = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now + 1000)
    assert.deepEqual(ioNextSec.outSeries.slice(0, 59), ioSpiky.outSeries.slice(1, 60))
    assert.deepEqual(ioNextSec.inSeries.slice(0, 59), ioSpiky.inSeries.slice(1, 60))

    // Verify `liveOutRate` and `liveInRate` are non-zero and dynamically evolve across 1s ticks while `working`,
    // then settle cleanly to `0` once stopped (`isWorking = false`)
    const ioSec2 = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now + 2000)
    assert.ok(ioSpiky.liveOutRate > 0 && ioNextSec.liveOutRate > 0 && ioSec2.liveOutRate > 0)
    assert.ok(ioSpiky.liveInRate > 0 && ioNextSec.liveInRate > 0 && ioSec2.liveInRate > 0)
    assert.ok(
      new Set([ioSpiky.liveOutRate, ioNextSec.liveOutRate, ioSec2.liveOutRate]).size >= 2,
      'Active working Output tok/s readout should dynamically update across consecutive 1s polls'
    )
    assert.ok(
      new Set([ioSpiky.liveInRate, ioNextSec.liveInRate, ioSec2.liveInRate]).size >= 2,
      'Active working Input tok/s readout should dynamically update across consecutive 1s polls'
    )
    const ioStopped = compute60sIoSeries(sNewerA.turnsByKey.values(), false, now + 5000)
    assert.equal(ioStopped.liveOutRate, 0)
    assert.equal(ioStopped.liveInRate, 0)

    // Stopped Orca Native Chat session with `isLiveLease: true, isTurnOpen: false` (e.g. `# Wilson` / `s-pulse-b`)
    // MUST display `done` (NOT `waiting`)
    const pulseLiveCard = snapA.live.agents.find((a) => a.sessionKey === 'antigravity:s-pulse-b')
    assert.ok(pulseLiveCard)
    assert.equal(pulseLiveCard.state, 'done')

    // Expanding a single agent in Live mode must show explicit model input/output labels.
    const targetAgent = snapA.live.agents.find((a) => a.sessionKey === 'codex:s-newer-a')!
    assert.ok(targetAgent)
    assert.equal(targetAgent.modelLabel, 'gpt-6.1-terra')
    const htmlExpandedLive = renderDashboardShellHtml({
      snap: snapA,
      tab: 'live',
      scope: 'all',
      locale: 'en',
      selectedLiveAgentKey: targetAgent.sessionKey,
      nowMs: now
    })
    assert.ok(htmlExpandedLive.includes('tp-io-monitor'))
    assert.ok(!htmlExpandedLive.includes('tp-io-live-dot'))
    assert.ok(htmlExpandedLive.includes('data-io-path="out-stroke"'))
    assert.ok(htmlExpandedLive.includes('data-io-path="in-stroke"'))
    assert.ok(htmlExpandedLive.includes('OpenAI · gpt-6.1-terra'))
    assert.ok(!htmlExpandedLive.includes('PulseBoard UI redesign'))
    const outIdx = htmlExpandedLive.indexOf('MODEL OUTPUT · REPLY RATE')
    const inIdx = htmlExpandedLive.indexOf('MODEL INPUT · CONTEXT RATE')
    assert.ok(outIdx > 0 && inIdx > outIdx, 'Model output must render above model input')
    assert.ok(!htmlExpandedLive.includes('↑ Output') && !htmlExpandedLive.includes('↓ Input'))

    assert.equal(formatTokens(1_250_000), '1.25M')
    assert.equal(formatUsd(12.345), '$12.35')

    // `#` ("井字號") prefixes in Orca tab titles MUST be preserved verbatim
    assert.equal(cleanConversationTitle('# 优化 skills'), '# 优化 skills')
    assert.equal(cleanConversationTitle('# orca plugins init'), '# orca plugins init')
    assert.equal(cleanConversationTitle('#QA'), '#QA')
    assert.equal(normalizeConfiguredModelSlug('Gemini 4 Carbon (Medium)'), 'gemini-4-carbon')
    assert.equal(normalizeConfiguredModelSlug('openai-codex/gpt-6.1-sol'), 'gpt-6.1-sol')

    // PTY terminal tab with `customTitle: "# 优化 skills"` + CLI `settings.json` model `gemini-4-carbon`
    const sCliAgy = createEmptySessionState(
      '6cf4f801-cli',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/6cf4f801-cli/.system_generated/logs/transcript.jsonl'
    )
    sCliAgy.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sCliAgy.titleHint = '确认 team-init 角色账号与 URL 询问流程'
    sCliAgy.createdAtMs = now - 3600_000
    sCliAgy.updatedAtMs = now - 2_000
    sCliAgy.turnsByKey.set('t-cli', {
      turnKey: 't-cli',
      timestampMs: now - 2_000,
      input: 2000,
      output: 1000,
      reasoning: 0,
      cacheRead: 10000,
      cacheWrite: 0,
      total: 13000,
      durationSec: 20,
      tps: 50,
      model: null,
      explicitCostUsd: null
    })

    const snapCli = buildDashboardSnapshot(
      [sCliAgy],
      createTestJournalIndex({
        ptyCustomTitles: new Map([
          ['repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391', '# 优化 skills']
        ]),
        terminalTabOverrides: [
          {
            ptyId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391',
            workspacePath: '/Users/dev/ai-engineering-workflow-skills',
            agent: 'antigravity',
            customTitle: '# 优化 skills',
            createdAt: now - 3605_000,
            lastFocusedAt: now - 1_000
          }
        ],
        cliConfiguredModels: { antigravity: 'gemini-4-carbon' }
      }),
      new PricingEngine(),
      {
        focusedId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
        focusedProject: 'ai-engineering-workflow-skills',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: '/Users/dev/ai-engineering-workflow-skills',
        knownWorkspaces: [
          {
            id: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
            project: 'ai-engineering-workflow-skills',
            name: 'main',
            path: '/Users/dev/ai-engineering-workflow-skills',
            branch: 'refs/heads/main'
          }
        ],
        liveAgents: [
          {
            terminalId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391',
            title: 'agy',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: now - 2_000
          }
        ]
      },
      now
    )

    assert.equal(snapCli.sessions.length, 1)
    assert.equal(snapCli.sessions[0].title, '# 优化 skills')
    assert.equal(snapCli.sessions[0].modelLabel, 'gemini-4-carbon')
    assert.equal(snapCli.live.agents[0].title, '# 优化 skills')
    assert.equal(snapCli.live.agents[0].modelLabel, 'gemini-4-carbon')

    // Regression: a completed CLI session (>45m old, `lastEventState === 'done'`) MUST NOT be hijacked
    // as `working` when Orca's `agents.list` reports a `terminalId: null` Structured Chat agent!
    const sCompletedOldCli = createEmptySessionState(
      '6cf4f801-closed',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/6cf4f801-closed/.system_generated/logs/transcript.jsonl'
    )
    sCompletedOldCli.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sCompletedOldCli.titleHint = '确认 team-init 角色账号与 URL 询问流程'
    sCompletedOldCli.createdAtMs = now - 7200_000
    sCompletedOldCli.updatedAtMs = now - 3500_000
    sCompletedOldCli.lastMtimeMs = now - 3500_000
    sCompletedOldCli.lastEventState = 'done'
    sCompletedOldCli.turnsByKey.set('t-old', {
      turnKey: 't-old',
      timestampMs: now - 3500_000,
      input: 4000,
      output: 900,
      reasoning: 0,
      cacheRead: 30000,
      cacheWrite: 0,
      total: 34900,
      durationSec: 18,
      tps: 50,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const sActiveNativeChat = createEmptySessionState(
      '808ad2e0-live',
      'antigravity',
      '/Users/dev/Library/Application Support/orca/antigravity-chat/antigravity-acp/brain/808ad2e0-live/.system_generated/logs/transcript.jsonl'
    )
    sActiveNativeChat.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sActiveNativeChat.createdAtMs = now - 600_000
    sActiveNativeChat.updatedAtMs = now - 4_000
    sActiveNativeChat.lastMtimeMs = now - 4_000
    sActiveNativeChat.lastEventState = 'working'
    sActiveNativeChat.turnsByKey.set('t-live', {
      turnKey: 't-live',
      timestampMs: now - 4_000,
      input: 1500,
      output: 420,
      reasoning: 0,
      cacheRead: 12000,
      cacheWrite: 0,
      total: 13920,
      durationSec: 7,
      tps: 60,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const snapNoFalseWorking = buildDashboardSnapshot(
      [sCompletedOldCli, sActiveNativeChat],
      createTestJournalIndex({
        byNativeId: new Map([
          [
            '808ad2e0-live',
            {
              orcaSessionId: 'orca-live-chat',
              nativeId: '808ad2e0-live',
              provider: 'antigravity',
              title: '评估并更新 README 和 CHANGELOG',
              workspacePath: '/Users/dev/ai-engineering-workflow-skills',
              model: 'gemini-4-carbon',
              updatedAt: now - 4_000,
              turnUpdatedAt: now - 60_000,
              isLiveLease: true,
              isTurnOpen: true,
              lastTurnState: 'open'
            }
          ]
        ])
      }),
      new PricingEngine(),
      {
        focusedId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
        focusedProject: 'ai-engineering-workflow-skills',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: '/Users/dev/ai-engineering-workflow-skills',
        knownWorkspaces: [],
        liveAgents: [
          {
            terminalId: null,
            title: '评估并更新 README 和 CHANGELOG',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: now - 60_000
          }
        ]
      },
      now
    )

    assert.ok(
      !snapNoFalseWorking.live.agents.some((a) => a.sessionKey === 'antigravity:6cf4f801-closed'),
      'Old completed CLI session must NOT appear in Live Monitor due to terminalId: null Structured Chat entry'
    )
    const closedSessionRow = snapNoFalseWorking.sessions.find((s) => s.sessionId === '6cf4f801-closed')
    assert.ok(closedSessionRow)
    assert.equal(closedSessionRow.active, false)
    assert.equal(snapNoFalseWorking.live.agents.length, 1)
    assert.equal(snapNoFalseWorking.live.agents[0].sessionKey, 'antigravity:808ad2e0-live')
    assert.equal(snapNoFalseWorking.live.agents[0].state, 'working')
  })
})

describe('Trusted Worker Integration, Left-Sidebar Focus Tracking & Host Contract Verification', () => {
  test('automatically switches focused Project -> Worktree when Orca left-sidebar activeWorktreeId changes, even with background agents running in another main worktree', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-home-'))
    try {
      const orcaDir = path.join(tmpHome, 'orca-data')
      const profileDir = path.join(orcaDir, 'profiles', 'local-default')
      const agBrainDir = path.join(
        orcaDir,
        'antigravity-chat',
        'antigravity-acp',
        'brain',
        'conv-1',
        '.system_generated',
        'logs'
      )
      fs.mkdirSync(profileDir, { recursive: true })
      fs.mkdirSync(agBrainDir, { recursive: true })

      fs.writeFileSync(
        path.join(orcaDir, 'orca-profile-index.json'),
        JSON.stringify({ schemaVersion: 1, activeProfileId: 'local-default' }),
        'utf8'
      )

      // Create synthetic Orca `profile-state.db` to simulate left-sidebar Project -> Worktree focus changes
      const req = createRequire(import.meta.url)
      const sqliteMod = req('node:sqlite') as {
        Database?: new (p: string) => {
          exec(sql: string): void
          prepare(sql: string): { run(...args: unknown[]): void }
          close(): void
        }
        DatabaseSync?: new (p: string) => {
          exec(sql: string): void
          prepare(sql: string): { run(...args: unknown[]): void }
          close(): void
        }
      }
      const SqliteCtor = sqliteMod.Database ?? sqliteMod.DatabaseSync!
      const profileDbPath = path.join(profileDir, 'profile-state.db')
      const setLeftSidebarFocus = (worktreeId: string) => {
        const db = new SqliteCtor(profileDbPath)
        db.exec(
          'CREATE TABLE IF NOT EXISTS profile_state_document_parts (domain TEXT NOT NULL, part_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (domain, part_key))'
        )
        db.prepare(
          'INSERT OR REPLACE INTO profile_state_document_parts (domain, part_key, payload) VALUES (?, ?, ?)'
        ).run('workspaceSession', '["activeWorktreeId"]', JSON.stringify(worktreeId))
        db.close()
      }

      // Initially focused on `PulseBoard / main` in Orca's left sidebar
      setLeftSidebarFocus('repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard')

      const sel = readOrcaActiveWorktreeSelection([orcaDir])
      assert.equal(sel.activeWorktreeId, 'repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard')
      assert.equal(sel.activeWorktreePath, '/Users/wilsonliu/ai-proj/PulseBoard')

      fs.writeFileSync(
        path.join(agBrainDir, 'transcript.jsonl'),
        `${JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          created_at: new Date().toISOString(),
          input_tokens: 1000,
          output_tokens: 200
        })}\n`,
        'utf8'
      )

      // Inode deduplication test
      const dupScanner = new TranscriptScanner({
        homeDir: tmpHome,
        orcaAppDirs: [orcaDir, orcaDir]
      })
      assert.equal(dupScanner.scan({ forceFullDiscovery: true }).length, 1)

      process.env.TOKEN_PULSE_HOME_DIR = tmpHome
      process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir

      const host = mockHost({
        settings: { pricingSyncHours: 6, livePollSeconds: 5 },
        results: {
          'workspace.list': () => ({
            workspaces: [
              {
                id: 'repo-orca::/Users/wilsonliu/orca/orca-token-used',
                kind: 'worktree',
                name: 'main',
                project: 'orca-token-used',
                path: '/Users/wilsonliu/orca/orca-token-used',
                branch: 'refs/heads/main',
                hostId: 'local'
              },
              {
                id: 'repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard',
                kind: 'worktree',
                name: 'main',
                project: 'PulseBoard',
                path: '/Users/wilsonliu/ai-proj/PulseBoard',
                branch: 'refs/heads/main',
                hostId: 'local'
              }
            ],
            truncated: false
          }),
          'workspace.readContext': () => ({
            branch: 'refs/heads/main',
            displayName: 'main',
            terminals: []
          }),
          'agents.list': () => ({ agents: [] }),
          'statusBar.update': () => ({ ok: true })
        }
      })

      const worker = await mountWorker(workerModule, { host })
      try {
        assert.deepEqual(worker.refusals, [])

        // 1) Left sidebar is on `PulseBoard / main` -> must resolve to `PulseBoard`
        const snapPulse = await worker.request('dashboard.get', { forceScan: false, locale: 'zh-TW' })
        assert.equal(snapPulse.workspace.project, 'PulseBoard')
        assert.equal(snapPulse.workspace.path, '/Users/wilsonliu/ai-proj/PulseBoard')

        // 2) Even if a background agent emits `agent.status.changed` in `orca-token-used / main`,
        //    left-sidebar focus on `PulseBoard / main` MUST NOT be hijacked!
        await worker.emit('agent.status.changed', {
          workspaceId: 'repo-orca::/Users/wilsonliu/orca/orca-token-used',
          paneKey: 'pane-bg',
          terminalId: 'repo-orca::/Users/wilsonliu/orca/orca-token-used@@pty1',
          state: 'working',
          title: 'Background Agent',
          receivedAt: Date.now()
        })
        const snapStillPulse = await worker.request('dashboard.get', { forceScan: false })
        assert.equal(snapStillPulse.workspace.project, 'PulseBoard')

        // 3) User clicks `orca-token-used -> main` in Orca's left navigation sidebar!
        setLeftSidebarFocus('repo-orca::/Users/wilsonliu/orca/orca-token-used')
        await worker.emit('workspace.changed', {
          context: { branch: 'refs/heads/main', displayName: 'main', terminals: [] }
        })

        const snapOrca = await worker.request('dashboard.get', { forceScan: false })
        assert.equal(snapOrca.workspace.project, 'orca-token-used')
        assert.equal(snapOrca.workspace.path, '/Users/wilsonliu/orca/orca-token-used')

        // 4) 1-second single-agent live poll (`agent.livePoll`) + `view.set` (`liveAgentKey`)
        const pollRes = await worker.request('agent.livePoll', {
          sessionKey: 'antigravity:conv-1'
        })
        assert.ok(pollRes.agent)
        assert.equal(pollRes.agent?.sessionKey, 'antigravity:conv-1')
        assert.equal(pollRes.agent?.outSeries.length, 60)
        assert.equal(pollRes.agent?.inSeries.length, 60)

        const viewState = await worker.request('view.set', {
          tab: 'live',
          liveAgentKey: 'antigravity:conv-1'
        })
        assert.equal(viewState.tab, 'live')
        assert.equal(viewState.liveAgentKey, 'antigravity:conv-1')

        const cmdOut = await worker.command('tokenPulse.refresh')
        assert.match(String(cmdOut), /Token Pulse refreshed/)

        const sbCalls = host.callsOf('statusBar.update')
        assert.ok(sbCalls.length >= 1)
        assert.deepEqual(worker.refusals, [])
      } finally {
        await worker.deactivate()
        delete process.env.TOKEN_PULSE_HOME_DIR
        delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

type TestSqliteHandle = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): void }
  close(): void
}

function openWritableTestSqlite(dbPath: string): TestSqliteHandle {
  const req = createRequire(import.meta.url)
  const sqliteMod = req('node:sqlite') as {
    Database?: new (p: string) => TestSqliteHandle
    DatabaseSync?: new (p: string) => TestSqliteHandle
  }
  const Ctor = sqliteMod.Database ?? sqliteMod.DatabaseSync
  if (!Ctor) throw new Error('node:sqlite constructor unavailable')
  return new Ctor(dbPath)
}

function writeTestProfileStateParts(
  profileDbPath: string,
  parts: Array<{ domain?: string; key: string; payload: unknown }>
): void {
  fs.mkdirSync(path.dirname(profileDbPath), { recursive: true })
  const db = openWritableTestSqlite(profileDbPath)
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS profile_state_document_parts (domain TEXT NOT NULL, part_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (domain, part_key))'
    )
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO profile_state_document_parts (domain, part_key, payload) VALUES (?, ?, ?)'
    )
    for (const p of parts) {
      stmt.run(p.domain ?? 'workspaceSession', p.key, JSON.stringify(p.payload))
    }
  } finally {
    db.close()
  }
}

function writeTestAntigravitySummariesDb(
  dbPath: string,
  rows: Array<{
    conversation_id: string
    title: string
    workspace_uris: string
    last_modified_time: string
    parent_conversation_id?: string
    nesting_depth?: number
  }>,
  parentLinks: Array<{ conversation_id: string; parent_conversation_id: string }> = []
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openWritableTestSqlite(dbPath)
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)'
    )
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const r of rows) {
      stmt.run(
        r.conversation_id,
        r.title,
        r.workspace_uris,
        r.last_modified_time,
        r.parent_conversation_id ?? '',
        r.nesting_depth ?? 0
      )
    }
    if (parentLinks.length > 0) {
      db.exec(
        'CREATE TABLE IF NOT EXISTS conversation_parents (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL)'
      )
      const pStmt = db.prepare(
        'INSERT OR REPLACE INTO conversation_parents (conversation_id, parent_conversation_id) VALUES (?, ?)'
      )
      for (const link of parentLinks) {
        pStmt.run(link.conversation_id, link.parent_conversation_id)
      }
    }
  } finally {
    db.close()
  }
}

describe('Terminal Tab & Handoff Title Synchronization Regressions', () => {
  test('resolves Antigravity CLI cwd from conversation_summaries.db and history.jsonl, merging #54 terminal tab into a single worktree card and filtering subagents', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ag-term-54-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'workspaces', 'qbibotlive', 'release-1.0')
      const otherRoot = path.join(tmpRoot, 'workspaces', 'unrelated-root')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(otherRoot, { recursive: true })

      const wtId = `repo-qbi::${wtPath}`
      const ptyId = `${wtId}@@pty54`
      const now = Date.UTC(2026, 10, 13, 1, 30, 0)

      writeTestProfileStateParts(path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db'), [
        { key: '["activeWorktreeId"]', payload: wtId },
        {
          key: `["tabsByWorktree",${JSON.stringify(wtId)}]`,
          payload: [
            {
              id: 'tab-54',
              ptyId,
              worktreeId: wtId,
              title: 'Terminal 1',
              defaultTitle: 'Terminal 1',
              customTitle: '#54',
              generatedTitle: null,
              launchAgent: 'antigravity',
              createdAt: now - 120_000
            }
          ]
        },
        {
          key: `["unifiedTabs",${JSON.stringify(wtId)}]`,
          payload: [
            {
              id: 'tab-54',
              contentType: 'terminal',
              entityId: ptyId,
              worktreeId: wtId,
              label: 'Terminal 1',
              customLabel: '#54',
              generatedLabel: null,
              lastFocusedAt: now - 5_000
            },
            {
              id: 'tab-54-browser',
              contentType: 'browser',
              entityId: ptyId,
              worktreeId: wtId,
              label: 'localhost:3000',
              customLabel: 'Browser Must Not Hijack',
              lastFocusedAt: now - 1_000
            }
          ]
        }
      ])

      // Authoritative summary in antigravity-cli + newer blank title in antigravity (must merge non-destructively)
      const wtUri = `file://${wtPath}`
      const otherUri = `file://${otherRoot}`
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: '228134bd-main',
            title: 'Issue #54 需求與問題釐清',
            workspace_uris: JSON.stringify([otherUri, wtUri]),
            last_modified_time: new Date(now - 30_000).toISOString(),
            parent_conversation_id: '',
            nesting_depth: 0
          },
          {
            conversation_id: 'sub-brain-99',
            title: 'Codebase Subagent Audit',
            workspace_uris: JSON.stringify([wtUri]),
            last_modified_time: new Date(now - 20_000).toISOString(),
            parent_conversation_id: '228134bd-main',
            nesting_depth: 1
          }
        ]
      )
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db'),
        [
          {
            conversation_id: '228134bd-main',
            title: '',
            workspace_uris: '[]',
            last_modified_time: new Date(now - 5_000).toISOString(),
            parent_conversation_id: '',
            nesting_depth: 0
          }
        ]
      )

      // History tail entry for a brand-new turn-1 conversation before conversation_summaries.db flushes
      const agCliDir = path.join(homeDir, '.gemini', 'antigravity-cli')
      fs.writeFileSync(
        path.join(agCliDir, 'history.jsonl'),
        `${JSON.stringify({
          timestamp: now - 8_000,
          workspace: wtPath,
          display: '請幫我檢查 release-1.0 設定'
        })}\n`,
        'utf8'
      )

      const writeAgTranscript = (
        convId: string,
        prompt: string,
        createdMs: number,
        inTok: number,
        outTok: number
      ) => {
        const logDir = path.join(agCliDir, 'brain', convId, '.system_generated', 'logs')
        fs.mkdirSync(logDir, { recursive: true })
        const p = path.join(logDir, 'transcript.jsonl')
        fs.writeFileSync(
          p,
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              created_at: new Date(createdMs).toISOString(),
              content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'IN_PROGRESS',
              created_at: new Date(createdMs + 3_000).toISOString(),
              model: 'gemini-4-carbon',
              input_tokens: inTok,
              output_tokens: outTok,
              cache_read_tokens: 1000
            })
          ].join('\n') + '\n',
          'utf8'
        )
        const mtimeSec = (createdMs + 4_000) / 1000
        fs.utimesSync(p, mtimeSec, mtimeSec)
      }

      writeAgTranscript(
        '228134bd-main',
        '请你看一下issue #54 我沒有看懂他講的是什麼意思。需求是什麼？',
        now - 60_000,
        4000,
        500
      )
      writeAgTranscript('sub-brain-99', 'Audit child task', now - 40_000, 2000, 300)
      writeAgTranscript('turn1-history-only', '請幫我檢查 release-1.0 設定', now - 7_500, 1000, 100)

      const scanner = new TranscriptScanner({ homeDir, orcaAppDirs: [orcaDir] })
      scanner.setKnownWorkspacePaths([wtPath])
      const sessions = scanner.scan({ forceFullDiscovery: true, now })
      const journal = scanner.getJournalIndex()

      const snap = buildDashboardSnapshot(
        sessions,
        journal,
        new PricingEngine(),
        {
          focusedId: wtId,
          focusedProject: 'qbibotlive',
          focusedName: 'release-1.0',
          focusedBranch: 'release-1.0',
          focusedPath: wtPath,
          knownWorkspaces: [
            {
              id: wtId,
              project: 'qbibotlive',
              name: 'release-1.0',
              path: wtPath,
              branch: 'refs/heads/release-1.0'
            }
          ],
          liveAgents: [
            {
              terminalId: ptyId,
              title: 'Terminal 1',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            }
          ]
        },
        now
      )

      // Must NOT split into an unbound `Terminal 1` (0 tok) card + `local` card!
      assert.ok(
        !snap.live.agents.some((a) => a.title === 'Terminal 1' && a.tokens.total === 0),
        'Active terminal PTY must bind to #54 Antigravity CLI transcript without leaving a 0-tok phantom card'
      )
      const card54 = snap.live.agents.find((a) => a.sessionKey === 'antigravity:228134bd-main')
      assert.ok(card54, 'Expected #54 session card in Live Monitor')
      assert.equal(card54.title, '#54')
      assert.equal(card54.projectName, 'qbibotlive')
      assert.equal(card54.workspaceName, 'release-1.0')
      assert.equal(card54.tokens.total, 5500)

      // Subagent must be excluded from user sessions/live cards, yet included in worktree period token totals
      assert.ok(!snap.sessions.some((s) => s.sessionId === 'sub-brain-99'))
      assert.ok(!snap.live.agents.some((a) => a.sessionKey.includes('sub-brain-99')))
      assert.equal(snap.periods.worktree.day.tokens.total, 5500 + 3300 + 2100)

      // Turn-1 session without summary DB row resolves worktree via history.jsonl
      const turn1Row = snap.sessions.find((s) => s.sessionId === 'turn1-history-only')
      assert.ok(turn1Row, 'Expected turn-1 history-matched session in focused worktree sessions')
      assert.equal(turn1Row.workspaceName, 'release-1.0')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('synchronizes Chat UI -> Terminal handoff generatedTitle, filters boilerplate handoff generatedTitle, and updates on customTitle rename', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-handoff-title-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtA = path.join(tmpRoot, 'ws', 'proj-a')
      const wtB = path.join(tmpRoot, 'ws', 'proj-b')
      fs.mkdirSync(wtA, { recursive: true })
      fs.mkdirSync(wtB, { recursive: true })

      const wtIdA = `repo-a::${wtA}`
      const wtIdB = `repo-b::${wtB}`
      const ptyA = `${wtIdA}@@ptyA`
      const ptyB = `${wtIdB}@@ptyB`
      const now = Date.UTC(2026, 10, 13, 1, 35, 0)
      const profileDbPath = path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db')

      writeTestProfileStateParts(profileDbPath, [
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdA)}]`,
          payload: [
            {
              id: 'tab-handoff-a',
              ptyId: ptyA,
              worktreeId: wtIdA,
              title: 'agy',
              defaultTitle: 'Terminal 1',
              customTitle: null,
              generatedTitle: 'Token 流速圖表 UI/UX 重新設計',
              launchAgent: 'antigravity',
              createdAt: now - 90_000
            }
          ]
        },
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdB)}]`,
          payload: [
            {
              id: 'tab-handoff-b',
              ptyId: ptyB,
              worktreeId: wtIdB,
              title: 'agy',
              defaultTitle: 'Terminal 1',
              customTitle: null,
              generatedTitle: 'Continue work from the prior Orca',
              launchAgent: 'claude',
              createdAt: now - 90_000
            }
          ]
        }
      ])

      const sHandoffA = createEmptySessionState('handoff-a', 'antigravity', '/tmp/handoff-a.jsonl')
      sHandoffA.cwd = wtA
      applyAntigravityLines(sHandoffA, [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: new Date(now - 85_000).toISOString(),
          content:
            'Continue work from the prior Orca session.\nSession: #debug 2\n\nNew instructions: redesign chart'
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'IN_PROGRESS',
          created_at: new Date(now - 10_000).toISOString(),
          model: 'gemini-4-carbon',
          input_tokens: 1200,
          output_tokens: 300
        })
      ])

      const sHandoffB = createEmptySessionState('handoff-b', 'claude', '/tmp/handoff-b.jsonl')
      sHandoffB.cwd = wtB
      applyClaudeLines(sHandoffB, [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(now - 80_000).toISOString(),
          cwd: wtB,
          message: {
            content:
              'Continue work from the prior Orca session.\nSession: 真實交接摘要標題\n\nPlease finish tests.'
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - 8_000).toISOString(),
          message: {
            id: 'msg-b1',
            model: 'claude-sonnet-4-6',
            stop_reason: 'tool_use',
            usage: { input_tokens: 800, output_tokens: 200 }
          }
        })
      ])

      const journal1 = readOrcaJournalIndex([orcaDir], homeDir)
      const snap1 = buildDashboardSnapshot(
        [sHandoffA, sHandoffB],
        journal1,
        new PricingEngine(),
        {
          focusedName: null,
          focusedBranch: null,
          focusedPath: null,
          liveAgents: [
            {
              terminalId: ptyA,
              title: 'agy',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            },
            {
              terminalId: ptyB,
              title: 'claude',
              agent: 'claude',
              state: 'working',
              stateStartedAt: now - 8_000
            }
          ]
        },
        now
      )

      const cardA1 = snap1.live.agents.find((a) => a.sessionKey === 'antigravity:handoff-a')
      const cardB1 = snap1.live.agents.find((a) => a.sessionKey === 'claude:handoff-b')
      assert.equal(cardA1?.title, 'Token 流速圖表 UI/UX 重新設計')
      assert.equal(
        cardB1?.title,
        '真實交接摘要標題',
        'Boilerplate "Continue work from the prior Orca" generatedTitle must fall through to real session summary'
      )

      // User renames Tab A to `# handoff-fix` -> customTitle supersedes generatedTitle
      writeTestProfileStateParts(profileDbPath, [
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdA)}]`,
          payload: [
            {
              id: 'tab-handoff-a',
              ptyId: ptyA,
              worktreeId: wtIdA,
              title: 'agy',
              defaultTitle: 'Terminal 1',
              customTitle: '# handoff-fix',
              generatedTitle: 'Token 流速圖表 UI/UX 重新設計',
              launchAgent: 'antigravity',
              createdAt: now - 90_000
            }
          ]
        }
      ])

      const journal2 = readOrcaJournalIndex([orcaDir], homeDir)
      const snap2 = buildDashboardSnapshot(
        [sHandoffA, sHandoffB],
        journal2,
        new PricingEngine(),
        {
          focusedName: null,
          focusedBranch: null,
          focusedPath: null,
          liveAgents: [
            {
              terminalId: ptyA,
              title: 'agy',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            }
          ]
        },
        now
      )
      const cardA2 = snap2.live.agents.find((a) => a.sessionKey === 'antigravity:handoff-a')
      assert.equal(cardA2?.title, '# handoff-fix')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('shows rawTabLabel ("Terminal 1") on 0-tok unrenamed terminal when la.title is "agy", then transitions to summary and resolves terminal: livePoll key', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-plain-term-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'ws', 'plain-repo')
      fs.mkdirSync(wtPath, { recursive: true })

      const wtId = `repo-plain::${wtPath}`
      const ptyId = `${wtId}@@pty-plain`
      const now = Date.UTC(2026, 10, 13, 1, 40, 0)

      writeTestProfileStateParts(path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db'), [
        {
          key: `["tabsByWorktree",${JSON.stringify(wtId)}]`,
          payload: [
            {
              id: 'tab-plain',
              ptyId,
              worktreeId: wtId,
              title: 'Terminal 1',
              defaultTitle: 'Terminal 1',
              customTitle: null,
              generatedTitle: null,
              launchAgent: 'antigravity',
              createdAt: now - 30_000
            }
          ]
        }
      ])

      const journal = readOrcaJournalIndex([orcaDir], homeDir)
      const runtime = {
        focusedId: wtId,
        focusedProject: 'plain-repo',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: [
          {
            terminalId: ptyId,
            title: 'agy',
            agent: 'antigravity',
            state: 'working' as const,
            stateStartedAt: now - 5_000
          }
        ]
      }

      // 0-tok state before any conversation turn exists
      const snap0 = buildDashboardSnapshot([], journal, new PricingEngine(), runtime, now)
      assert.equal(snap0.live.agents.length, 1)
      assert.equal(snap0.live.agents[0].title, 'Terminal 1')
      assert.equal(snap0.live.agents[0].sessionKey, `terminal:${ptyId}`)

      // First turn arrives -> transitions from "Terminal 1" to conversation summary, and terminal:<ptyId> livePoll still resolves it
      const sTurn1 = createEmptySessionState('plain-conv-1', 'antigravity', '/tmp/plain-conv-1.jsonl')
      sTurn1.cwd = wtPath
      sTurn1.titleHint = '修正 Terminal 標題同步問題'
      sTurn1.createdAtMs = now - 25_000
      sTurn1.updatedAtMs = now - 2_000
      sTurn1.lastMtimeMs = now - 2_000
      sTurn1.lastEventState = 'working'
      sTurn1.turnsByKey.set('t1', {
        turnKey: 't1',
        timestampMs: now - 2_000,
        input: 900,
        output: 180,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1080,
        durationSec: 3,
        tps: 60,
        model: 'gemini-4-carbon',
        explicitCostUsd: null
      })

      const snap1 = buildDashboardSnapshot([sTurn1], journal, new PricingEngine(), runtime, now)
      assert.equal(snap1.live.agents.length, 1)
      assert.equal(snap1.live.agents[0].title, '修正 Terminal 標題同步問題')

      const polledViaTerminalKey = pollSingleLiveAgent(
        `terminal:${ptyId}`,
        [sTurn1],
        journal,
        new PricingEngine(),
        runtime,
        now
      )
      assert.ok(polledViaTerminalKey, 'pollSingleLiveAgent must seamlessly transition terminal:<ptyId> key')
      assert.equal(polledViaTerminalKey.sessionKey, 'antigravity:plain-conv-1')
      assert.equal(polledViaTerminalKey.title, '修正 Terminal 標題同步問題')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('isolates parallel same-agent terminal tabs in one worktree regardless of lastFocusedAt and hands tab title forward across sequential sessions in one tab', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-multi-seq-term-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtParallel = path.join(tmpRoot, 'ws', 'parallel-repo')
      const wtSeq = path.join(tmpRoot, 'ws', 'seq-repo')
      fs.mkdirSync(wtParallel, { recursive: true })
      fs.mkdirSync(wtSeq, { recursive: true })

      const wtIdPar = `repo-par::${wtParallel}`
      const wtIdSeq = `repo-seq::${wtSeq}`
      const now = Date.UTC(2026, 10, 13, 1, 45, 0)

      writeTestProfileStateParts(path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db'), [
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdPar)}]`,
          payload: [
            {
              id: 'tab-par-1',
              ptyId: `${wtIdPar}@@pty1`,
              worktreeId: wtIdPar,
              title: 'agy',
              defaultTitle: 'Terminal 1',
              customTitle: '# tab-1',
              launchAgent: 'antigravity',
              createdAt: now - 120_000
            },
            {
              id: 'tab-par-2',
              ptyId: `${wtIdPar}@@pty2`,
              worktreeId: wtIdPar,
              title: 'agy',
              defaultTitle: 'Terminal 2',
              customTitle: '# tab-2',
              launchAgent: 'antigravity',
              createdAt: now - 60_000
            }
          ]
        },
        {
          key: `["unifiedTabs",${JSON.stringify(wtIdPar)}]`,
          payload: [
            {
              id: 'tab-par-1',
              contentType: 'terminal',
              entityId: `${wtIdPar}@@pty1`,
              worktreeId: wtIdPar,
              customLabel: '# tab-1',
              // Tab 1 was refocused MORE recently than Tab 2 — must NOT steal Tab 2's session!
              lastFocusedAt: now - 1_000
            },
            {
              id: 'tab-par-2',
              contentType: 'terminal',
              entityId: `${wtIdPar}@@pty2`,
              worktreeId: wtIdPar,
              customLabel: '# tab-2',
              lastFocusedAt: now - 50_000
            }
          ]
        },
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdSeq)}]`,
          payload: [
            {
              id: 'tab-seq-only',
              ptyId: `${wtIdSeq}@@pty-seq`,
              worktreeId: wtIdSeq,
              title: 'agy',
              defaultTitle: 'Terminal 1',
              customTitle: '# single-tab',
              launchAgent: 'antigravity',
              createdAt: now - 180_000
            }
          ]
        },
        {
          key: `["unifiedTabs",${JSON.stringify(wtIdSeq)}]`,
          payload: [
            {
              id: 'tab-seq-only',
              contentType: 'terminal',
              entityId: `${wtIdSeq}@@pty-seq`,
              worktreeId: wtIdSeq,
              customLabel: '# single-tab',
              lastFocusedAt: now - 2_000
            }
          ]
        }
      ])

      const makeSession = (
        id: string,
        cwd: string,
        hint: string,
        createdAtMs: number,
        updatedAtMs: number,
        done = false
      ) => {
        const s = createEmptySessionState(id, 'antigravity', `/tmp/${id}.jsonl`)
        s.cwd = cwd
        s.titleHint = hint
        s.createdAtMs = createdAtMs
        s.updatedAtMs = updatedAtMs
        s.lastMtimeMs = updatedAtMs
        s.lastEventState = done ? 'done' : 'working'
        s.turnsByKey.set('t1', {
          turnKey: 't1',
          timestampMs: updatedAtMs,
          input: 500,
          output: 100,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 600,
          durationSec: 2,
          tps: 50,
          model: 'gemini-4-carbon',
          explicitCostUsd: null
        })
        return s
      }

      const sPar1 = makeSession('par-s1', wtParallel, 'Parallel prompt 1', now - 118_000, now - 90_000)
      const sPar2 = makeSession('par-s2', wtParallel, 'Parallel prompt 2', now - 58_000, now - 10_000)
      const sSeqOld = makeSession('seq-old', wtSeq, '第一輪舊任務', now - 175_000, now - 120_000, true)
      const sSeqNew = makeSession('seq-new', wtSeq, '第二輪新任務', now - 40_000, now - 5_000, false)

      const journal = readOrcaJournalIndex([orcaDir], homeDir)
      const snapPar = buildDashboardSnapshot(
        [sPar1, sPar2],
        journal,
        new PricingEngine(),
        { focusedName: 'main', focusedBranch: 'main', focusedPath: wtParallel, liveAgents: [] },
        now
      )
      assert.equal(snapPar.sessions.find((s) => s.sessionId === 'par-s1')?.title, '# tab-1')
      assert.equal(snapPar.sessions.find((s) => s.sessionId === 'par-s2')?.title, '# tab-2')

      const snapSeq = buildDashboardSnapshot(
        [sSeqOld, sSeqNew],
        journal,
        new PricingEngine(),
        { focusedName: 'main', focusedBranch: 'main', focusedPath: wtSeq, liveAgents: [] },
        now
      )
      assert.equal(
        snapSeq.sessions.find((s) => s.sessionId === 'seq-new')?.title,
        '# single-tab',
        'Active second CLI session in the same terminal tab must inherit the tab title'
      )
      assert.equal(
        snapSeq.sessions.find((s) => s.sessionId === 'seq-old')?.title,
        '第一輪舊任務',
        'Exited first CLI session in the same terminal tab must revert to its conversation summary'
      )

      // Part C: An older renamed tab (`# tab-1` at t0, 0 turns) must NOT steal a session spawned in a newer unrenamed `Terminal 2` (t0 + 60s)
      const wtMixed = path.join(tmpRoot, 'ws', 'mixed-repo')
      fs.mkdirSync(wtMixed, { recursive: true })
      const wtIdMixed = `repo-mix::${wtMixed}`
      const mixedProfileDb = path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db')
      writeTestProfileStateParts(mixedProfileDb, [
        {
          key: `["tabsByWorktree",${JSON.stringify(wtIdMixed)}]`,
          payload: [
            {
              id: 'tab-mix-1',
              ptyId: `${wtIdMixed}@@pty-m1`,
              worktreeId: wtIdMixed,
              title: 'Terminal 1',
              defaultTitle: 'Terminal 1',
              customTitle: '# idle-renamed-tab',
              launchAgent: 'antigravity',
              createdAt: now - 120_000
            },
            {
              id: 'tab-mix-2',
              ptyId: `${wtIdMixed}@@pty-m2`,
              worktreeId: wtIdMixed,
              title: 'Terminal 2',
              defaultTitle: 'Terminal 2',
              customTitle: null,
              generatedTitle: null,
              launchAgent: 'antigravity',
              createdAt: now - 60_000
            }
          ]
        }
      ])
      const sMix2 = makeSession(
        'mix-s2',
        wtMixed,
        'Unrenamed tab 2 prompt',
        now - 58_000,
        now - 5_000,
        false
      )
      const journalMixed = readOrcaJournalIndex([orcaDir], homeDir)
      const snapMixed = buildDashboardSnapshot(
        [sMix2],
        journalMixed,
        new PricingEngine(),
        { focusedName: 'main', focusedBranch: 'main', focusedPath: wtMixed, liveAgents: [] },
        now
      )
      assert.equal(
        snapMixed.sessions.find((s) => s.sessionId === 'mix-s2')?.title,
        'Unrenamed tab 2 prompt',
        'Older renamed 0-turn tab must not steal session spawned inside newer unrenamed Terminal 2'
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('hydrates late conversation_summaries.db flush on unchanged transcript during pollHotFiles and distinguishes Claude /rename cliCustomTitle', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-late-flush-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'ws', 'late-repo')
      fs.mkdirSync(wtPath, { recursive: true })
      const now = Date.UTC(2026, 10, 13, 1, 50, 0)

      const logDir = path.join(
        homeDir,
        '.gemini',
        'antigravity-cli',
        'brain',
        'late-conv',
        '.system_generated',
        'logs'
      )
      fs.mkdirSync(logDir, { recursive: true })
      const transcriptPath = path.join(logDir, 'transcript.jsonl')
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            created_at: new Date(now - 10_000).toISOString(),
            content: '<USER_REQUEST>Initial prompt before DB flush</USER_REQUEST>'
          }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'IN_PROGRESS',
            created_at: new Date(now - 5_000).toISOString(),
            model: 'gemini-4-carbon',
            input_tokens: 600,
            output_tokens: 120
          })
        ].join('\n') + '\n',
        'utf8'
      )

      const scanner = new TranscriptScanner({ homeDir, orcaAppDirs: [orcaDir] })
      const initial = scanner.scan({ forceFullDiscovery: true, now })
      assert.equal(initial.length, 1)
      assert.equal(initial[0].cwd, null)

      // Now conversation_summaries.db flushes WITHOUT any new bytes written to transcript.jsonl!
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: 'late-conv',
            title: 'Late Flushed Summary',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 1_000).toISOString()
          }
        ]
      )

      scanner.refreshJournal(now + 1_000, 0)
      const afterHotPoll = scanner.pollHotFiles(now + 1_000, 'antigravity:late-conv')
      assert.equal(afterHotPoll[0].cwd, wtPath)

      // Verify Claude /rename cliCustomTitle beats stale journal title when no terminal tab override exists
      const sClaude = createEmptySessionState('claude-renamed', 'claude', '/tmp/claude-renamed.jsonl')
      applyClaudeLines(sClaude, [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(now - 20_000).toISOString(),
          cwd: wtPath,
          customTitle: '/rename 後的新名稱',
          message: { content: 'Old prompt text' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - 15_000).toISOString(),
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 100 }
          }
        })
      ])

      const snapClaude = buildDashboardSnapshot(
        [sClaude],
        createTestJournalIndex({
          byNativeId: new Map([
            [
              'claude-renamed',
              {
                orcaSessionId: 'orca-c1',
                nativeId: 'claude-renamed',
                provider: 'claude',
                title: '舊的 Journal 標題',
                workspacePath: wtPath,
                model: 'claude-sonnet-4-6',
                updatedAt: now - 20_000,
                isLiveLease: false,
                isTurnOpen: false,
                lastTurnState: 'settled'
              }
            ]
          ])
        }),
        new PricingEngine(),
        { focusedName: 'late-repo', focusedBranch: 'main', focusedPath: wtPath, liveAgents: [] },
        now
      )
      assert.equal(snapClaude.sessions[0]?.title, '/rename 後的新名稱')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refreshes terminal tab rename via worker workspace.changed settle pass and preserves live agent workspacePath across short terminalIds', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-rename-'))
    try {
      const orcaDir = path.join(tmpHome, 'orca-data')
      const profileDbPath = path.join(orcaDir, 'profiles', 'local-default', 'profile-state.db')
      const wtPath = path.join(tmpHome, 'workspaces', 'token-pulse-repo')
      const otherWtPath = path.join(tmpHome, 'workspaces', 'other-repo')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(otherWtPath, { recursive: true })
      fs.mkdirSync(path.dirname(profileDbPath), { recursive: true })
      fs.writeFileSync(
        path.join(orcaDir, 'orca-profile-index.json'),
        JSON.stringify({ schemaVersion: 1, activeProfileId: 'local-default' }),
        'utf8'
      )

      const wtId = `repo-tp::${wtPath}`
      const shortTabId = 'tab-short-pty'
      const now = Date.now()

      const setTabCustomTitle = (customTitle: string) => {
        writeTestProfileStateParts(profileDbPath, [
          { key: '["activeWorktreeId"]', payload: wtId },
          {
            key: `["tabsByWorktree",${JSON.stringify(wtId)}]`,
            payload: [
              {
                id: shortTabId,
                ptyId: shortTabId,
                worktreeId: wtId,
                title: 'agy',
                defaultTitle: 'Terminal 1',
                customTitle,
                launchAgent: 'antigravity',
                createdAt: now - 60_000
              }
            ]
          }
        ])
      }

      setTabCustomTitle('# initial-tab')

      writeTestAntigravitySummariesDb(
        path.join(tmpHome, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: 'live-rename-conv',
            title: 'Summary Fallback',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 5_000).toISOString()
          },
          {
            conversation_id: 'other-newer-conv',
            title: 'Other Repo Task',
            workspace_uris: JSON.stringify([`file://${otherWtPath}`]),
            last_modified_time: new Date(now - 1_000).toISOString()
          }
        ]
      )
      const writeConv = (id: string, createdOffsetMs: number) => {
        const logDir = path.join(
          tmpHome,
          '.gemini',
          'antigravity-cli',
          'brain',
          id,
          '.system_generated',
          'logs'
        )
        fs.mkdirSync(logDir, { recursive: true })
        fs.writeFileSync(
          path.join(logDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              created_at: new Date(now - 20_000).toISOString(),
              content: `<USER_REQUEST>Task ${id}</USER_REQUEST>`
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'IN_PROGRESS',
              created_at: new Date(now - createdOffsetMs).toISOString(),
              model: 'gemini-4-carbon',
              input_tokens: 1000,
              output_tokens: 250
            })
          ].join('\n') + '\n',
          'utf8'
        )
      }
      writeConv('live-rename-conv', 4_000)
      writeConv('other-newer-conv', 1_000)

      process.env.TOKEN_PULSE_HOME_DIR = tmpHome
      process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir

      const host = mockHost({
        settings: { pricingSyncHours: 6, livePollSeconds: 10 },
        results: {
          'workspace.list': () => ({
            workspaces: [
              {
                id: wtId,
                kind: 'worktree',
                name: 'main',
                project: 'token-pulse-repo',
                path: wtPath,
                branch: 'refs/heads/main',
                hostId: 'local'
              }
            ],
            truncated: false
          }),
          'workspace.readContext': () => ({
            branch: 'refs/heads/main',
            displayName: 'main',
            terminals: [{ id: shortTabId, title: 'agy' }]
          }),
          'agents.list': () => ({
            agents: [
              {
                terminalId: shortTabId,
                title: 'agy',
                agent: 'antigravity',
                state: 'working',
                stateStartedAt: now - 3_000
              }
            ]
          }),
          'statusBar.update': () => ({ ok: true })
        }
      })

      const worker = await mountWorker(workerModule, { host })
      try {
        await worker.emit('agent.status.changed', {
          workspaceId: wtId,
          paneKey: 'pane-1',
          terminalId: shortTabId,
          state: 'working',
          title: 'agy',
          receivedAt: Date.now()
        })

        const snapBefore = await worker.request('dashboard.get', { forceScan: true })
        const cardBefore = snapBefore.live.agents.find(
          (a) => a.sessionKey === 'antigravity:live-rename-conv'
        )
        assert.equal(cardBefore?.title, '# initial-tab')
        assert.equal(cardBefore?.workspaceName, 'main')

        // Simulate debounced Orca tab rename flushing into profile-state.db 350ms after workspace.changed fires
        const postsBefore = worker.posts.length
        await worker.emit('workspace.changed', {
          context: {
            branch: 'refs/heads/main',
            displayName: 'main',
            terminals: [{ id: shortTabId, title: 'agy' }]
          }
        })
        setTimeout(() => {
          setTabCustomTitle('# renamed-live')
        }, 350)

        await new Promise((resolve) => setTimeout(resolve, 1100))

        // Must have pushed a post-flush `dashboard.updated` event automatically without requiring a panel RPC
        const pushedSnapshots = worker.posts
          .slice(postsBefore)
          .filter((p) => p.event === 'dashboard.updated')
          .map((p) => p.payload as import('./protocol').DashboardSnapshot)
        const latestPushedCard = pushedSnapshots[pushedSnapshots.length - 1]?.live.agents.find(
          (a) => a.sessionKey === 'antigravity:live-rename-conv'
        )
        assert.equal(latestPushedCard?.title, '# renamed-live')

        const pollAfter = await worker.request('agent.livePoll', {
          sessionKey: 'antigravity:live-rename-conv'
        })
        assert.equal(pollAfter.agent?.title, '# renamed-live')
        assert.deepEqual(worker.refusals, [])
      } finally {
        await worker.deactivate()
        delete process.env.TOKEN_PULSE_HOME_DIR
        delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  test('publish-plugin.sh dirty-worktree allowlist accepts *-plan.md without staging plan files into release commits', () => {
    const scriptPath = path.resolve(import.meta.dirname, '..', 'scripts', 'publish-plugin.sh')
    const scriptText = fs.readFileSync(scriptPath, 'utf8')
    const caseBlockMatch = scriptText.match(
      /while IFS= read -r line; do[\s\S]*?done < <\(git status --porcelain\)/
    )
    assert.ok(caseBlockMatch, 'Expected git status --porcelain guard loop in publish-plugin.sh')
    const loopBody = caseBlockMatch[0].replace(
      'done < <(git status --porcelain)',
      'done <<< "$MOCK_PORCELAIN"'
    )

    // Positive check: *-plan.md and src/* pass cleanly
    execFileSync('bash', ['-euo', 'pipefail', '-c', loopBody], {
      env: {
        ...process.env,
        MOCK_PORCELAIN: '?? terminal-tab-title-sync-plan.md\n M src/journal.ts'
      }
    })

    // Negative control: unexpected file fails closed with exit code 1
    assert.throws(() => {
      execFileSync('bash', ['-euo', 'pipefail', '-c', loopBody], {
        env: { ...process.env, MOCK_PORCELAIN: '?? unexpected-scratch.tmp' },
        stdio: 'pipe'
      })
    })

    // Ensure release staging `git add` never stages arbitrary *-plan.md files
    const gitAddLine = scriptText
      .split('\n')
      .find((line) => line.trim().startsWith('git add -A --'))
    assert.ok(gitAddLine, 'Expected git add release line in publish-plugin.sh')
    assert.ok(!gitAddLine.includes('*-plan.md'))
  })
})

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { win32 } from 'node:path'
import { cleanConversationTitle, isGenericTerminalTabLabel } from './journal'

const MAC_ORCA_BIN = '/Applications/Orca.app/Contents/Resources/bin/orca'

function buildOrcaCliEnv(): Record<string, string | undefined> {
  if (process.platform !== 'win32') return process.env
  const hasUserDataPath = Boolean(process.env.ORCA_USER_DATA_PATH?.trim())
  const hasAppData = Object.entries(process.env).some(
    ([key, value]) => key.toUpperCase() === 'APPDATA' && Boolean(value?.trim())
  )
  if (hasUserDataPath || hasAppData) return process.env
  const home = os.homedir().trim() || process.env.USERPROFILE?.trim() || process.env.HOME?.trim()
  if (!home) return process.env
  return { ...process.env, APPDATA: win32.join(home, 'AppData', 'Roaming') }
}

export function resolveOrcaExecutable(
  override = process.env.ORCA_BIN,
  platform = process.platform,
  execPath = process.execPath
): string {
  if (override?.trim()) {
    return override.trim()
  }
  if (platform === 'win32') {
    // Orca forks trusted workers with its desktop executable.
    return win32.join(win32.dirname(execPath), 'resources', 'bin', 'orca.exe')
  }
  return 'orca'
}

function execFileJson(bin: string, args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        killSignal: 'SIGTERM',
        env: buildOrcaCliEnv()
      },
      (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(
            new Error(
              `Invalid JSON from Orca CLI: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
            )
          )
        }
      }
    )
  })
}

export async function runOrcaJson(args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const primary = resolveOrcaExecutable()
  try {
    return await execFileJson(primary, args, signal, timeoutMs)
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (
      code === 'ENOENT' &&
      primary === 'orca' &&
      process.platform === 'darwin' &&
      fs.existsSync(MAC_ORCA_BIN)
    ) {
      return await execFileJson(MAC_ORCA_BIN, args, signal, timeoutMs)
    }
    throw err
  }
}

export function parseOrcaTabTitles(payload: unknown): Map<string, string> {
  const titles = new Map<string, string>()
  const ambiguous = new Set<string>()
  const response = payload as { ok?: boolean; result?: { visualLayouts?: unknown[] } } | null
  if (!response?.ok || !Array.isArray(response.result?.visualLayouts)) return titles

  function visit(value: unknown, tab?: { id: string; title: string }): void {
    if (typeof value !== 'object' || !value) return
    if (Array.isArray(value)) {
      for (const child of value) visit(child, tab)
      return
    }
    const node = value as Record<string, unknown>
    if ('panes' in node && typeof node.tabId === 'string') {
      const title = cleanConversationTitle(node.title)
      visit(node.panes, title && !isGenericTerminalTabLabel(title) ? { id: node.tabId, title } : undefined)
      return
    }
    if (node.type === 'terminal') {
      if (tab && node.tabId === tab.id && typeof node.handle === 'string' && node.connected === true) {
        if (titles.has(node.handle) && titles.get(node.handle) !== tab.title) ambiguous.add(node.handle)
        else titles.set(node.handle, tab.title)
      }
      return
    }
    for (const child of Object.values(node)) visit(child, tab)
  }

  for (const layout of response.result.visualLayouts) {
    if (layout && typeof layout === 'object' && 'root' in layout) visit(layout.root)
  }
  for (const handle of ambiguous) titles.delete(handle)
  return titles
}

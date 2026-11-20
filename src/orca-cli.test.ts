import os from 'node:os'
import path, { win32 } from 'node:path'
import { assert, test } from 'orca/testing'
import { parseOrcaTabTitles, resolveOrcaExecutable, runOrcaJson } from './orca-cli'

test('joins custom tab labels to their exact connected terminal handles', () => {
  const pane = (handle: string, tabId: string, connected = true) => ({
    type: 'terminal', handle, tabId, title: 'agy', connected
  })
  const payload = { ok: true, result: { visualLayouts: [{ root: {
    type: 'group',
    tabs: [
      { tabId: 'tab-a', title: '#64', panes: pane('term-a', 'tab-a') },
      { tabId: 'tab-b', title: '#66', panes: {
        type: 'pane-split',
        first: pane('term-b1', 'tab-b'),
        second: pane('term-b2', 'tab-b')
      } },
      { tabId: 'tab-c', title: 'Terminal 12', panes: pane('term-generic', 'tab-c') },
      { tabId: 'tab-d', title: '#Other', panes: pane('term-closed', 'tab-d', false) },
      { tabId: 'tab-e', title: '#Wrong', panes: pane('term-other-tab', 'tab-a') },
      { tabId: 'tab-f', title: '#First', panes: pane('term-conflict', 'tab-f') },
      { tabId: 'tab-g', title: '#Second', panes: pane('term-conflict', 'tab-g') }
    ]
  } }] } }
  assert.deepEqual([...parseOrcaTabTitles(payload)], [
    ['term-a', '#64'], ['term-b1', '#66'], ['term-b2', '#66']
  ])
  assert.equal(parseOrcaTabTitles({ ok: false }).size, 0)
})

test('selects the bundled Windows CLI even when the desktop exe has the same name', () => {
  const desktop = String.raw`D:\Orca Preview\Orca.exe`
  const cli = String.raw`D:\Orca Preview\resources\bin\orca.exe`
  assert.equal(resolveOrcaExecutable('', 'win32', desktop), cli)
  assert.equal(resolveOrcaExecutable(' custom-cli ', 'win32', desktop), 'custom-cli')
  assert.equal(resolveOrcaExecutable('', 'darwin', desktop), 'orca')
})

test('restores default Windows APPDATA for child CLI when stripped while preserving explicit overrides', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const envKeys = ['ORCA_BIN', 'HOME', 'USERPROFILE', 'ORCA_USER_DATA_PATH', 'ELECTRON_RUN_AS_NODE']
  const savedEnv = new Map<string, string | undefined>()
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key])
  }
  const savedAppDataEntries = Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'APPDATA')

  const childScript = [
    'if (!process.env.ORCA_USER_DATA_PATH && !process.env.APPDATA) process.exit(1);',
    'process.stdout.write(JSON.stringify({',
    '  ok: true,',
    '  appData: process.env.APPDATA ?? null,',
    '  userData: process.env.ORCA_USER_DATA_PATH ?? null',
    '}));'
  ].join(' ')

  const fakeHome = path.join(os.tmpdir(), 'orca-win-home-test')
  const expectedAppData = win32.join(fakeHome, 'AppData', 'Roaming')
  const customAppData = path.join(os.tmpdir(), 'orca-custom-appdata')
  const customUserData = path.join(os.tmpdir(), 'orca-custom-userdata')

  const runProbe = async () =>
    (await runOrcaJson(['-e', childScript], new AbortController().signal, 5000)) as {
      ok: boolean
      appData: string | null
      userData: string | null
    }

  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.ORCA_BIN = process.execPath
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.ELECTRON_RUN_AS_NODE = process.env.ELECTRON_RUN_AS_NODE ?? '1'

    for (const [key] of savedAppDataEntries) {
      delete process.env[key]
    }
    delete process.env.ORCA_USER_DATA_PATH

    const fallback = await runProbe()
    assert.equal(fallback.ok, true)
    assert.equal(fallback.appData, expectedAppData)
    assert.equal(fallback.userData, null)

    process.env.APPDATA = customAppData
    const withAppData = await runProbe()
    assert.equal(withAppData.appData, customAppData)
    assert.equal(withAppData.userData, null)

    delete process.env.APPDATA
    process.env.ORCA_USER_DATA_PATH = customUserData
    const withUserData = await runProbe()
    assert.equal(withUserData.appData, null)
    assert.equal(withUserData.userData, customUserData)
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const [key] of Object.entries(process.env)) {
      if (key.toUpperCase() === 'APPDATA') delete process.env[key]
    }
    for (const [key, value] of savedAppDataEntries) {
      if (value !== undefined) process.env[key] = value
    }
  }
})

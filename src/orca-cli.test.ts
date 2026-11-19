import { assert, test } from 'orca/testing'
import { parseOrcaTabTitles } from './orca-cli'

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

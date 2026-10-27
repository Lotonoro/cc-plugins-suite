import { expect, test } from 'claude-code/testing'
import { closedPane, isPaneOpen, paneAlarm, PANE, resizePane, syncPane, togglePane } from './pane'

// The engine's ui calls the pane makes, answered as the engine answers them: each open is recorded and listed in the engine's record of
// open panes, each close removes it. `refuse` makes an open throw, `unplaced` makes it come back unplaced, `refuseClose` makes a close throw, `listed` is the record at the
// start, as a reload leaves it.
const engine = (doc: { refuse?: boolean; unplaced?: boolean; listed?: string[]; refuseClose?: boolean } = {}) => {
  const rec = { opens: [] as any[], closes: [] as any[] }
  const shown = new Set<string>(doc.listed ?? [])
  const $ = {
    ui: {
      open: async (e: any) => {
        rec.opens.push(e)
        if (doc.refuse === true) throw new Error('open refused')
        if (doc.unplaced === true) return { isPlaced: false, reason: 'no room' }
        shown.add(e.id)
        return { isPlaced: true }
      },
      close: async (e: any) => {
        rec.closes.push(e)
        if (doc.refuseClose === true) throw new Error('close refused')
        shown.delete(e.id)
      },
      panes: async () => [...shown].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
    },
  }
  return { $: $ as any, rec }
}

const SIZE = { rows: 3, columns: 40 }
const WIDER = { rows: 4, columns: 60 }
const REFUSED = 'the details pane did not open; see the debug log'

test('a toggle with the pane shut opens it at the rows and columns asked, titled and closed by Esc', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  expect(rec.opens).toEqual([{ id: PANE, title: 'Prompt cache', rows: 3, columns: 40, closeOnEscape: true }])
  expect(isPaneOpen()).toBe(true)
})

test('a toggle with the pane open closes it, and the next toggle opens it again', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  await togglePane($, SIZE)
  expect(rec.closes).toEqual([{ id: PANE }])
  expect(isPaneOpen()).toBe(false)
  await togglePane($, SIZE)
  expect(rec.opens.map((o) => o.id)).toEqual([PANE, PANE])
  expect(isPaneOpen()).toBe(true)
})

test('a close the person made clears the flag, so the next toggle opens the pane', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  closedPane(PANE, 'person')
  expect(isPaneOpen()).toBe(false)
  await togglePane($, SIZE)
  expect(rec.opens.length).toBe(2)
  expect(rec.closes).toEqual([])
})

test("the engine's report of the mod's own close leaves an open made since as open", async () => {
  const { $ } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  await togglePane($, SIZE)
  await togglePane($, SIZE)
  // The ui.close the first close raised, heard after the open that followed it: the flag was cleared by the close itself.
  closedPane(PANE, 'plugin')
  expect(isPaneOpen()).toBe(true)
})

test("a close of another pane leaves this one's flag as it is", async () => {
  const { $ } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  closedPane('some-other-pane', 'person')
  expect(isPaneOpen()).toBe(true)
})

test('a resize with the pane open re-opens it at the new size, and an unchanged size opens nothing', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  await resizePane($, SIZE)
  expect(rec.opens.length).toBe(1)
  await resizePane($, WIDER)
  expect(rec.opens[1]).toMatchObject({ id: PANE, rows: 4, columns: 60 })
  expect(rec.closes).toEqual([])
})

test('a resize with the pane shut opens nothing', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await resizePane($, WIDER)
  expect(rec.opens).toEqual([])
})

test('the engine\'s record of the pane says it is open after a reload, and the next toggle closes it', async () => {
  const { $, rec } = engine({ listed: [PANE] })
  await syncPane($)
  expect(isPaneOpen()).toBe(true)
  await togglePane($, SIZE)
  expect(rec.opens).toEqual([])
  expect(rec.closes).toEqual([{ id: PANE }])
})

test('an open the engine refuses clears the flag, is named until an open lands, and the next toggle opens again', async () => {
  const doc = { refuse: true }
  const { $, rec } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE).catch(() => {})
  expect(isPaneOpen()).toBe(false)
  expect(paneAlarm()).toBe(REFUSED)
  doc.refuse = false
  await togglePane($, SIZE)
  expect(paneAlarm()).toBeNull()
  expect(rec.opens.length).toBe(2)
})

test('an open the engine does not place is named the same way', async () => {
  const { $ } = engine({ unplaced: true })
  await syncPane($)
  await togglePane($, SIZE).catch(() => {})
  expect(isPaneOpen()).toBe(false)
  expect(paneAlarm()).toBe(REFUSED)
})

test('a close that is refused leaves the pane counted open, so the next toggle closes it again', async () => {
  const doc = { refuseClose: true }
  const { $, rec } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  await togglePane($, SIZE).catch(() => {})
  expect(isPaneOpen()).toBe(true)
  doc.refuseClose = false
  await togglePane($, SIZE)
  expect(rec.closes.length).toBe(2)
  expect(isPaneOpen()).toBe(false)
})

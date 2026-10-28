import { expect, test } from 'claude-code/testing'
import { isPaneOpen, paneAlarm, PANE, readPane, resizePane, syncPane, togglePane } from './pane'

// The engine's ui calls the pane makes, answered as the engine answers them: each open is recorded and listed in the engine's record of
// open panes, each close removes it. `refuse` makes an open throw, `unplaced` makes it come back unplaced, `refuseClose` makes a close throw, `listed` is the record at the
// start, as a reload leaves it. `keepOnClose` makes a close resolve with the pane still listed, as another plugin's refusal does; `unplacedList`
// lists the pane as not placed; `panesThrow` makes the read of the record throw. `gate` holds the next read of the record: the read takes its record
// when it is made and resolves only when the gate's promise does. `holdOpens` and `holdCloses` hold each open or close, in the order made, until its promise
// resolves: the call is out, and its effect on the record lands only then.
const engine = (doc: { refuse?: boolean; unplaced?: boolean; listed?: string[]; refuseClose?: boolean; keepOnClose?: boolean; unplacedList?: boolean; panesThrow?: boolean; gate?: Promise<void>; holdOpens?: Promise<void>[]; holdCloses?: Promise<void>[] } = {}) => {
  const rec = { opens: [] as any[], closes: [] as any[], logs: [] as string[] }
  const shown = new Set<string>(doc.listed ?? [])
  const $ = {
    ui: {
      log: (text: string) => rec.logs.push(text),
      open: async (e: any) => {
        rec.opens.push(e)
        await doc.holdOpens?.shift()
        if (doc.refuse === true) throw new Error('open refused')
        if (doc.unplaced === true) return { isPlaced: false, reason: 'no room' }
        shown.add(e.id)
        return { isPlaced: true }
      },
      close: async (e: any) => {
        rec.closes.push(e)
        await doc.holdCloses?.shift()
        if (doc.refuseClose === true) throw new Error('close refused')
        if (doc.keepOnClose !== true) shown.delete(e.id)
      },
      panes: async () => {
        if (doc.panesThrow === true) throw new Error('read refused')
        const record = [...shown].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: doc.unplacedList !== true }))
        const gate = doc.gate
        doc.gate = undefined
        if (gate !== undefined) await gate
        return record
      },
    },
  }
  return { $: $ as any, rec, shown }
}

// A promise the test releases by hand, for a read the engine answers late.
const deferred = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return { promise, release }
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

test('a read of the record puts the flag right: open when the pane is listed and placed, shut when it is not listed', async () => {
  const { $, shown } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  // The person closes it; the mod hears nothing.
  shown.delete(PANE)
  expect(isPaneOpen()).toBe(true)
  await readPane($)
  expect(isPaneOpen()).toBe(false)
  shown.add(PANE)
  await readPane($)
  expect(isPaneOpen()).toBe(true)
})

test('a read started while the pane is shut and still pending when a toggle opens it leaves the pane open when it resolves unlisted, so the next toggle closes', async () => {
  const doc: { gate?: Promise<void> } = {}
  const { $, rec } = engine(doc)
  await syncPane($)
  const late = deferred()
  doc.gate = late.promise
  // The record is taken now, before the open, so it does not list the pane.
  const read = readPane($)
  await togglePane($, SIZE)
  expect(isPaneOpen()).toBe(true)
  late.release()
  await read
  expect(isPaneOpen()).toBe(true)
  await togglePane($, SIZE)
  expect(rec.opens.length).toBe(1)
  expect(rec.closes).toEqual([{ id: PANE }])
  expect(isPaneOpen()).toBe(false)
})

test('a read started while the pane is open and still pending when a toggle closes it leaves the pane shut when it resolves listed, so the next toggle opens', async () => {
  const doc: { gate?: Promise<void> } = {}
  const { $, rec } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  const late = deferred()
  doc.gate = late.promise
  // The record is taken now, before the close, so it lists the pane as placed.
  const read = readPane($)
  await togglePane($, SIZE)
  expect(isPaneOpen()).toBe(false)
  late.release()
  await read
  expect(isPaneOpen()).toBe(false)
  await togglePane($, SIZE)
  expect(rec.opens.length).toBe(2)
  expect(rec.closes).toEqual([{ id: PANE }])
  expect(isPaneOpen()).toBe(true)
})

test('a read started while an open is pending and returned before it settles, with a record not listing the pane, leaves the pane open', async () => {
  const doc: { gate?: Promise<void>; holdOpens?: Promise<void>[] } = {}
  const { $ } = engine(doc)
  await syncPane($)
  const held = deferred()
  doc.holdOpens = [held.promise]
  const open = togglePane($, SIZE)
  const late = deferred()
  doc.gate = late.promise
  const read = readPane($)
  late.release()
  await read
  expect(isPaneOpen()).toBe(true)
  held.release()
  await open
  expect(isPaneOpen()).toBe(true)
})

test('a read started while an open is pending and returned after it settles, with a record not listing the pane, leaves the pane open', async () => {
  const doc: { gate?: Promise<void>; holdOpens?: Promise<void>[] } = {}
  const { $ } = engine(doc)
  await syncPane($)
  const held = deferred()
  doc.holdOpens = [held.promise]
  const open = togglePane($, SIZE)
  const late = deferred()
  doc.gate = late.promise
  const read = readPane($)
  held.release()
  await open
  expect(isPaneOpen()).toBe(true)
  late.release()
  await read
  expect(isPaneOpen()).toBe(true)
})

test('a read started while a close is pending and returned before it settles, with a record listing the pane, leaves the pane shut', async () => {
  const doc: { gate?: Promise<void>; holdCloses?: Promise<void>[] } = {}
  const { $ } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  const held = deferred()
  doc.holdCloses = [held.promise]
  const close = togglePane($, SIZE)
  const late = deferred()
  doc.gate = late.promise
  const read = readPane($)
  late.release()
  await read
  expect(isPaneOpen()).toBe(false)
  held.release()
  await close
  expect(isPaneOpen()).toBe(false)
})

test('a read started while a close is pending and returned after it settles, with a record listing the pane, leaves the pane shut', async () => {
  const doc: { gate?: Promise<void>; holdCloses?: Promise<void>[] } = {}
  const { $ } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  const held = deferred()
  doc.holdCloses = [held.promise]
  const close = togglePane($, SIZE)
  const late = deferred()
  doc.gate = late.promise
  const read = readPane($)
  held.release()
  await close
  expect(isPaneOpen()).toBe(false)
  late.release()
  await read
  expect(isPaneOpen()).toBe(false)
})

test('with two of the mod\'s own calls out, the first call\'s read after it settles leaves the flag, and the second call\'s read after it settles puts it right', async () => {
  const doc: { holdOpens?: Promise<void>[]; unplacedList?: boolean } = {}
  const { $ } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  const first = deferred()
  const second = deferred()
  doc.holdOpens = [first.promise, second.promise]
  const one = resizePane($, WIDER)
  const two = resizePane($, SIZE)
  expect(isPaneOpen()).toBe(true)
  // The record now lists the pane as not placed, so a read that applied would shut the flag.
  doc.unplacedList = true
  first.release()
  await one
  expect(isPaneOpen()).toBe(true)
  second.release()
  await two
  expect(isPaneOpen()).toBe(false)
})

test('a read still pending with no write in between sets the flag from its record: open when listed and placed, shut when not listed', async () => {
  const doc: { gate?: Promise<void> } = {}
  const { $, shown } = engine(doc)
  await syncPane($)
  expect(isPaneOpen()).toBe(false)
  shown.add(PANE)
  const listed = deferred()
  doc.gate = listed.promise
  const read = readPane($)
  listed.release()
  await read
  expect(isPaneOpen()).toBe(true)
  shown.delete(PANE)
  const unlisted = deferred()
  doc.gate = unlisted.promise
  const again = readPane($)
  unlisted.release()
  await again
  expect(isPaneOpen()).toBe(false)
})

test('after the person closes the pane, the next toggle opens it', async () => {
  const { $, rec, shown } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  shown.delete(PANE)
  await readPane($)
  await togglePane($, SIZE)
  expect(rec.opens.length).toBe(2)
  expect(rec.closes).toEqual([])
})

test('a close another plugin keeps from happening leaves the pane counted open, so the next toggle closes again', async () => {
  const doc = { keepOnClose: true }
  const { $, rec } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  await togglePane($, SIZE)
  expect(isPaneOpen()).toBe(true)
  doc.keepOnClose = false
  await togglePane($, SIZE)
  expect(rec.closes.length).toBe(2)
  expect(rec.opens.length).toBe(1)
  expect(isPaneOpen()).toBe(false)
})

test('a pane listed but not placed counts as shut, and counts as open once it is placed', async () => {
  const doc = { listed: [PANE], unplacedList: true }
  const { $, rec } = engine(doc)
  await syncPane($)
  expect(isPaneOpen()).toBe(false)
  await togglePane($, SIZE)
  expect(rec.opens.length).toBe(1)
  doc.unplacedList = false
  await readPane($)
  expect(isPaneOpen()).toBe(true)
  await togglePane($, SIZE)
  expect(rec.closes).toEqual([{ id: PANE }])
})

test('a read that fails leaves the flag as it stands and is thrown to the caller', async () => {
  const doc = { panesThrow: false }
  const { $ } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  doc.panesThrow = true
  await expect(readPane($)).rejects.toThrow('read refused')
  expect(isPaneOpen()).toBe(true)
})

test('a read after the mod\'s own open or close that fails is reported, apart from the call, which is not held back', async () => {
  const doc = { panesThrow: false }
  const { $, rec } = engine(doc)
  const got = () => rec.logs.filter((l) => l.includes('read refused'))
  await syncPane($)
  doc.panesThrow = true
  await togglePane($, SIZE)
  expect(got().length).toBe(1)
  expect(isPaneOpen()).toBe(true)
  await togglePane($, SIZE)
  expect(got().length).toBe(2)
  expect(rec.closes).toEqual([{ id: PANE }])
  expect(isPaneOpen()).toBe(false)
})

test('a read that fails after an open that failed reports only the read, and the open still throws its own error', async () => {
  const { $, rec } = engine({ refuse: true, panesThrow: true })
  await expect(togglePane($, SIZE)).rejects.toThrow('open refused')
  expect(rec.logs.filter((l) => l.includes('read refused')).length).toBe(1)
  expect(isPaneOpen()).toBe(false)
})

test('an open that fails while the pane stays listed and placed leaves it counted open, at the size it was asked', async () => {
  const doc = { refuse: false }
  const { $, rec } = engine(doc)
  await syncPane($)
  await togglePane($, SIZE)
  doc.refuse = true
  await resizePane($, WIDER).catch(() => {})
  expect(isPaneOpen()).toBe(true)
  expect(rec.opens.length).toBe(2)
  // The same size is not asked again; the tick does not re-open each second.
  await resizePane($, WIDER)
  await resizePane($, WIDER)
  expect(rec.opens.length).toBe(2)
})

test('a sync makes the size unknown, so the next resize re-opens the pane once', async () => {
  const { $, rec } = engine()
  await syncPane($)
  await togglePane($, SIZE)
  await syncPane($)
  expect(isPaneOpen()).toBe(true)
  await resizePane($, SIZE)
  expect(rec.opens.length).toBe(2)
  await resizePane($, SIZE)
  expect(rec.opens.length).toBe(2)
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

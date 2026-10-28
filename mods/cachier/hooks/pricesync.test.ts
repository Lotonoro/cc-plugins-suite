import { describe, expect, test } from 'claude-code/testing'
import { PRICES, PRICING_URL, type Rates } from './prices'
import { dueAtMs, type PriceRecord } from './pricelist'
import { priceCheck, priceList, priceReady, priceSync } from './pricesync'

const HOUR = 3600000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const T = Date.parse('2026-10-18T10:00:00.000Z')

const rates = (input: number, read: number): Rates => ({ input, read, write5m: input * 1.25, write1h: input * 2, above: null })
const R1 = rates(4e-6, 0.4e-6)
const R2 = rates(2e-6, 0.1e-6)
const model = (r: Rates) => ({ rates: r, changedMs: null, missingSinceMs: null })
const record = (models: Record<string, ReturnType<typeof model>> = {}, o: Partial<PriceRecord> = {}): PriceRecord => ({
  models,
  lastSuccessMs: null,
  lastChangeMs: null,
  attempt: null,
  ...o,
})
const answer = (text: string, status = 200) => ({ status, ok: status < 300, headers: {}, text })
// A per-token rate to billionths of a dollar, so a parsed page rate compares exactly.
const perBillion = (n: number) => Math.round(n * 1e9)

const page = (rows: readonly [name: string, input: string, read: string][]) =>
  [
    '## Model pricing',
    '',
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ...rows.map(([name, input, read]) => {
      const i = Number(input)
      return `| Claude ${name} | $${input} / MTok | $${i * 1.25} / MTok | $${i * 2} / MTok | $${read} / MTok | $50 / MTok |`
    }),
    '',
  ].join('\n')
// Opus 5.5 at four dollars input and forty cents read, so the page's read rate is twice the built-in one.
const PAGE_OPUS = page([['Opus 5.5', '4', '0.40']])
// Sonnet 5.5, a model the other page does not list.
const PAGE_SONNET = page([['Sonnet 5.5', '2', '0.10']])
const NO_TABLE = '# Not the page'

type Config = {
  fetch: () => Promise<{ status: number; ok: boolean; headers: object; text: string }>
  getGate?: (nth: number) => Promise<void> | undefined
  getThrows: boolean
  denySet?: (call: { key: string; value: unknown; nth: number }) => boolean
}
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error('the condition never held')
}

// The engine's store, clock, page and debug log, as pricesync reads them.
const makeWorld = (o: { store?: Record<string, unknown>; fetch?: Config['fetch']; getThrows?: boolean } = {}) => {
  let now = T
  const values = new Map<string, unknown>(Object.entries(o.store ?? {}))
  const gets: string[] = []
  const writes: { key: string; value: unknown }[] = []
  const logs: string[] = []
  const fetches: string[] = []
  const timers = new Set<{ cb: () => void }>()
  let setCount = 0
  const config: Config = {
    fetch: o.fetch ?? (async () => answer(PAGE_OPUS)),
    getThrows: o.getThrows ?? false,
  }
  const dollar = {
    store: {
      get: async (key: string) => {
        gets.push(key)
        const hold = config.getGate?.(gets.length)
        if (hold !== undefined) await hold
        if (config.getThrows) throw new Error('store read refused')
        return values.get(key)
      },
      set: async (key: string, value: unknown) => {
        setCount++
        writes.push({ key, value })
        if (config.denySet?.({ key, value, nth: setCount }) === true) throw new Error('store write refused')
        values.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
    http: {
      fetch: async (url: string) => {
        fetches.push(url)
        return config.fetch()
      },
    },
    clock: {
      now: async () => now,
      after: (ms: number, cb: () => void) => {
        const timer = { cb }
        timers.add(timer)
        return { cancel: () => void timers.delete(timer) }
      },
    },
    ui: { log: (text: string) => void logs.push(text) },
  }
  return {
    dollar,
    values,
    gets,
    writes,
    logs,
    fetches,
    config,
    advance: (ms: number) => {
      now += ms
    },
    fireTimers: () => {
      for (const timer of [...timers]) {
        timers.delete(timer)
        timer.cb()
      }
    },
    stored: () => values.get('prices') as PriceRecord | undefined,
  }
}

describe('ready and list: the record is read once, and its rates are in force', () => {
  test('ready reads the shared record once, and before one exists the built-in table prices', async () => {
    const w = makeWorld()
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    expect(w.gets).toEqual(['prices'])
    expect(priceList(sync)['claude-opus-5-5']).toEqual(PRICES['claude-opus-5-5'])
    await priceReady(sync, w.dollar as any)
    expect(w.gets.length).toBe(1)
  })

  test('a stored record prices its models, and a model only the built-in table lists keeps its built-in rates', async () => {
    const w = makeWorld({ store: { prices: record({ m: model(R1) }, { lastSuccessMs: T }) } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    expect(priceList(sync).m).toEqual(R1)
    expect(priceList(sync)['claude-opus-5-5']).toEqual(PRICES['claude-opus-5-5'])
  })

  test('a store that cannot be read logs why and prices the built-in table', async () => {
    const w = makeWorld({ getThrows: true })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    expect(priceList(sync)).toEqual(PRICES)
    expect(w.logs.join('\n')).toContain('store read refused')
  })

  test('a stored value that is not a record prices the built-in table and is replaced by the next read', async () => {
    const w = makeWorld({ store: { prices: 'not a record' } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    expect(priceList(sync)).toEqual(PRICES)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([PRICING_URL])
    expect(perBillion(w.stored()!.models['claude-opus-5-5']!.rates.read)).toBe(400)
  })
})

describe('check: the shared schedule', () => {
  test('a newest success six days old reads nothing; seven days old reads once', async () => {
    const six = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - 6 * DAY }) } })
    const sync = priceSync()
    await priceReady(sync, six.dollar as any)
    await priceCheck(sync, six.dollar as any)
    expect(six.fetches).toEqual([])
    expect(six.writes).toEqual([])

    const seven = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const due = priceSync()
    await priceReady(due, seven.dollar as any)
    await priceCheck(due, seven.dollar as any)
    expect(seven.fetches).toEqual([PRICING_URL])
    const held = seven.stored()!
    expect(held.attempt).toMatchObject({ stampMs: T, outcome: 'success', failures: 0 })
    expect(held.lastSuccessMs).toBe(T)
  })

  test('a due check stamps before the read, then writes the outcome and the list together', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.writes.map((write) => (write.value as PriceRecord).attempt?.outcome)).toEqual([null, 'success'])
    const held = w.stored()!
    expect(perBillion(held.models['claude-opus-5-5']!.rates.read)).toBe(400)
    expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
  })

  test('a reload reads the stored record and fetches the page only if a read is due', async () => {
    for (const [days, reads] of [[6, 0], [7, 1]] as const) {
      const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - days * DAY }) } })
      const sync = priceSync()
      await priceReady(sync, w.dollar as any)
      await priceCheck(sync, w.dollar as any)
      expect(w.fetches.length).toBe(reads)
    }
  })

  test('a second session checking after the first stamp landed makes no fetch', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const first = priceSync()
    const second = priceSync()
    await priceReady(first, w.dollar as any)
    await priceCheck(first, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    await priceReady(second, w.dollar as any)
    await priceCheck(second, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    expect(perBillion(priceList(second)['claude-opus-5-5']!.read)).toBe(400)
  })

  test('a copy over a minute old is re-read, so another session stamp stops the read', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    w.advance(61000)
    w.values.set('prices', record({}, {
      lastSuccessMs: T + 61000,
      attempt: { stampMs: T + 61000, outcome: null, failures: 0, previous: 'success' },
    }))
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    expect(w.gets.length).toBe(2)
  })

  test('a fifty-second-old copy due on its own is re-read before the stamp, and the other stamp stops it', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    w.advance(50000)
    w.values.set('prices', record({}, {
      lastSuccessMs: T + 50000,
      attempt: { stampMs: T + 50000, outcome: null, failures: 0, previous: 'success' },
    }))
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
  })

  test('a record written by one session is in force in another within about two minutes, without a reload', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const writer = priceSync()
    const reader = priceSync()
    await priceReady(reader, w.dollar as any)
    expect(perBillion(priceList(reader)['claude-opus-5-5']!.read)).toBe(200)
    await priceReady(writer, w.dollar as any)
    await priceCheck(writer, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    expect(perBillion(priceList(reader)['claude-opus-5-5']!.read)).toBe(200)
    w.advance(61000)
    await priceCheck(reader, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    expect(perBillion(priceList(reader)['claude-opus-5-5']!.read)).toBe(400)
  })

  test('a first read that fails as unreachable keeps the built-in table, retries in an hour, then a day later', async () => {
    const w = makeWorld({ fetch: async () => answer('oops', 503) })
    const sync = priceSync()
    await priceCheck(sync, w.dollar as any)
    expect(priceList(sync)).toEqual(PRICES)
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'unreachable', failures: 1 })
    w.advance(HOUR - 1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    w.advance(1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(2)
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'unreachable', failures: 2 })
    w.advance(DAY - 1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(2)
    w.advance(1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(3)
  })

  test('a stamp left with no outcome reads again an hour later', async () => {
    const w = makeWorld({
      store: {
        prices: record({}, {
          lastSuccessMs: T - WEEK,
          attempt: { stampMs: T, outcome: null, failures: 0, previous: 'success' },
        }),
      },
    })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    w.advance(HOUR)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([PRICING_URL])
  })

  test('a check that cannot read the store makes no fetch', async () => {
    const w = makeWorld({ getThrows: true })
    const sync = priceSync()
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    expect(w.logs.join('\n')).toContain('store read refused')
  })
})

describe('check: two sessions, and one read per session at a time', () => {
  test('two sessions that both read in the same moment leave one whole list holding every model either read listed', async () => {
    const both = deferred<void>()
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    w.config.getGate = (nth) => (nth === 3 || nth === 4 ? both.promise : undefined)
    const reads = [deferred<ReturnType<typeof answer>>(), deferred<ReturnType<typeof answer>>()]
    let read = 0
    w.config.fetch = () => reads[read++]!.promise
    const first = priceSync()
    const second = priceSync()
    const one = priceCheck(first, w.dollar as any)
    const two = priceCheck(second, w.dollar as any)
    await until(() => w.gets.length === 4)
    both.resolve()
    await until(() => w.fetches.length === 2)
    reads[0]!.resolve(answer(PAGE_OPUS))
    await one
    reads[1]!.resolve(answer(PAGE_SONNET))
    await two
    const held = w.stored()!
    expect(Object.keys(held.models).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(perBillion(held.models['claude-opus-5-5']!.rates.read)).toBe(400)
    expect(perBillion(held.models['claude-sonnet-5-5']!.rates.read)).toBe(100)
  })

  test('two calls in one session while a read runs make one read, and the switch shares its result', async () => {
    const gate = deferred<ReturnType<typeof answer>>()
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) }, fetch: () => gate.promise })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    const scheduled = priceCheck(sync, w.dollar as any)
    await until(() => w.fetches.length === 1)
    const switched = priceCheck(sync, w.dollar as any, true)
    gate.resolve(answer(PAGE_OPUS))
    await Promise.all([scheduled, switched])
    expect(w.fetches.length).toBe(1)
    expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
  })

  test('a read landing after another session added a model keeps that model, marked missing', async () => {
    const gate = deferred<ReturnType<typeof answer>>()
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) }, fetch: () => gate.promise })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    const reading = priceCheck(sync, w.dollar as any)
    await until(() => w.fetches.length === 1)
    w.values.set('prices', record({ other: model(R2) }, { lastSuccessMs: T - WEEK }))
    gate.resolve(answer(PAGE_OPUS))
    await reading
    const held = w.stored()!
    expect(held.models.other).toEqual({ rates: R2, changedMs: null, missingSinceMs: T })
    expect(perBillion(held.models['claude-opus-5-5']!.rates.read)).toBe(400)
  })

  test("a stamp written after another session's list write keeps that list whole", async () => {
    const loadGate = deferred<void>()
    const fetchGate = deferred<ReturnType<typeof answer>>()
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) }, fetch: () => fetchGate.promise })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    // The due check's fresh re-read is held while another session's list write lands.
    w.config.getGate = (nth) => (nth === 2 ? loadGate.promise : undefined)
    const reading = priceCheck(sync, w.dollar as any)
    await until(() => w.gets.length === 2)
    w.values.set('prices', record({ other: model(R2) }, { lastSuccessMs: T - WEEK }))
    loadGate.resolve()
    await until(() => w.writes.length === 1)
    const stamped = w.writes[0]!.value as PriceRecord
    expect(stamped.models.other).toEqual(model(R2))
    expect(stamped.attempt).toMatchObject({ stampMs: T, outcome: null })
    fetchGate.resolve(answer(PAGE_OPUS))
    await reading
    expect(w.stored()!.models.other).toBeDefined()
  })

  test("a read that lands after another session's stamp keeps that stamp and advances the newest success", async () => {
    const fetchGate = deferred<ReturnType<typeof answer>>()
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) }, fetch: () => fetchGate.promise })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    const reading = priceCheck(sync, w.dollar as any)
    await until(() => w.fetches.length === 1)
    // The other session's stamp lands while this page read is in flight.
    w.advance(5000)
    const otherStamp = record({}, {
      lastSuccessMs: T - WEEK,
      attempt: { stampMs: T + 5000, outcome: null, failures: 0, previous: 'success' },
    })
    w.values.set('prices', otherStamp)
    fetchGate.resolve(answer(PAGE_OPUS))
    await reading
    const held = w.stored()!
    expect(held.attempt).toEqual(otherStamp.attempt)
    expect(held.lastSuccessMs).toBe(T + 5000)
    expect(held.models['claude-opus-5-5']).toBeDefined()
  })

  test("a read whose re-read is refused after its fetch writes nothing, and another session's newer stamp stands", async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    const otherStamp = record({}, {
      lastSuccessMs: T - WEEK,
      attempt: { stampMs: T + 5000, outcome: null, failures: 0, previous: 'success' },
    })
    w.config.fetch = async () => {
      // The other session's stamp lands while this page read is in flight, and the store refuses the re-read after it.
      w.advance(5000)
      w.values.set('prices', otherStamp)
      w.config.getThrows = true
      return answer(PAGE_OPUS)
    }
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([PRICING_URL])
    expect(w.writes.map((write) => (write.value as PriceRecord).attempt?.outcome)).toEqual([null])
    expect(w.stored()!.attempt).toEqual(otherStamp.attempt)
    expect(w.logs.join('\n')).toContain('store read refused')
  })
})

describe('check: a switch to dollars reads at once', () => {
  test('it reads with a fresh success, a standing stamp, and after a format failure', async () => {
    const states: PriceRecord[] = [
      record({}, { lastSuccessMs: T, attempt: { stampMs: T, outcome: 'success', failures: 0, previous: null } }),
      record({}, { lastSuccessMs: T, attempt: { stampMs: T + 1000, outcome: null, failures: 0, previous: 'success' } }),
      record({}, { lastSuccessMs: T, attempt: { stampMs: T + 1000, outcome: 'format', failures: 1, previous: 'success' } }),
    ]
    for (const held of states) {
      const w = makeWorld({ store: { prices: held } })
      const sync = priceSync()
      await priceReady(sync, w.dollar as any)
      await priceCheck(sync, w.dollar as any)
      expect(w.fetches).toEqual([])
      await priceCheck(sync, w.dollar as any, true)
      expect(w.fetches).toEqual([PRICING_URL])
      expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
    }
  })

  test('a refused stamp does not stop a switch from reading, and its figures redraw when the read lands', async () => {
    const w = makeWorld({
      store: { prices: record({}, { lastSuccessMs: T - WEEK }) },
      fetch: async () => answer(PAGE_OPUS),
    })
    w.config.denySet = ({ value }) => (value as PriceRecord).attempt?.outcome === null
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    await priceCheck(sync, w.dollar as any, true)
    expect(w.fetches).toEqual([PRICING_URL])
    expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'success' })
  })

  test('a switch re-reads after the record failed to read, and reads when the store answers', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T }) } })
    w.config.getThrows = true
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    expect(priceList(sync)).toEqual(PRICES)
    w.config.getThrows = false
    await priceCheck(sync, w.dollar as any, true)
    expect(w.fetches).toEqual([PRICING_URL])
    expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
  })
})

describe('check: refused writes and failed reads', () => {
  test('a refused stamp makes no fetch, and the next check tries again', async () => {
    let refuse = true
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    w.config.denySet = ({ value }) => refuse && (value as PriceRecord).attempt?.outcome === null
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    expect(w.writes.length).toBe(1)
    refuse = false
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([PRICING_URL])
  })

  test('a refused list write leaves the last list in force and the next automatic read an hour later', async () => {
    let refuse = true
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    w.config.denySet = ({ value }) => refuse && (value as PriceRecord).attempt?.outcome === 'success'
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    expect(priceList(sync)['claude-opus-5-5']).toEqual(PRICES['claude-opus-5-5'])
    expect(w.stored()!.models).toEqual({})
    // The refused list write itself is stored as an unreachable failure, so every session waits the same hour.
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'unreachable', failures: 1 })
    expect(dueAtMs(w.stored()!)).toBe(T + HOUR)
    w.advance(HOUR - 1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    refuse = false
    w.advance(1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(2)
    expect(perBillion(priceList(sync)['claude-opus-5-5']!.read)).toBe(400)
  })

  test('a refused list write whose failure write is refused too still waits an hour in this session', async () => {
    const w = makeWorld({ store: { prices: record({}, { lastSuccessMs: T - WEEK }) } })
    w.config.denySet = ({ value }) => (value as PriceRecord).attempt?.outcome !== null
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    w.advance(HOUR - 1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(1)
    w.advance(1)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches.length).toBe(2)
  })

  test('a refused list write after a format failure waits the unreachable schedule, not the weekly beat', async () => {
    const w = makeWorld({
      store: {
        prices: record({}, {
          lastSuccessMs: T,
          attempt: { stampMs: T + 8 * DAY, outcome: 'format', failures: 1, previous: 'success' },
        }),
      },
    })
    w.config.denySet = ({ value }) => (value as PriceRecord).attempt?.outcome === 'success'
    const sync = priceSync()
    w.advance(8 * DAY)
    await priceReady(sync, w.dollar as any)
    // The switch reads whatever the schedule says; its list write is refused.
    await priceCheck(sync, w.dollar as any, true)
    expect(w.fetches.length).toBe(1)
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'unreachable', failures: 2 })
    expect(dueAtMs(w.stored()!)).toBe(T + 8 * DAY + DAY)
  })

  test('a fetch with no answer within ten seconds is unreachable, and logs why', async () => {
    const never = deferred<ReturnType<typeof answer>>()
    const w = makeWorld({ fetch: () => never.promise })
    const sync = priceSync()
    await priceReady(sync, w.dollar as any)
    const reading = priceCheck(sync, w.dollar as any)
    await until(() => w.fetches.length === 1)
    w.fireTimers()
    await reading
    expect(w.stored()!.attempt).toMatchObject({ outcome: 'unreachable', failures: 1 })
    expect(w.logs.join('\n')).toContain('did not answer in time')
  })

  test('a non-2xx answer and a network error are unreachable; an unreadable page is a format change', async () => {
    const cases = [
      { fetch: async () => answer('nope', 500), outcome: 'unreachable', log: 'answered 500' },
      { fetch: async () => Promise.reject(new Error('socket closed')), outcome: 'unreachable', log: 'socket closed' },
      { fetch: async () => answer(NO_TABLE), outcome: 'format', log: 'no model prices' },
    ] as const
    for (const one of cases) {
      const w = makeWorld({ fetch: one.fetch })
      const sync = priceSync()
      await priceCheck(sync, w.dollar as any)
      expect(w.stored()!.attempt).toMatchObject({ outcome: one.outcome, failures: 1 })
      expect(w.logs.join('\n')).toContain(one.log)
    }
  })

  test('after a format failure the next automatic read waits for the weekly beat, not an hour', async () => {
    const w = makeWorld({
      store: {
        prices: record({}, {
          lastSuccessMs: T,
          attempt: { stampMs: T + 9 * DAY, outcome: 'format', failures: 1, previous: 'success' },
        }),
      },
    })
    const sync = priceSync()
    w.advance(9 * DAY)
    await priceReady(sync, w.dollar as any)
    await priceCheck(sync, w.dollar as any)
    expect(w.fetches).toEqual([])
    expect(dueAtMs(w.stored()!)).toBe(T + 14 * DAY)
  })
})

import { describe, expect, test } from 'claude-code/testing'
import { kindsOf } from './prices'
import { overridesPath, parseOverrides, UNREADABLE } from './overrides'

const file = (o: object) => JSON.stringify(o)
const UTC_PLUS_2 = () => 120
const UTC_MINUS_8 = () => -480
const parseDated = (date: string, zone?: (localMs: number) => number) => {
  const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, date } } }), zone)
  return out.rates[0]?.setMs
}

describe('the overrides file: its path', () => {
  test('CLAUDE_CONFIG_DIR is the config dir when set, else ~/.claude under HOME', () => {
    expect(overridesPath('/cfg', '/home/u')).toBe('/cfg/cachier/prices.json')
    expect(overridesPath(undefined, '/home/u')).toBe('/home/u/.claude/cachier/prices.json')
    expect(overridesPath('', '/home/u')).toBe('/home/u/.claude/cachier/prices.json')
    expect(overridesPath(undefined, undefined)).toBeNull()
  })
})

describe('the overrides file: rates entries', () => {
  test('input and read rates with a date price the model, the write rates derived as the built-in table derives them', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, date: '2026-10-26' } } }))
    expect(out.skips).toEqual([])
    expect(out.rates).toHaveLength(1)
    expect(out.rates[0]!.id).toBe('m')
    expect(out.rates[0]!.rates).toEqual({ ...kindsOf(3, 0.3), above: null })
  })

  test('explicit write rates in the sanity order are used', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, write5m: 4, write1h: 7, date: '2026-10-26' } } }))
    expect(out.rates[0]!.rates).toMatchObject({ input: 3e-6, read: 0.3e-6, write5m: 4e-6, write1h: 7e-6 })
  })

  test('one write rate given derives the other from the input rate', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, write5m: 4, date: '2026-10-26' } } }))
    expect(out.rates[0]!.rates.write5m).toBe(4e-6)
    expect(out.rates[0]!.rates.write1h).toBe(kindsOf(3, 0.3).write1h)
  })

  test('write rates out of the sanity order are skipped and named', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, write5m: 8, write1h: 7, date: '2026-10-26' } } }))
    expect(out.rates).toEqual([])
    expect(out.skips).toHaveLength(1)
    expect(out.skips[0]).toMatchObject({ id: 'm', kind: 'rates' })
    expect(out.skips[0]!.reason).toContain('order')
  })

  test('a read above the input rate is out of order, and so is an explicit write below the input', () => {
    const a = parseOverrides(file({ rates: { m: { input: 3, read: 4, date: '2026-10-26' } } }))
    const b = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, write5m: 2, date: '2026-10-26' } } }))
    expect(a.rates).toEqual([])
    expect(b.rates).toEqual([])
    expect(a.skips[0]!.reason).toContain('order')
    expect(b.skips[0]!.reason).toContain('order')
  })

  test('a missing or non-positive input or read rate is skipped, and the reason names the rate', () => {
    const out = parseOverrides(
      file({
        rates: {
          noInput: { read: 0.3, date: '2026-10-26' },
          noRead: { input: 3, date: '2026-10-26' },
          zero: { input: 0, read: 0.3, date: '2026-10-26' },
          text: { input: '3', read: 0.3, date: '2026-10-26' },
        },
      }),
    )
    expect(out.rates).toEqual([])
    expect(out.skips.map((s) => [s.id, s.kind])).toEqual([
      ['noInput', 'rates'],
      ['noRead', 'rates'],
      ['zero', 'rates'],
      ['text', 'rates'],
    ])
    expect(out.skips[0]!.reason).toContain('input')
    expect(out.skips[1]!.reason).toContain('read')
    expect(out.skips[2]!.reason).toContain('input')
    expect(out.skips[3]!.reason).toContain('input')
  })

  test('a rates entry with no valid date is skipped, and the reason names the date', () => {
    const out = parseOverrides(
      file({
        rates: {
          none: { input: 3, read: 0.3 },
          junk: { input: 3, read: 0.3, date: 'last week' },
          impossible: { input: 3, read: 0.3, date: '2026-02-30' },
          number: { input: 3, read: 0.3, date: 20261026 },
        },
      }),
    )
    expect(out.rates).toEqual([])
    expect(out.skips.map((s) => s.id)).toEqual(['none', 'junk', 'impossible', 'number'])
    for (const s of out.skips) expect(s.reason).toContain('date')
  })

  test('an entry that is not an object is skipped', () => {
    const out = parseOverrides(file({ rates: { m: 3 } }))
    expect(out.skips).toMatchObject([{ id: 'm', kind: 'rates' }])
  })

  test('a size tier is read, and one out of order skips the entry', () => {
    const good = parseOverrides(file({ rates: { m: { input: 1, read: 0.1, date: '2026-10-26', above: { threshold: 200000, input: 2, read: 0.2 } } } }))
    expect(good.rates[0]!.rates.above).toEqual({ ...kindsOf(2, 0.2), threshold: 200000 })
    const bad = parseOverrides(file({ rates: { m: { input: 1, read: 0.1, date: '2026-10-26', above: { threshold: 200000, input: 2, read: 9 } } } }))
    expect(bad.rates).toEqual([])
    expect(bad.skips[0]!.reason).toContain('order')
  })

  test('a size tier with a zero threshold skips the entry', () => {
    const zero = parseOverrides(file({ rates: { m: { input: 1, read: 0.1, date: '2026-10-26', above: { threshold: 0, input: 2, read: 0.2 } } } }))
    expect(zero.rates).toEqual([])
    expect(zero.skips[0]!.reason).toContain('threshold')
  })

  test('an id that would reach Object.prototype is skipped', () => {
    const out = parseOverrides('{"rates":{"__proto__":{"input":3,"read":0.3,"date":"2026-10-26"}}}')
    expect(out.rates).toEqual([])
    expect(out.skips).toMatchObject([{ id: '__proto__', kind: 'rates' }])
  })
})

describe('the overrides file: mappings', () => {
  test('a mapping needs no date', () => {
    const out = parseOverrides(file({ mappings: { 'anthropic.claude-x-v1:0': 'claude-opus-4-5' } }))
    expect(out.mappings).toEqual([{ key: 'anthropic.claude-x-v1:0', target: 'claude-opus-4-5' }])
    expect(out.skips).toEqual([])
  })

  test('a mapping to another mapping key is skipped and the reason names the chain; the mapping at the end of it stands', () => {
    const out = parseOverrides(file({ mappings: { a: 'b', b: 'claude-opus-4-5' } }))
    expect(out.mappings).toEqual([{ key: 'b', target: 'claude-opus-4-5' }])
    expect(out.skips).toHaveLength(1)
    expect(out.skips[0]).toMatchObject({ id: 'a', kind: 'mapping' })
    expect(out.skips[0]!.reason).toContain('chain')
  })

  test('a mapping whose target is not a string is skipped', () => {
    const out = parseOverrides(file({ mappings: { a: 3, b: '' } }))
    expect(out.mappings).toEqual([])
    expect(out.skips.map((s) => s.id)).toEqual(['a', 'b'])
  })

  test('a key that is both a rates entry and a mapping keeps its rates entry, and the mapping is skipped with the clash named', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, date: '2026-10-26' } }, mappings: { m: 'claude-opus-4-5' } }))
    expect(out.rates.map((r) => r.id)).toEqual(['m'])
    expect(out.mappings).toEqual([])
    expect(out.skips).toMatchObject([{ id: 'm', kind: 'mapping' }])
    expect(out.skips[0]!.reason).toContain('rates entry')
  })

  test('the clash is found whichever section the file lists first', () => {
    const out = parseOverrides(file({ mappings: { m: 'claude-opus-4-5' }, rates: { m: { input: 3, read: 0.3, date: '2026-10-26' } } }))
    expect(out.rates.map((r) => r.id)).toEqual(['m'])
    expect(out.mappings).toEqual([])
    expect(out.skips).toMatchObject([{ id: 'm', kind: 'mapping' }])
  })

  test('a rates entry the file itself skips does not clash, so its mapping stands', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3 } }, mappings: { m: 'claude-opus-4-5' } }))
    expect(out.rates).toEqual([])
    expect(out.mappings).toEqual([{ key: 'm', target: 'claude-opus-4-5' }])
    expect(out.skips).toMatchObject([{ id: 'm', kind: 'rates' }])
  })
})

describe('the overrides file: what is unreadable', () => {
  test('text that is not JSON is one unreadable item, and nothing applies', () => {
    const out = parseOverrides('{ not json')
    expect(out.rates).toEqual([])
    expect(out.mappings).toEqual([])
    expect(out.skips).toEqual([{ id: null, kind: 'file', reason: 'unreadable' }])
  })

  test('JSON that is not an object with object sections is unreadable too', () => {
    for (const text of ['[]', '3', 'null', '{"rates":[]}', '{"mappings":"x"}']) {
      expect(parseOverrides(text).skips).toEqual([{ id: null, kind: 'file', reason: 'unreadable' }])
    }
  })

  test('an empty object is a file with no entries and nothing skipped', () => {
    expect(parseOverrides('{}')).toEqual({ rates: [], mappings: [], skips: [], warnings: [] })
  })

  test('skips are listed in file order across both sections', () => {
    const out = parseOverrides(file({ mappings: { a: 'b', b: 'c' }, rates: { x: { read: 1, date: '2026-10-26' } } }))
    expect(out.skips.map((s) => s.id)).toEqual(['a', 'x'])
  })

  test('the unreadable item is one frozen value that every session shares, so no consumer can change it', () => {
    expect(Object.isFrozen(UNREADABLE)).toBe(true)
    expect(Object.isFrozen(UNREADABLE.rates)).toBe(true)
    expect(Object.isFrozen(UNREADABLE.mappings)).toBe(true)
    expect(Object.isFrozen(UNREADABLE.skips)).toBe(true)
    expect(UNREADABLE.warnings).toEqual([])
    expect(Object.isFrozen(UNREADABLE.warnings)).toBe(true)
    expect(Object.isFrozen(UNREADABLE.skips[0])).toBe(true)
  })
})

describe('the overrides file: fields and sections it does not read', () => {
  test('a field a rates entry does not read is ignored: the entry applies at its derived rates, and a warning names the field', () => {
    const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, write1H: 5, date: '2026-10-26' } } }))
    expect(out.skips).toEqual([])
    expect(out.rates).toHaveLength(1)
    expect(out.rates[0]!.rates).toEqual({ ...kindsOf(3, 0.3), above: null })
    expect(out.warnings).toEqual(['rates m: unknown field write1H ignored'])
  })

  test('a field a size tier does not read is ignored, and the warning names it under the tier', () => {
    const out = parseOverrides(file({ rates: { m: { input: 1, read: 0.1, date: '2026-10-26', above: { threshold: 200000, input: 2, read: 0.2, write1H: 4 } } } }))
    expect(out.rates[0]!.rates.above).toEqual({ ...kindsOf(2, 0.2), threshold: 200000 })
    expect(out.warnings).toEqual(['rates m: unknown field above.write1H ignored'])
  })

  test('a section the parser does not read is ignored and named, and prices nothing from it', () => {
    const out = parseOverrides(file({ rate: { m: { input: 3, read: 0.3, date: '2026-10-26' } } }))
    expect(out.rates).toEqual([])
    expect(out.mappings).toEqual([])
    expect(out.skips).toEqual([])
    expect(out.warnings).toEqual(['unknown section rate ignored'])
  })

  test('a file that uses only the fields and sections it reads has no warnings', () => {
    const out = parseOverrides(
      file({
        rates: {
          plain: { input: 3, read: 0.3, date: '2026-10-26' },
          written: { input: 3, read: 0.3, write5m: 4, write1h: 7, date: '2026-10-26' },
          tiered: { input: 1, read: 0.1, date: '2026-10-26', above: { threshold: 200000, input: 2, read: 0.2, write1h: 4 } },
        },
        mappings: { 'anthropic.claude-x-v1:0': 'plain' },
      }),
    )
    expect(out.warnings).toEqual([])
  })
})

describe('the overrides file: dates in two time zones', () => {
  test('a date and time with no offset is that local time in each zone', () => {
    expect(parseDated('2026-10-26T09:00', UTC_PLUS_2)).toBe(Date.parse('2026-10-26T07:00:00Z'))
    expect(parseDated('2026-10-26T09:00', UTC_MINUS_8)).toBe(Date.parse('2026-10-26T17:00:00Z'))
  })

  test('a calendar date with no time is the end of that day, local, in each zone', () => {
    expect(parseDated('2026-10-26', UTC_PLUS_2)).toBe(Date.parse('2026-10-26T21:59:59.999Z'))
    expect(parseDated('2026-10-26', UTC_MINUS_8)).toBe(Date.parse('2026-10-27T07:59:59.999Z'))
  })

  test('a page change at 18:00 local that day is not after it, and one at 00:30 local on the 27th is, under either offset', () => {
    for (const [zone, minutes] of [[UTC_PLUS_2, 120], [UTC_MINUS_8, -480]] as const) {
      const setMs = parseDated('2026-10-26', zone)!
      const at = (local: string) => Date.parse(`${local}Z`) - minutes * 60000
      expect(at('2026-10-26T18:00:00') > setMs).toBe(false)
      expect(at('2026-10-27T00:30:00') > setMs).toBe(true)
    }
  })

  test('a date with an explicit offset is that instant under either zone', () => {
    for (const zone of [UTC_PLUS_2, UTC_MINUS_8]) {
      expect(parseDated('2026-10-26T09:00Z', zone)).toBe(Date.parse('2026-10-26T09:00:00Z'))
      expect(parseDated('2026-10-26T09:00:00+05:30', zone)).toBe(Date.parse('2026-10-26T03:30:00Z'))
      expect(parseDated('2026-10-26T09:00-0700', zone)).toBe(Date.parse('2026-10-26T16:00:00Z'))
    }
  })

  test('an offset with hours or minutes out of range makes the date invalid, so the entry is skipped and the reason names the date', () => {
    for (const date of ['2026-10-26T09:00+99:99', '2026-10-26T09:00+05:99', '2026-10-26T09:00-24:00']) {
      const out = parseOverrides(file({ rates: { m: { input: 3, read: 0.3, date } } }))
      expect(out.rates).toEqual([])
      expect(out.skips).toMatchObject([{ id: 'm', kind: 'rates' }])
      expect(out.skips[0]!.reason).toContain('date')
    }
  })

  test('with no zone given the host local zone reads the date', () => {
    expect(parseDated('2026-10-26T09:00')).toBe(new Date(2026, 9, 26, 9, 0).getTime())
  })
})

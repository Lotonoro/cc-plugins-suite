import { describe, expect, test } from 'claude-code/testing'
import { ALIASES, DEFAULT_MODEL, FALLBACK_CHOICES, canonicalOf, choicesOf, idOf, isFable, isFullId, isNames, offered, sameModel, takeChoice } from './models'

// The ids the engine's model catalog held when it was read (13, in the picker's order).
const CATALOG = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']

describe('the id grammar', () => {
  test('a bare id, one with a date suffix and one with the other date form are full ids with one canonical form', () => {
    for (const id of ['claude-haiku-5-5', 'claude-haiku-5-5-20261001', 'claude-haiku-5-5@20261001']) {
      expect(isFullId(id)).toBe(true)
      expect(canonicalOf(id)).toBe('claude-haiku-5-5')
    }
  })

  test('a context-suffixed id is a full id whose canonical form keeps the suffix and drops the date', () => {
    expect(isFullId('claude-opus-4-6[1m]')).toBe(true)
    expect(canonicalOf('claude-opus-4-6[1m]')).toBe('claude-opus-4-6[1m]')
    expect(canonicalOf('claude-opus-4-6-20261001[1m]')).toBe('claude-opus-4-6[1m]')
    expect(canonicalOf('claude-opus-4-6')).not.toBe(canonicalOf('claude-opus-4-6[1m]'))
  })

  test('every id of the catalog is a full id, a version of one number and a dated one included', () => {
    for (const id of CATALOG) expect(isFullId(id)).toBe(true)
    expect(canonicalOf('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(canonicalOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(canonicalOf('claude-opus-4-20250514')).toBe('claude-opus-4')
  })

  test('the aliases and anything else are not full ids, and have no canonical form', () => {
    for (const name of ['haiku', 'sonnet', 'opus', 'fable', 'default', '', 'claude-', 'claude-haiku', 'Claude-Haiku-5-5', 'claude-haiku-5-5-2026', 'claude-haiku-5-5[2m]', 'opusplan', 'sonnet[1m]']) {
      expect(isFullId(name)).toBe(false)
      expect(canonicalOf(name)).toBeUndefined()
    }
  })

  test('the family tells Fable from the others, by alias or by id', () => {
    expect(isFable('fable')).toBe(true)
    expect(isFable('claude-fable-5-1')).toBe(true)
    expect(isFable('claude-fable-5-2[1m]')).toBe(true)
    for (const name of ['haiku', 'sonnet', 'opus', 'claude-opus-5-5', 'claude-haiku-5-5']) expect(isFable(name)).toBe(false)
  })
})

describe('the chain from a choice to an id', () => {
  test('a full id is its own id, in canonical form', () => {
    expect(idOf('claude-opus-4-6', {})).toBe('claude-opus-4-6')
    expect(idOf('claude-haiku-5-5-20261001', {})).toBe('claude-haiku-5-5')
  })

  test('an alias takes the id it last resolved to, in canonical form, or has none', () => {
    expect(idOf('haiku', { haiku: 'claude-haiku-5-5-20261001' })).toBe('claude-haiku-5-5')
    expect(idOf('sonnet', { haiku: 'claude-haiku-5-5' })).toBeUndefined()
    expect(idOf('haiku', {})).toBeUndefined()
  })

  test('a stored value that is not a full id is no id', () => {
    expect(idOf('haiku', { haiku: 'sonnet' })).toBeUndefined()
    expect(idOf('constructor', {})).toBeUndefined()
  })
})

describe('sameModel', () => {
  test('one name is one model, whatever its ids say', () => {
    expect(sameModel('haiku', 'haiku', {})).toBe(true)
    expect(sameModel('claude-opus-4-6[1m]', 'claude-opus-4-6[1m]', { 'claude-opus-4-6[1m]': 'claude-opus-4-6' })).toBe(true)
  })

  test('two names are one model when both ids are known and equal', () => {
    expect(sameModel('haiku', 'claude-haiku-5-5', { haiku: 'claude-haiku-5-5-20261001' })).toBe(true)
    expect(sameModel('claude-haiku-5-5', 'haiku', { haiku: 'claude-haiku-5-5' })).toBe(true)
    expect(sameModel('haiku', 'sonnet', { haiku: 'claude-haiku-5-5', sonnet: 'claude-haiku-5-5' })).toBe(true)
  })

  test('two names are not one model when an id is unknown or the ids differ', () => {
    expect(sameModel('haiku', 'sonnet', {})).toBe(false)
    expect(sameModel('haiku', 'claude-haiku-5-5', {})).toBe(false)
    expect(sameModel('haiku', 'sonnet', { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' })).toBe(false)
    expect(sameModel('claude-opus-4-6', 'claude-opus-4-6[1m]', {})).toBe(false)
  })
})

describe('the choices', () => {
  test('with no catalog they are the four aliases, in order, and the default is haiku', () => {
    expect(ALIASES).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(DEFAULT_MODEL).toBe('haiku')
    expect(choicesOf(undefined, undefined)).toEqual({ list: ['haiku', 'sonnet', 'opus', 'fable'], defaultChoice: 'haiku', filterIgnored: false })
    expect(FALLBACK_CHOICES).toEqual(choicesOf(undefined, undefined))
  })

  test('with a catalog they are the four aliases followed by the catalog\'s ids in its order, an id an alias resolves to included', () => {
    const { list, defaultChoice } = choicesOf(CATALOG, undefined)
    expect(list).toEqual([...ALIASES, ...CATALOG])
    expect(list).toContain('claude-haiku-5-5')
    expect(defaultChoice).toBe('haiku')
  })

  test('an availableModels naming one alias and one catalog id leaves just those two', () => {
    expect(choicesOf(CATALOG, ['opus', 'claude-opus-4-6'])).toEqual({ list: ['opus', 'claude-opus-4-6'], defaultChoice: 'opus', filterIgnored: false })
  })

  test('an entry matches a choice by its name or its canonical id, in any case', () => {
    const { list } = choicesOf(CATALOG, ['OPUS', 'Claude-Haiku-4-5', 'claude-sonnet-5-5-20261001'])
    expect(list).toEqual(['opus', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
  })

  test('a value that is not a list of names leaves the list whole', () => {
    const whole = choicesOf(CATALOG, undefined)
    for (const value of ['opus', 7, { opus: true }, null, ['opus', 3]]) expect(choicesOf(CATALOG, value)).toEqual(whole)
  })

  test('a filter that leaves nothing leaves the list whole, and says it was ignored', () => {
    for (const value of [[], ['nosuch', 'claude-nosuch-1-1']]) {
      expect(choicesOf(CATALOG, value)).toEqual({ ...choicesOf(CATALOG, undefined), filterIgnored: true })
    }
  })

  test('a filter without haiku makes the first remaining choice that is not Fable the default', () => {
    expect(choicesOf(CATALOG, ['fable', 'opus', 'sonnet']).defaultChoice).toBe('sonnet')
    expect(choicesOf(CATALOG, ['claude-fable-5-1', 'claude-opus-4-7']).defaultChoice).toBe('claude-opus-4-7')
  })

  test('where only Fable is left it is the default, since the plugin must always have something to spawn on', () => {
    expect(choicesOf(CATALOG, ['fable']).defaultChoice).toBe('fable')
  })

  test('the list is not changed by the filter\'s own order', () => {
    expect(choicesOf(CATALOG, ['claude-opus-4-6', 'sonnet']).list).toEqual(['sonnet', 'claude-opus-4-6'])
  })
})

describe('a name list', () => {
  test('is a list of strings and nothing else', () => {
    expect(isNames([])).toBe(true)
    expect(isNames(['a', 'b'])).toBe(true)
    for (const value of [undefined, null, 'a', 1, {}, ['a', 1], [undefined]]) expect(isNames(value)).toBe(false)
  })
})

describe('offered', () => {
  const list = ['haiku', 'sonnet', 'opus', 'fable', 'claude-opus-4-6']

  test('a name the list offers comes back in the list\'s spelling, whatever its case', () => {
    expect(offered(list, 'OPUS')).toBe('opus')
    expect(offered(list, 'Claude-Opus-4-6')).toBe('claude-opus-4-6')
    expect(offered(list, 'haiku')).toBe('haiku')
  })

  test('a name the list does not offer is not', () => {
    expect(offered(list, 'nosuch')).toBeUndefined()
    expect(offered(list, 'claude-opus-4-6[1m]')).toBeUndefined()
    expect(offered(list, '')).toBeUndefined()
  })
})

describe('takeChoice', () => {
  const choices = choicesOf(CATALOG, undefined)

  test('a held choice is kept, whatever is stored and whether or not the list still offers it', () => {
    expect(takeChoice('haiku', 'claude-opus-4-6', choices)).toBe('haiku')
    expect(takeChoice('claude-gone-1-1', 'opus', choices)).toBe('claude-gone-1-1')
  })

  test('with none held, the last model set is taken when the list offers it, in the list\'s spelling', () => {
    expect(takeChoice(undefined, 'claude-opus-4-6', choices)).toBe('claude-opus-4-6')
    expect(takeChoice(undefined, 'SONNET', choices)).toBe('sonnet')
    expect(takeChoice(undefined, 'fable', choices)).toBe('fable')
  })

  test('with none held, a last model set the list does not offer is not taken, nor is none', () => {
    expect(takeChoice(undefined, 'claude-gone-1-1', choices)).toBe('haiku')
    expect(takeChoice(undefined, undefined, choices)).toBe('haiku')
    expect(takeChoice('', undefined, choices)).toBe('haiku')
  })

  test('the default is the list\'s own, which a filter may move off haiku', () => {
    expect(takeChoice(undefined, undefined, choicesOf(CATALOG, ['sonnet', 'fable']))).toBe('sonnet')
    expect(takeChoice(undefined, 'haiku', choicesOf(CATALOG, ['sonnet', 'fable']))).toBe('sonnet')
  })
})

import { describe, expect, test } from 'claude-code/testing'
import { CATALOG_IDS, CATALOG_NAMES } from './fakes'
import { ALIASES, DEFAULT_MODEL, FALLBACK_CHOICES, canonicalOf, choicesOf, idOf, isFable, isFullId, isNames, keepsPair, offered, sameModel, shownAs, takeChoice } from './models'

// What the catalog read gives `choicesOf` for its names: each id's name, by canonical id.
const NAMES: Record<string, string> = Object.fromEntries(CATALOG_IDS.map(id => [canonicalOf(id) ?? id, CATALOG_NAMES[id] ?? '']))

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
    for (const id of CATALOG_IDS) expect(isFullId(id)).toBe(true)
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
    expect(choicesOf(undefined, undefined)).toEqual({ list: ['haiku', 'sonnet', 'opus', 'fable'], defaultChoice: 'haiku', filterIgnored: false, names: {} })
    expect(FALLBACK_CHOICES).toEqual(choicesOf(undefined, undefined))
  })

  test('with a catalog they are the four aliases followed by the catalog\'s ids in its order, an id an alias resolves to included', () => {
    const { list, defaultChoice } = choicesOf(CATALOG_IDS, undefined)
    expect(list).toEqual([...ALIASES, ...CATALOG_IDS])
    expect(list).toContain('claude-haiku-5-5')
    expect(defaultChoice).toBe('haiku')
  })

  test('an availableModels naming one alias and one catalog id leaves just those two', () => {
    expect(choicesOf(CATALOG_IDS, ['opus', 'claude-opus-4-6'])).toEqual({ list: ['opus', 'claude-opus-4-6'], defaultChoice: 'opus', filterIgnored: false, names: {} })
  })

  test('an entry matches a choice by its name or its canonical id, in any case', () => {
    const { list } = choicesOf(CATALOG_IDS, ['OPUS', 'Claude-Haiku-4-5', 'claude-sonnet-5-5-20261001'])
    expect(list).toEqual(['opus', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
  })

  test('a value that is not a list of names leaves the list whole', () => {
    const whole = choicesOf(CATALOG_IDS, undefined)
    for (const value of ['opus', 7, { opus: true }, null, ['opus', 3]]) expect(choicesOf(CATALOG_IDS, value)).toEqual(whole)
  })

  test('a filter that leaves nothing leaves the list whole, and says it was ignored', () => {
    for (const value of [[], ['nosuch', 'claude-nosuch-1-1']]) {
      expect(choicesOf(CATALOG_IDS, value)).toEqual({ ...choicesOf(CATALOG_IDS, undefined), filterIgnored: true })
    }
  })

  test('a filter without haiku makes the first remaining choice that is not Fable the default', () => {
    expect(choicesOf(CATALOG_IDS, ['fable', 'opus', 'sonnet']).defaultChoice).toBe('sonnet')
    expect(choicesOf(CATALOG_IDS, ['claude-fable-5-1', 'claude-opus-4-7']).defaultChoice).toBe('claude-opus-4-7')
  })

  test('where only Fable is left it is the default, since the plugin must always have something to spawn on', () => {
    expect(choicesOf(CATALOG_IDS, ['fable']).defaultChoice).toBe('fable')
  })

  test('the list is not changed by the filter\'s own order', () => {
    expect(choicesOf(CATALOG_IDS, ['claude-opus-4-6', 'sonnet']).list).toEqual(['sonnet', 'claude-opus-4-6'])
  })

  describe('the names', () => {
    test('the names the catalog read gave are carried, by canonical id, and change nothing else', () => {
      const named = choicesOf(CATALOG_IDS, undefined, NAMES)
      expect(named.names).toEqual(NAMES)
      expect(named.names['claude-haiku-4-5']).toBe('Haiku 4.5')
      expect({ ...named, names: {} }).toEqual(choicesOf(CATALOG_IDS, undefined))
    })

    test('a name empty once trimmed or holding a control character gives its id no name, a name with spaces around it is given trimmed, and the other names stand', () => {
      const { names } = choicesOf(CATALOG_IDS, undefined, {
        'claude-opus-4-6': '  Opus 4.6  ',
        'claude-opus-4-7': '   ',
        'claude-opus-5': 'Opus\n5',
        'claude-opus-5-5': 'Opus\t5.5',
        'claude-fable-5': 'Fable\u00005',
        'claude-fable-5-1': 'Fable 5.1\u007f',
        'claude-fable-5-2': 'Fable\u00855.2',
        'claude-sonnet-5': 'Sonnet 5\n',
        'claude-haiku-5-5': 'Haiku 5.5',
      })
      expect(names).toEqual({ 'claude-opus-4-6': 'Opus 4.6', 'claude-haiku-5-5': 'Haiku 5.5' })
    })

    // Two names empty once trimmed would be dropped as a shared name whether or not they were unusable, so each is tried by itself.
    test('a name that is empty, or only spaces, gives its id no name when no other name is empty', () => {
      expect(choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-8': '' }).names).toEqual({})
      expect(choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-8': '', 'claude-haiku-5-5': 'Haiku 5.5' }).names).toEqual({ 'claude-haiku-5-5': 'Haiku 5.5' })
      expect(choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-7': '   ', 'claude-haiku-5-5': 'Haiku 5.5' }).names).toEqual({ 'claude-haiku-5-5': 'Haiku 5.5' })
    })

    test('two ids that share a name, once trimmed, have none; a name only one id holds stands', () => {
      const { names } = choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-6': 'Opus', 'claude-opus-4-7': ' Opus ', 'claude-opus-4-8': 'Opus', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-haiku-4-5': 'Haiku 4.5' })
      expect(names).toEqual({ 'claude-haiku-5-5': 'Haiku 5.5', 'claude-haiku-4-5': 'Haiku 4.5' })
    })

    test('a name that only an unusable name could share is not shared', () => {
      const { names } = choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-6': 'Opus', 'claude-opus-4-7': 'Opus\n' })
      expect(names).toEqual({ 'claude-opus-4-6': 'Opus' })
    })

    test('the names cover the ids an availableModels filter removed from the list', () => {
      const filtered = choicesOf(CATALOG_IDS, ['opus', 'claude-opus-4-6'], NAMES)
      expect(filtered.list).toEqual(['opus', 'claude-opus-4-6'])
      expect(filtered.names).toEqual(NAMES)
    })

    test('a filter that is ignored for leaving nothing leaves the names whole too', () => {
      const ignored = choicesOf(CATALOG_IDS, ['nosuch'], NAMES)
      expect(ignored.filterIgnored).toBe(true)
      expect(ignored.names).toEqual(NAMES)
    })
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
  const choices = choicesOf(CATALOG_IDS, undefined)

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
    expect(takeChoice(undefined, undefined, choicesOf(CATALOG_IDS, ['sonnet', 'fable']))).toBe('sonnet')
    expect(takeChoice(undefined, 'haiku', choicesOf(CATALOG_IDS, ['sonnet', 'fable']))).toBe('sonnet')
  })
})

describe('shownAs', () => {
  const named = choicesOf(CATALOG_IDS, undefined, NAMES)

  test('a choice is shown as the name of its id: an alias by the id it last resolved to, a full id by its own', () => {
    expect(shownAs('haiku', { haiku: 'claude-haiku-5-5' }, named)).toBe('Haiku 5.5')
    expect(shownAs('claude-opus-4-6', {}, named)).toBe('Opus 4.6')
    expect(shownAs('claude-opus-4-6', { opus: 'claude-opus-5-5' }, named)).toBe('Opus 4.6')
  })

  test('a dated id is named by its canonical form, whether it is the choice or the id an alias resolved to', () => {
    expect(shownAs('claude-haiku-4-5-20251001', {}, named)).toBe('Haiku 4.5')
    expect(shownAs('haiku', { haiku: 'claude-haiku-5-5-20261001' }, named)).toBe('Haiku 5.5')
  })

  test('an alias no spawn has resolved is shown as spelled', () => {
    expect(shownAs('sonnet', {}, named)).toBe('sonnet')
    expect(shownAs('sonnet', { haiku: 'claude-haiku-5-5' }, named)).toBe('sonnet')
  })

  test('an id the names do not hold is shown as spelled, as the choice or as what an alias resolved to', () => {
    expect(shownAs('claude-gone-1-1', {}, named)).toBe('claude-gone-1-1')
    expect(shownAs('claude-opus-4-6[1m]', {}, named)).toBe('claude-opus-4-6[1m]')
    expect(shownAs('haiku', { haiku: 'claude-gone-1-1' }, named)).toBe('haiku')
  })

  test('with the fallback choices, or choices read without names, a choice is shown as spelled', () => {
    expect(shownAs('haiku', { haiku: 'claude-haiku-5-5' }, FALLBACK_CHOICES)).toBe('haiku')
    expect(shownAs('claude-opus-4-6', {}, FALLBACK_CHOICES)).toBe('claude-opus-4-6')
    expect(shownAs('claude-opus-4-6', {}, choicesOf(CATALOG_IDS, undefined))).toBe('claude-opus-4-6')
  })

  test('two catalog ids that share a name, once trimmed, are each shown as spelled, and an alias that resolved to one as the alias', () => {
    const shared = choicesOf(CATALOG_IDS, undefined, { ...NAMES, 'claude-opus-4-6': 'Opus 4.6', 'claude-opus-4-7': ' Opus 4.6' })
    expect(shownAs('claude-opus-4-6', {}, shared)).toBe('claude-opus-4-6')
    expect(shownAs('claude-opus-4-7', {}, shared)).toBe('claude-opus-4-7')
    expect(shownAs('opus', { opus: 'claude-opus-4-7' }, shared)).toBe('opus')
    expect(shownAs('claude-opus-4-8', {}, shared)).toBe('Opus 4.8')
  })

  test('the name shown is the trimmed one', () => {
    expect(shownAs('claude-opus-4-6', {}, choicesOf(CATALOG_IDS, undefined, { 'claude-opus-4-6': '  Opus 4.6 ' }))).toBe('Opus 4.6')
  })

  test('the words of a name the list does not offer are still its name: a held choice may lie outside an availableModels filter', () => {
    const filtered = choicesOf(CATALOG_IDS, ['sonnet'], NAMES)
    expect(shownAs('claude-opus-4-6', {}, filtered)).toBe('Opus 4.6')
  })
})

describe('keepsPair', () => {
  test('a pair of an alias choice and a full id is kept, in whatever form the id is', () => {
    expect(keepsPair('haiku', 'claude-haiku-5-5')).toBe(true)
    expect(keepsPair('opus', 'claude-opus-4-6[1m]')).toBe(true)
    expect(keepsPair('haiku', 'claude-haiku-5-5-20261001')).toBe(true)
  })

  test('a full-id choice is its own id, so its pair is not kept', () => {
    expect(keepsPair('claude-opus-4-6', 'claude-opus-4-6')).toBe(false)
    expect(keepsPair('claude-opus-4-6', 'claude-opus-4-7')).toBe(false)
  })

  test('an alias paired with a name that is not a full id is not kept', () => {
    expect(keepsPair('haiku', 'sonnet')).toBe(false)
    expect(keepsPair('haiku', '')).toBe(false)
    expect(keepsPair('haiku', 'claude-haiku')).toBe(false)
  })
})

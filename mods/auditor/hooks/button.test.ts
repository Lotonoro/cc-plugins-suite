import { describe, expect, test } from 'claude-code/testing'
import { answerOf, buttonOf, labelOf, modelAnswerOf, modelFiguresOf, rowsOf } from './button'
import type { Figures } from './button'
import { choicesOf } from './models'

// 14:32 in the host's local time, built from local parts so the tests hold in any time zone.
const AT = new Date(2026, 10, 9, 14, 32).getTime()
const figures = (over: Partial<Figures> = {}): Figures => ({ state: 'on', spent: 12.4, unpriced: [], total: 410.27, model: 'Haiku 5.5', reviews: 14, notes: 3, last: { at: AT, note: false }, cause: undefined, held: 0, ...over })

describe('labelOf', () => {
  test('on, nothing spent yet, reads auditor on', () => {
    expect(labelOf(figures({ spent: 0 }))).toBe('auditor on')
  })

  test('on reads the dollars and the share', () => {
    expect(labelOf(figures())).toBe('auditor on ($12, 3%)')
  })

  test('on, with the share unknown, reads the dollars alone', () => {
    expect(labelOf(figures({ total: undefined }))).toBe('auditor on ($12)')
  })

  test('on, with the cost unknown (unpriced models and no priced spend), reads auditor on, naming no model', () => {
    expect(labelOf(figures({ spent: 0, unpriced: ['haiku'] }))).toBe('auditor on')
    expect(labelOf(figures({ spent: 0, unpriced: ['haiku', 'claude-unpriced-1-1'] }))).toBe('auditor on')
  })

  test('on, with priced spend and an unpriced model, reads the dollars marked partial in the share\'s place, though a session total is given', () => {
    expect(labelOf(figures({ spent: 0.75, unpriced: ['haiku'] }))).toBe('auditor on ($0.75, partial)')
    expect(labelOf(figures({ unpriced: ['haiku', 'claude-unpriced-1-1'] }))).toBe('auditor on ($12, partial)')
    expect(labelOf(figures({ spent: 0.75, unpriced: ['haiku'], total: undefined }))).toBe('auditor on ($0.75, partial)')
    expect(labelOf(figures({ spent: 0.004, unpriced: ['haiku'] }))).toBe('auditor on (<$0.01, partial)')
  })

  test('failing keeps the figures the same way', () => {
    expect(labelOf(figures({ state: 'failing' }))).toBe('auditor failing ($12, 3%)')
    expect(labelOf(figures({ state: 'failing', total: undefined }))).toBe('auditor failing ($12)')
    expect(labelOf(figures({ state: 'failing', spent: 0, unpriced: ['haiku'] }))).toBe('auditor failing')
  })

  test('failing, with priced spend and an unpriced model, reads the dollars marked partial', () => {
    expect(labelOf(figures({ state: 'failing', spent: 0.75, unpriced: ['haiku'] }))).toBe('auditor failing ($0.75, partial)')
  })

  test('off reads auditor off, whatever the figures', () => {
    expect(labelOf(figures({ state: 'off' }))).toBe('auditor off')
    expect(labelOf(figures({ state: 'off', unpriced: ['haiku'] }))).toBe('auditor off')
  })

  test('the dollars are whole from $10 and to the cent below, and the share one decimal below 1%', () => {
    expect(labelOf(figures({ spent: 3.4, total: 1000 }))).toBe('auditor on ($3.40, 0.3%)')
    expect(labelOf(figures({ spent: 0.42, total: 100 }))).toBe('auditor on ($0.42, 0.4%)')
    expect(labelOf(figures({ spent: 0.004, total: 100 }))).toBe('auditor on (<$0.01, <0.1%)')
  })

  test('a tally over the session total reads 100%', () => {
    expect(labelOf(figures({ spent: 5, total: 2 }))).toBe('auditor on ($5.00, 100%)')
  })

  test('the label names no model, whatever the state', () => {
    for (const state of ['on', 'off', 'failing'] as const) {
      expect(labelOf(figures({ state, model: 'Opus 4.6' }))).toBe(labelOf(figures({ state, model: 'sonnet' })))
      expect(labelOf(figures({ state, model: 'Opus 4.6' }))).not.toContain('Opus')
    }
  })
})

describe('rowsOf', () => {
  test('on, the cost row names the tally, the session total, the share and the prices, then the model row, the reviews row and the press row', () => {
    expect(rowsOf(figures())).toEqual([
      { key: 'cost', text: 'auditor $12.40 since on · session $410.27 · 3% · API list prices' },
      { key: 'model', text: 'reviewer model: Haiku 5.5' },
      { key: 'reviews', text: '14 reviews · 3 notes · last at 14:32, quiet' },
      { key: 'press', text: 'click to switch off' },
    ])
  })

  test('with the share unknown, the cost row leaves out the session and the share', () => {
    expect(rowsOf(figures({ total: undefined }))[0]).toEqual({ key: 'cost', text: 'auditor $12.40 since on · API list prices' })
  })

  test('with nothing spent yet, the cost row shows $0.00 and no share', () => {
    expect(rowsOf(figures({ spent: 0 }))[0]).toEqual({ key: 'cost', text: 'auditor $0.00 since on · API list prices' })
  })

  test('with the cost unknown, the cost row names every model with no price, comma-joined in the order given', () => {
    expect(rowsOf(figures({ spent: 0, unpriced: ['haiku'] }))[0]).toEqual({ key: 'cost', text: 'cost unknown: no price for haiku' })
    expect(rowsOf(figures({ spent: 0, unpriced: ['claude-unpriced-2-2', 'haiku', 'claude-unpriced-1-1'] }))[0]).toEqual({ key: 'cost', text: 'cost unknown: no price for claude-unpriced-2-2, haiku, claude-unpriced-1-1' })
  })

  test('with priced spend and an unpriced model, the cost row shows the tally with no session and no share, though a session total is given, then names every model with no price, last', () => {
    expect(rowsOf(figures({ spent: 0.75, unpriced: ['claude-unpriced-1-1'] }))[0]).toEqual({ key: 'cost', text: 'auditor $0.75 since on · API list prices · partial: no price for claude-unpriced-1-1' })
    expect(rowsOf(figures({ spent: 0.75, unpriced: ['A', 'B'] }))[0]).toEqual({ key: 'cost', text: 'auditor $0.75 since on · API list prices · partial: no price for A, B' })
    expect(rowsOf(figures({ spent: 0.75, unpriced: ['A', 'B'], total: undefined }))[0]).toEqual({ key: 'cost', text: 'auditor $0.75 since on · API list prices · partial: no price for A, B' })
  })

  test('a partial cost row names every unpriced model, however many, and the partial clause ends the row', () => {
    const many = ['claude-unpriced-1-1', 'claude-unpriced-2-2', 'claude-unpriced-3-3', 'claude-unpriced-4-4', 'haiku', 'an unknown model']
    expect(rowsOf(figures({ spent: 1.5, unpriced: many }))[0]?.text).toBe(`auditor $1.50 since on · API list prices · partial: no price for ${many.join(', ')}`)
  })

  test('a partial figure under a cent reads <$0.01', () => {
    expect(rowsOf(figures({ spent: 0.004, unpriced: ['haiku'] }))[0]?.text).toBe('auditor <$0.01 since on · API list prices · partial: no price for haiku')
  })

  test('under a cent, both figures read <$0.01', () => {
    expect(rowsOf(figures({ spent: 0.004, total: 0.0049 }))[0]?.text).toBe('auditor <$0.01 since on · session <$0.01 · 82% · API list prices')
  })

  test('off, the rows say no reviews run and no figures show, name the model, then offer to switch on, with no review facts', () => {
    expect(rowsOf(figures({ state: 'off' }))).toEqual([
      { key: 'cost', text: 'off: no reviews, no figures until switched on' },
      { key: 'model', text: 'reviewer model: Haiku 5.5' },
      { key: 'press', text: 'click to switch on' },
    ])
  })

  describe('the model row', () => {
    const modelRow = (over: Partial<Figures>): string | undefined => rowsOf(figures(over)).find(r => r.key === 'model')?.text

    test('a name reads as the catalog gives it, and a spelling with no name as the list spells it', () => {
      expect(modelRow({ model: 'Haiku 5.5' })).toBe('reviewer model: Haiku 5.5')
      expect(modelRow({ model: 'Opus 4.6' })).toBe('reviewer model: Opus 4.6')
      expect(modelRow({ model: 'sonnet' })).toBe('reviewer model: sonnet')
      expect(modelRow({ model: 'claude-opus-4-6' })).toBe('reviewer model: claude-opus-4-6')
    })

    test('it is the second row, right after the cost row, in each of on, off and failing', () => {
      for (const state of ['on', 'off', 'failing'] as const) {
        const rows = rowsOf(figures({ state, cause: state === 'failing' ? 'no answer' : undefined, held: 1 }))
        expect(rows.map(r => r.key).slice(0, 2)).toEqual(['cost', 'model'])
        expect(rows.filter(r => r.key === 'model')).toHaveLength(1)
      }
    })

    test('the other rows keep their words and their order among themselves', () => {
      const without = (over: Partial<Figures>) => rowsOf(figures(over)).filter(r => r.key !== 'model')
      expect(without({})).toEqual([
        { key: 'cost', text: 'auditor $12.40 since on · session $410.27 · 3% · API list prices' },
        { key: 'reviews', text: '14 reviews · 3 notes · last at 14:32, quiet' },
        { key: 'press', text: 'click to switch off' },
      ])
      expect(without({ state: 'off' })).toEqual([
        { key: 'cost', text: 'off: no reviews, no figures until switched on' },
        { key: 'press', text: 'click to switch on' },
      ])
      expect(without({ state: 'failing', cause: 'no answer', held: 1 })).toEqual([
        { key: 'cost', text: 'auditor $12.40 since on · session $410.27 · 3% · API list prices' },
        { key: 'reviews', text: '14 reviews · 3 notes · last at 14:32, quiet' },
        { key: 'press', text: 'click to switch off' },
        { key: 'state', text: 'failing: the reviewer ended a turn without an answer · 1 note held' },
      ])
    })

    test('with the cost unknown for an unpriced id, the row names the next model and the cost row keeps its own words', () => {
      const rows = rowsOf(figures({ spent: 0, unpriced: ['claude-opus-4-6'], model: 'Sonnet 5.5' }))
      expect(rows[0]).toEqual({ key: 'cost', text: 'cost unknown: no price for claude-opus-4-6' })
      expect(rows[1]).toEqual({ key: 'model', text: 'reviewer model: Sonnet 5.5' })
    })

    test('with a partial figure, the row names the next model and the cost row keeps its own words', () => {
      const rows = rowsOf(figures({ unpriced: ['claude-opus-4-6'], model: 'Sonnet 5.5' }))
      expect(rows[0]).toEqual({ key: 'cost', text: 'auditor $12.40 since on · API list prices · partial: no price for claude-opus-4-6' })
      expect(rows[1]).toEqual({ key: 'model', text: 'reviewer model: Sonnet 5.5' })
    })
  })

  describe('the reviews row', () => {
    const reviews = (over: Partial<Figures>): string | undefined => rowsOf(figures(over)).find(r => r.key === 'reviews')?.text

    test('no review completed yet', () => {
      expect(reviews({ reviews: 0, notes: 0, last: undefined })).toBe('no reviews yet')
    })

    test('one review, quiet', () => {
      expect(reviews({ reviews: 1, notes: 0 })).toBe('1 review · no notes · last at 14:32, quiet')
    })

    test('one review, its note', () => {
      expect(reviews({ reviews: 1, notes: 1, last: { at: AT, note: true } })).toBe('1 review · 1 note · last at 14:32, note sent')
    })

    test('many reviews, quiet or with a note, with no notes at all or several', () => {
      expect(reviews({})).toBe('14 reviews · 3 notes · last at 14:32, quiet')
      expect(reviews({ last: { at: AT, note: true } })).toBe('14 reviews · 3 notes · last at 14:32, note sent')
      expect(reviews({ notes: 0 })).toBe('14 reviews · no notes · last at 14:32, quiet')
    })

    test('the close time is the local hour and minute, both two digits', () => {
      expect(reviews({ last: { at: new Date(2026, 10, 9, 7, 5).getTime(), note: false } })).toBe('14 reviews · 3 notes · last at 07:05, quiet')
      expect(reviews({ last: { at: new Date(2026, 10, 9, 0, 0).getTime(), note: false } })).toBe('14 reviews · 3 notes · last at 00:00, quiet')
    })

    test('failing shows the same reviews row as on', () => {
      expect(reviews({ state: 'failing', cause: 'no answer' })).toBe(reviews({}))
    })
  })

  describe('the state row, after the press row', () => {
    const state = (over: Partial<Figures>) => rowsOf(figures(over))
    const lastRow = (over: Partial<Figures>) => state(over).at(-1)

    test('neither failing nor holding a note shows none', () => {
      expect(state({}).map(r => r.key)).toEqual(['cost', 'model', 'reviews', 'press'])
    })

    test('failing names its cause, one wording for each', () => {
      expect(lastRow({ state: 'failing', cause: 'no answer' })).toEqual({ key: 'state', text: 'failing: the reviewer ended a turn without an answer' })
      expect(lastRow({ state: 'failing', cause: 'not dispatched' })).toEqual({ key: 'state', text: 'failing: a review could not be handed to a reviewer' })
      expect(lastRow({ state: 'failing', cause: 'no start' })).toEqual({ key: 'state', text: 'failing: the reviewer did not start in 10 minutes' })
      expect(lastRow({ state: 'failing', cause: 'no finish' })).toEqual({ key: 'state', text: 'failing: the reviewer did not finish in 10 minutes' })
      expect(lastRow({ state: 'failing', cause: 'unknown' })).toEqual({ key: 'state', text: 'failing: cause unknown; see the debug log' })
    })

    test('held notes read in the singular and the plural', () => {
      expect(lastRow({ held: 1 })).toEqual({ key: 'state', text: '1 note held for your next prompt' })
      expect(lastRow({ held: 2 })).toEqual({ key: 'state', text: '2 notes held for your next prompt' })
    })

    test('failing and holding notes share the one row', () => {
      expect(lastRow({ state: 'failing', cause: 'no answer', held: 1 })?.text).toBe('failing: the reviewer ended a turn without an answer · 1 note held')
      expect(lastRow({ state: 'failing', cause: 'no start', held: 2 })?.text).toBe('failing: the reviewer did not start in 10 minutes · 2 notes held')
    })

    test('the popup never exceeds five rows, in any state, and holds five while failing with notes held', () => {
      for (const state of ['on', 'off', 'failing'] as const) {
        for (const held of [0, 2]) expect(rowsOf(figures({ state, cause: state === 'failing' ? 'unknown' : undefined, held })).length).toBeLessThanOrEqual(5)
      }
      expect(rowsOf(figures({ state: 'failing', cause: 'unknown', held: 2 })).map(r => r.key)).toEqual(['cost', 'model', 'reviews', 'press', 'state'])
    })

    test('off shows no state row even with a cause or notes left over, and holds cost, model and press', () => {
      expect(rowsOf(figures({ state: 'off', cause: 'unknown', held: 2 })).map(r => r.key)).toEqual(['cost', 'model', 'press'])
    })
  })
})

describe('answerOf', () => {
  test('the answer is the label, then each popup row, one to a line', () => {
    expect(answerOf(figures())).toBe('auditor on ($12, 3%)\nauditor $12.40 since on · session $410.27 · 3% · API list prices\nreviewer model: Haiku 5.5\n14 reviews · 3 notes · last at 14:32, quiet\nclick to switch off')
    expect(answerOf(figures({ state: 'off' }))).toBe('auditor off\noff: no reviews, no figures until switched on\nreviewer model: Haiku 5.5\nclick to switch on')
  })

  test('a failing answer ends with the state row', () => {
    expect(answerOf(figures({ state: 'failing', cause: 'not dispatched', held: 1 })).split('\n').at(-1)).toBe('failing: a review could not be handed to a reviewer · 1 note held')
  })

  test('a partial figure reads the same words in the answer: the label with partial, then the cost row naming every unpriced model', () => {
    expect(answerOf(figures({ spent: 0.75, unpriced: ['A', 'B'] }))).toBe('auditor on ($0.75, partial)\nauditor $0.75 since on · API list prices · partial: no price for A, B\nreviewer model: Haiku 5.5\n14 reviews · 3 notes · last at 14:32, quiet\nclick to switch off')
    expect(answerOf(figures({ state: 'failing', spent: 0.75, unpriced: ['A'], cause: 'no answer' })).split('\n').slice(0, 2)).toEqual(['auditor failing ($0.75, partial)', 'auditor $0.75 since on · API list prices · partial: no price for A'])
  })

  test('an unknown cost reads the same words in the answer: the plain label, then the cost row naming every unpriced model', () => {
    expect(answerOf(figures({ spent: 0, unpriced: ['A', 'B'] })).split('\n').slice(0, 2)).toEqual(['auditor on', 'cost unknown: no price for A, B'])
  })

  test('off reads its own words with unpriced models left over', () => {
    expect(answerOf(figures({ state: 'off', unpriced: ['A'] }))).toBe(answerOf(figures({ state: 'off' })))
  })
})

describe('buttonOf', () => {
  type Node = { type: string; props: Record<string, any> }
  const make = (type: string) => (props: Record<string, any>): Node => ({ type, props })
  const table = { Box: make('Box'), Text: make('Text'), Button: make('Button') } as any
  const drawn = (f: Figures): any => buttonOf(table, 'k', f, () => undefined)

  test('the button carries the label and its key, and the popup sits beside it in a keyed box', () => {
    const box = drawn(figures())
    const [button, popup] = box.props.children
    expect(button).toMatchObject({ type: 'Button', props: { key: 'k', plain: true, dimColor: true, label: 'auditor on ($12, 3%)' } })
    expect(box.props.key).toBe('auditor-box')
    expect(popup.props).toMatchObject({ position: 'absolute', bottom: 1, right: 0, display: 'none', hover: { display: 'flex' }, flexDirection: 'column' })
  })

  test('the popup holds one keyed dim row per wording row, in order', () => {
    const popup = drawn(figures()).props.children[1]
    expect(popup.props.children.map((row: Node) => row.props['key'])).toEqual(['cost', 'model', 'reviews', 'press'])
    expect(popup.props.children[0].props.children[0]).toMatchObject({ type: 'Text', props: { dimColor: true, children: ['auditor $12.40 since on · session $410.27 · 3% · API list prices'] } })
  })

  test('a partial figure is drawn in the label and in the cost row, with no share in either, though a session total is given', () => {
    const [button, popup] = drawn(figures({ spent: 0.75, unpriced: ['A', 'B'] })).props.children
    expect(button.props.label).toBe('auditor on ($0.75, partial)')
    expect(popup.props.children[0].props.children[0]).toMatchObject({ type: 'Text', props: { dimColor: true, children: ['auditor $0.75 since on · API list prices · partial: no price for A, B'] } })
  })

  test('a press runs the handler given', () => {
    let pressed = 0
    const box: any = buttonOf(table, 'k', figures(), () => { pressed++ })
    box.props.children[0].props.onPress()
    expect(pressed).toBe(1)
  })
})

describe('modelFiguresOf', () => {
  const marked = (current: string, catalog: string[] | undefined, ids: Record<string, string> = {}) => modelFiguresOf(current, choicesOf(catalog, undefined), ids).choices

  test('every choice is shown, the current one, the default and each Fable marked', () => {
    const choices = marked('sonnet', ['claude-fable-5-2'])
    expect(choices.map(c => c.name)).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'claude-fable-5-2'])
    expect(choices.filter(c => c.isCurrent).map(c => c.name)).toEqual(['sonnet'])
    expect(choices.filter(c => c.isDefault).map(c => c.name)).toEqual(['haiku'])
    expect(choices.filter(c => c.isFable).map(c => c.name)).toEqual(['fable', 'claude-fable-5-2'])
  })

  test('an alias with no id yet is not marked, so the default never warns in a fresh install', () => {
    expect(marked('haiku', undefined).filter(c => c.costUnknown)).toEqual([])
  })

  test('a choice is checked at the id the chain gives it: a priced id is not marked, one outside the table is', () => {
    const choices = marked('haiku', ['claude-nosuch-9-9', 'claude-haiku-5-5'], { haiku: 'claude-haiku-5-5-20261001', sonnet: 'claude-nosuch-1-1' })
    expect(choices.filter(c => c.costUnknown).map(c => c.name)).toEqual(['sonnet', 'claude-nosuch-9-9'])
  })

  test('a model the table prices is not marked whichever model it is, and a context-suffixed variant of one is', () => {
    const choices = marked('haiku', ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-haiku-4-5-20251001'])
    expect(choices.filter(c => c.costUnknown).map(c => c.name)).toEqual(['claude-opus-4-6[1m]'])
  })

  test('a current model the list does not offer is marked on no row', () => {
    expect(marked('claude-gone-1-1', undefined).filter(c => c.isCurrent)).toEqual([])
  })
})

describe('modelAnswerOf', () => {
  // The ids are ones the price table never covers, so the answer reads the same as the table grows.
  const figuresOfAnswer = modelFiguresOf('haiku', choicesOf(['claude-fable-9-9', 'claude-nosuch-9-9'], undefined), {})

  test('names the model the reviewer runs on, then every choice with its marks, then how to set one', () => {
    expect(modelAnswerOf(figuresOfAnswer)).toBe(
      [
        'Reviewer model: haiku',
        'Choices:',
        '  haiku (current, default)',
        '  sonnet',
        '  opus',
        '  fable (Fable)',
        '  claude-fable-9-9 (Fable, cost unknown)',
        '  claude-nosuch-9-9 (cost unknown)',
        'Set one with /auditor model <name>.',
      ].join('\n'),
    )
  })

  test('a note on what the command did comes first', () => {
    expect(modelAnswerOf(figuresOfAnswer, 'Set: the next review runs on haiku.').split('\n')[0]).toBe('Set: the next review runs on haiku.')
  })
})

import { describe, expect, test } from 'claude-code/testing'
import { answerOf, buttonOf, labelOf, rowsOf } from './button'
import type { Figures } from './button'

// 14:32 in the host's local time, built from local parts so the tests hold in any time zone.
const AT = new Date(2026, 10, 9, 14, 32).getTime()
const figures = (over: Partial<Figures> = {}): Figures => ({ state: 'on', spent: 12.4, unpriced: null, total: 410.27, reviews: 14, notes: 3, last: { at: AT, note: false }, cause: undefined, held: 0, ...over })

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

  test('on, with the cost unknown, reads auditor on', () => {
    expect(labelOf(figures({ unpriced: 'haiku' }))).toBe('auditor on')
  })

  test('failing keeps the figures the same way', () => {
    expect(labelOf(figures({ state: 'failing' }))).toBe('auditor failing ($12, 3%)')
    expect(labelOf(figures({ state: 'failing', total: undefined }))).toBe('auditor failing ($12)')
    expect(labelOf(figures({ state: 'failing', unpriced: 'haiku' }))).toBe('auditor failing')
  })

  test('off reads auditor off, whatever the figures', () => {
    expect(labelOf(figures({ state: 'off' }))).toBe('auditor off')
  })

  test('the dollars are whole from $10 and to the cent below, and the share one decimal below 1%', () => {
    expect(labelOf(figures({ spent: 3.4, total: 1000 }))).toBe('auditor on ($3.40, 0.3%)')
    expect(labelOf(figures({ spent: 0.42, total: 100 }))).toBe('auditor on ($0.42, 0.4%)')
    expect(labelOf(figures({ spent: 0.004, total: 100 }))).toBe('auditor on (<$0.01, <0.1%)')
  })

  test('a tally over the session total reads 100%', () => {
    expect(labelOf(figures({ spent: 5, total: 2 }))).toBe('auditor on ($5.00, 100%)')
  })
})

describe('rowsOf', () => {
  test('on, the cost row names the tally, the session total, the share and the prices, then the reviews row and the press row', () => {
    expect(rowsOf(figures())).toEqual([
      { key: 'cost', text: 'auditor $12.40 since on · session $410.27 · 3% · API list prices' },
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

  test('with the cost unknown, the cost row names the model with no price', () => {
    expect(rowsOf(figures({ unpriced: 'haiku' }))[0]).toEqual({ key: 'cost', text: 'cost unknown: no price for haiku' })
  })

  test('under a cent, both figures read <$0.01', () => {
    expect(rowsOf(figures({ spent: 0.004, total: 0.0049 }))[0]?.text).toBe('auditor <$0.01 since on · session <$0.01 · 82% · API list prices')
  })

  test('off, the rows say no reviews run and no figures show, then offer to switch on, with no review facts', () => {
    expect(rowsOf(figures({ state: 'off' }))).toEqual([
      { key: 'cost', text: 'off: no reviews, no figures until switched on' },
      { key: 'press', text: 'click to switch on' },
    ])
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
      expect(state({}).map(r => r.key)).toEqual(['cost', 'reviews', 'press'])
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

    test('the popup never exceeds four rows, in any state', () => {
      for (const state of ['on', 'off', 'failing'] as const) {
        for (const held of [0, 2]) expect(rowsOf(figures({ state, cause: state === 'failing' ? 'unknown' : undefined, held })).length).toBeLessThanOrEqual(4)
      }
      expect(rowsOf(figures({ state: 'failing', cause: 'unknown', held: 2 })).length).toBe(4)
    })

    test('off shows no state row even with a cause or notes left over', () => {
      expect(rowsOf(figures({ state: 'off', cause: 'unknown', held: 2 })).map(r => r.key)).toEqual(['cost', 'press'])
    })
  })
})

describe('answerOf', () => {
  test('the answer is the label, then each popup row, one to a line', () => {
    expect(answerOf(figures())).toBe('auditor on ($12, 3%)\nauditor $12.40 since on · session $410.27 · 3% · API list prices\n14 reviews · 3 notes · last at 14:32, quiet\nclick to switch off')
    expect(answerOf(figures({ state: 'off' }))).toBe('auditor off\noff: no reviews, no figures until switched on\nclick to switch on')
  })

  test('a failing answer ends with the state row', () => {
    expect(answerOf(figures({ state: 'failing', cause: 'not dispatched', held: 1 })).split('\n').at(-1)).toBe('failing: a review could not be handed to a reviewer · 1 note held')
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
    expect(popup.props.children.map((row: Node) => row.props['key'])).toEqual(['cost', 'reviews', 'press'])
    expect(popup.props.children[0].props.children[0]).toMatchObject({ type: 'Text', props: { dimColor: true, children: ['auditor $12.40 since on · session $410.27 · 3% · API list prices'] } })
  })

  test('a press runs the handler given', () => {
    let pressed = 0
    const box: any = buttonOf(table, 'k', figures(), () => { pressed++ })
    box.props.children[0].props.onPress()
    expect(pressed).toBe(1)
  })
})

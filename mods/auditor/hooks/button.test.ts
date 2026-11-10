import { describe, expect, test } from 'claude-code/testing'
import { answerOf, buttonOf, labelOf, rowsOf } from './button'
import type { Figures } from './button'

const figures = (over: Partial<Figures> = {}): Figures => ({ state: 'on', spent: 12.4, unpriced: null, total: 410.27, ...over })

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
  test('on, the cost row names the tally, the session total, the share and the prices, then the press row', () => {
    expect(rowsOf(figures())).toEqual([
      { key: 'cost', text: 'auditor $12.40 since on · session $410.27 · 3% · API list prices' },
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

  test('failing shows the same rows as on', () => {
    expect(rowsOf(figures({ state: 'failing' }))).toEqual(rowsOf(figures()))
  })

  test('under a cent, both figures read <$0.01', () => {
    expect(rowsOf(figures({ spent: 0.004, total: 0.0049 }))[0]?.text).toBe('auditor <$0.01 since on · session <$0.01 · 82% · API list prices')
  })

  test('off, the rows say no reviews run and no figures show, then offer to switch on', () => {
    expect(rowsOf(figures({ state: 'off' }))).toEqual([
      { key: 'cost', text: 'off: no reviews, no figures until switched on' },
      { key: 'press', text: 'click to switch on' },
    ])
  })
})

describe('answerOf', () => {
  test('the answer is the label, then each popup row, one to a line', () => {
    expect(answerOf(figures())).toBe('auditor on ($12, 3%)\nauditor $12.40 since on · session $410.27 · 3% · API list prices\nclick to switch off')
    expect(answerOf(figures({ state: 'off' }))).toBe('auditor off\noff: no reviews, no figures until switched on\nclick to switch on')
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
    expect(popup.props.children.map((row: Node) => row.props['key'])).toEqual(['cost', 'press'])
    expect(popup.props.children[0].props.children[0]).toMatchObject({ type: 'Text', props: { dimColor: true, children: ['auditor $12.40 since on · session $410.27 · 3% · API list prices'] } })
  })

  test('a press runs the handler given', () => {
    let pressed = 0
    const box: any = buttonOf(table, 'k', figures(), () => { pressed++ })
    box.props.children[0].props.onPress()
    expect(pressed).toBe(1)
  })
})

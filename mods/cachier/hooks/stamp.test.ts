import { describe, expect, test } from 'claude-code/testing'
import { stampLabel, withStamp } from './stamp'

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

describe('stampLabel', () => {
  test('a message from today shows its time', () => {
    expect(stampLabel(at(2026, 10, 18, 14, 3), at(2026, 10, 18, 20, 0))).toBe('14:03')
  })

  test('a message three days old shows its date and time', () => {
    expect(stampLabel(at(2026, 10, 15, 9, 7), at(2026, 10, 18, 20, 0))).toBe('2026-10-15 09:07')
  })

  test('a message from just before midnight is the previous day, not today', () => {
    expect(stampLabel(at(2026, 10, 17, 23, 59), at(2026, 10, 18, 0, 1))).toBe('2026-10-17 23:59')
  })
})

describe('withStamp', () => {
  const tree = { type: 'Text' as const, children: ['hello'] }

  test('no stamp known yet leaves the drawing as the engine made it', () => {
    expect(withStamp(undefined, tree)).toBe(tree)
  })

  test('a row with no time to show is drawn without a stamp', () => {
    expect(withStamp('', tree)).toBe(tree)
  })

  test('a stamp is painted over the top right of the row: the message is the first child, and the stamp takes no room', () => {
    expect(withStamp('14:03', tree)).toEqual({
      type: 'Box',
      props: {},
      children: [
        tree,
        {
          type: 'Box',
          props: { position: 'absolute', top: 0, right: 0 },
          children: [{ type: 'Text', props: { dimColor: true }, children: ['14:03'] }],
        },
      ],
    })
  })

  // The engine refuses an engine node under a Box with minWidth (live log: "engine node under a Box with prop minWidth").
  // The kit's mount does not, so this guards the placement itself: the message is the wrapper's child, and the wrapper has no
  // minWidth and no row direction. The kit cannot measure rows, so "no row is added" is asserted as this structure.
  test('the engine node is a direct child of the wrapper, and the wrapper carries no minWidth or row direction', () => {
    const wrapper = withStamp('14:03', tree) as unknown as { props: Record<string, unknown>; children: unknown[] }
    expect(wrapper.children[0]).toBe(tree)
    expect(wrapper.props).not.toHaveProperty('minWidth')
    expect(wrapper.props).not.toHaveProperty('flexDirection')
  })

  test('the stamp is absolutely placed, so a dated stamp is painted in full over the first line, not wrapped in a column', () => {
    const stamp = (withStamp('2026-10-15 09:07', tree) as unknown as { children: { props: Record<string, unknown> }[] }).children[1]
    expect(stamp?.props).toMatchObject({ position: 'absolute', top: 0, right: 0 })
    expect(stamp?.props).not.toHaveProperty('width')
  })
})

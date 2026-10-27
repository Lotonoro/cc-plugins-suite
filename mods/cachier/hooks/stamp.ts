import type { RenderElement } from 'claude-code'

const pad = (n: number) => String(n).padStart(2, '0')

// The time of a row: HH:MM on the day it is viewed, else the date and the time.
export const stampLabel = (rowMs: number, nowMs: number): string => {
  const row = new Date(rowMs)
  const now = new Date(nowMs)
  const time = `${pad(row.getHours())}:${pad(row.getMinutes())}`
  const isToday =
    row.getFullYear() === now.getFullYear() && row.getMonth() === now.getMonth() && row.getDate() === now.getDate()
  return isToday ? time : `${row.getFullYear()}-${pad(row.getMonth() + 1)}-${pad(row.getDate())} ${time}`
}

// The row as drawn, with its time painted over the right end of the first line. The stamp is absolutely placed, so it takes
// no room: no row is added, and the message keeps the full width. The message is a direct child of the wrapper, which carries
// no minWidth: the engine refuses an engine node under a Box with minWidth. A row with no stamp is drawn as the engine drew it.
export const withStamp = (label: string | undefined, tree: RenderElement): RenderElement => {
  if (label === undefined || label === '') return tree
  return {
    type: 'Box',
    props: {},
    children: [
      tree,
      {
        type: 'Box',
        props: { position: 'absolute', top: 0, right: 0 },
        children: [{ type: 'Text', props: { dimColor: true }, children: [label] }],
      },
    ],
  }
}

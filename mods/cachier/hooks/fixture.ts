// Test-only: a transcript held in memory and read the way the reader reads a file (a stat for its size, then
// 1 MiB blocks from dd, each stdout capped at 4 MiB); and the details pane's list of labels, with the helper and the check over a drawn pane that read
// it. Not loaded by the plugin; only the tests import it.

import type { Run } from './countdown'
import { CHUNK_BYTES } from './transcript'

export { CHUNK_BYTES }
const enc = new TextEncoder()
const dec = new TextDecoder()

export type Tags = { five: number; one: number }

export const assistant = (o: {
  uuid: string
  parent: string | null
  ts: string
  read?: number
  write?: number
  // The reply's output tokens.
  out?: number
  tags?: Tags
  sidechain?: boolean
  agentId?: string | null
  // The API message a row belongs to; the rows of one reply share it. Unset, the row is a reply of its own.
  msg?: string
  // The model and speed the reply names; unset, the row names neither.
  model?: string
  speed?: string
}): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: o.uuid,
    parentUuid: o.parent,
    timestamp: o.ts,
    isSidechain: o.sidechain ?? false,
    agentId: o.agentId ?? null,
    requestId: `req-${o.uuid}`,
    message: {
      id: o.msg ?? `msg-${o.uuid}`,
      role: 'assistant',
      ...(o.model === undefined ? {} : { model: o.model }),
      content: [{ type: 'text', text: 'reply' }],
      usage: {
        input_tokens: 8,
        output_tokens: o.out ?? 20,
        cache_read_input_tokens: o.read ?? 0,
        cache_creation_input_tokens: o.write ?? 0,
        ...(o.speed === undefined ? {} : { speed: o.speed }),
        ...(o.tags === undefined
          ? {}
          : { cache_creation: { ephemeral_5m_input_tokens: o.tags.five, ephemeral_1h_input_tokens: o.tags.one } }),
      },
    },
  })

export const user = (o: { uuid: string; parent: string | null; ts: string; pad?: number }): string =>
  JSON.stringify({
    type: 'user',
    uuid: o.uuid,
    parentUuid: o.parent,
    timestamp: o.ts,
    isSidechain: false,
    agentId: null,
    message: { role: 'user', content: 'x'.repeat(o.pad ?? 4) },
  })

export type FakeStat = { kind: 'file'; size: number; mtimeMs: number; isLink: false }
export type FakeRun = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

// The fake answers `dd if=PATH bs=N skip=I count=1` with block I of the text, and `stat` with its byte size.
export const fakeFiles = (text: string) => {
  const bytes = enc.encode(text)
  const stat = (): FakeStat => ({ kind: 'file', size: bytes.byteLength, mtimeMs: 0, isLink: false })
  const run = (argv: readonly string[]): FakeRun => {
    const block = Number(argv.find((a) => a.startsWith('bs='))?.slice(3))
    const skip = Number(argv.find((a) => a.startsWith('skip='))?.slice(5))
    const part = bytes.subarray(skip * block, (skip + 1) * block)
    return { exitCode: 0, stdout: dec.decode(part), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  return { stat, run }
}

// The rows of a transcript, one per line, as Claude Code writes them.
export const lines = (rows: readonly string[]): string => rows.map((r) => `${r}\n`).join('')

// The reader's two host reads answered from the text, in the shape register.ts's adapter gives the reader.
export const hostOver = (text: string) => {
  const files = fakeFiles(text)
  return {
    size: async (_path: string) => files.stat().size,
    run: async (argv: readonly string[]) => files.run(argv),
  }
}

// The labels the details pane draws dim, each the first piece of its row and with its colon where it has one, in the order of their modules: the pie
// sentence, the Keepalive figures, the tallies and history, the learned rest, the balance, the learned count, the Advice rows, the unit note, and the Settings names. The
// one list the pane's tests read: a row is labelled because its label is listed here, never by a colon in its text, since a row may hold one
// elsewhere (`every 4:45`, `0 refreshes this pause (learned: …)`).
export const LABELS: readonly string[] = [
  'pie:',
  'refresh',
  'next refresh',
  'next in',
  'if cold:',
  'last refresh:',
  'session:',
  'pause:',
  'earlier:',
  'long pauses:',
  'misses:',
  'rest:',
  'balance vs other setting:',
  'learned:',
  'learned (this hour):',
  'setup:',
  'best:',
  'next best:',
  'other TTL:',
  'do:',
  'saves',
  'in tokens:',
  'TTL:',
  'lead:',
  'refreshes/pause:',
  'start mode:',
  'unit:',
]

// The rows that carry no label though they read like labelled ones: each is drawn as one plain string. `refresh due · waits for turn end` opens with the word of the
// `refresh` label and fills the schedule slot of `next in`, and its words state that a refresh is due; the two `most wasted pauses` tails are named by their
// words before the colon.
export const UNLABELLED: readonly string[] = [
  'refresh due · waits for turn end',
  'most wasted pauses ran out: pauses outlast refreshes',
  'most wasted pauses not needed: refreshes fire just before you return',
]

// A labelled line's pieces as the tests expect them, written out: the label one dim piece, the rest one untoned piece. The producers' tests state a
// line's pieces through this, and the constructor's own tests state them in full.
export const pieces = (label: string, rest: string): Run[] => [
  { text: label, tone: 'gone' },
  { text: rest, tone: 'quiet' },
]

// The text a drawn element holds, its strings in order.
const drawnText = (el: any): string => (typeof el === 'string' ? el : (el?.children ?? el?.props?.children ?? []).map(drawnText).join(''))
// A pane's line row is a Box holding the row's one Text, whose children are the row's text alone or its pieces; the first of them is the row's first piece.
const isLineRow = (row: any): boolean => row?.type === 'Box'
const firstPieceOf = (row: any): any => row.children?.[0]?.children?.[0]

// The listed labels a drawn pane shows, in row order, each with the props of its piece: the first piece of a line row, where it is a drawn piece whose whole
// text is a listed label.
export const drawnLabels = (pane: any): [string, Record<string, unknown>][] =>
  pane.children.filter(isLineRow).flatMap((row: any): [string, Record<string, unknown>][] => {
    const first = firstPieceOf(row)
    return typeof first === 'string' || !LABELS.includes(drawnText(first)) ? [] : [[drawnText(first), first.props ?? {}]]
  })

// A line row of a drawn pane without its label: the row's first piece is removed when it is a drawn piece whose whole text is a listed label. A row
// whose first piece is anything else is returned as it is, so a dim piece anywhere but a listed label's place stays in the row for the no-colour
// negatives to see. The helper reads no tone: the tests of the labelled states pin each label's.
export const withoutLabel = (row: any): any => {
  if (!isLineRow(row)) return row
  const first = firstPieceOf(row)
  if (typeof first === 'string' || !LABELS.includes(drawnText(first))) return row
  return { ...row, children: [{ ...row.children[0], children: row.children[0].children.slice(1) }] }
}

// The line rows of a drawn pane whose text starts with a listed label and a space, and which are drawn as one plain string rather than as pieces: a
// label that missed its piece. The rows on the unlabelled list are not flagged. Each row is returned as its text.
export const mislabelled = (pane: any): string[] =>
  pane.children
    .filter((row: any) => isLineRow(row) && typeof firstPieceOf(row) === 'string')
    .map(drawnText)
    .filter((text: string) => LABELS.some((label) => text.startsWith(`${label} `)) && !UNLABELLED.includes(text))

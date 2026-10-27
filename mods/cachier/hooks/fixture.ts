// Test-only: a transcript held in memory and read the way the reader reads a file (a stat for its size, then
// 1 MiB blocks from dd, each stdout capped at 4 MiB). Not loaded by the plugin; only the tests import it.

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
        output_tokens: 20,
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

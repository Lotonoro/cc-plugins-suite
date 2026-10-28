// The one module that reads the session's transcript. Its host reads come in through a Host adapter that register.ts
// builds, so this module never sees the engine's `$`. The reader walks the file backwards in 1 MiB blocks read by
// `dd`, so no single stdout exceeds the 4 MiB cap, and it stops at the row it needs.
import type { CacheView, TtlLabel } from '../types'
import { TTL_MS } from './prices'

// The two host reads the reader makes: a file's size, and a command's stdout (its first 4 MiB, `isStdoutTruncated`
// says whether more was cut).
export type Host = {
  size: (path: string) => Promise<number>
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated: boolean }>
}

export const CHUNK_BYTES = 1048576
const ROW_CAP_BYTES = 4194304

export type Visit = 'stop' | 'more' | 'unread'
export type Walk = 'stop' | 'covered' | 'unread'

const encoder = new TextEncoder()

// Visits each complete line from the newest back, to the start of the file. A block's first partial line is carried
// into the next block. The file's last line is skipped while it is unterminated, its head in an earlier block
// included: Claude Code is still writing it. A row over the cap, a failed or truncated block read, or a visit answering
// unread ends the walk unread.
export const walkBackward = async (host: Host, path: string, visitRow: (line: string) => Visit): Promise<Walk> => {
  const visit = (line: string): Visit => (encoder.encode(line).byteLength > ROW_CAP_BYTES ? 'unread' : visitRow(line))
  const size = await host.size(path)
  if (size === 0) return 'covered'
  const overCap = (text: string) => encoder.encode(text).byteLength > ROW_CAP_BYTES
  let carry = ''
  let open = false
  let isLastBlock = true
  for (let block = Math.floor((size - 1) / CHUNK_BYTES); block >= 0; block--) {
    const run = await host.run(['dd', `if=${path}`, `bs=${CHUNK_BYTES}`, `skip=${block}`, 'count=1'])
    if (run.exitCode !== 0 || run.isStdoutTruncated) return 'unread'
    const parts = (run.stdout + carry).split('\n')
    if (isLastBlock) {
      open = !run.stdout.endsWith('\n')
      isLastBlock = false
    }
    if (open) {
      if (parts.length === 1) {
        // No newline yet: the unterminated row continues into the block below.
        carry = parts[0] ?? ''
        if (overCap(carry)) return 'unread'
        continue
      }
      parts.pop()
      open = false
    }
    carry = parts[0] ?? ''
    if (overCap(carry)) return 'unread'
    for (let i = parts.length - 1; i >= 1; i--) {
      const line = parts[i] ?? ''
      if (line === '') continue
      const verdict = visit(line)
      if (verdict !== 'more') return verdict === 'stop' ? 'stop' : 'unread'
    }
  }
  // An unterminated span is one row being written.
  if (open || carry === '') return 'covered'
  const verdict = visit(carry)
  if (verdict === 'unread') return 'unread'
  return verdict === 'stop' ? 'stop' : 'covered'
}

// The fields of a transcript row the reader uses, normalized at this boundary. A main-thread row is one with no
// sidechain mark and no agent id; usage is present on a main-thread row that carries a usage block.
export type Row = {
  uuid: string | null
  parentUuid: string | null
  type: string | null
  timestampMs: number | null
  // The API message the row belongs to; the rows of one reply share it.
  messageId: string | null
  // The model that answered and the speed it ran at, as the API message names them.
  model: string | null
  speed: string | null
  usage: Usage | null
}
// `write5m` and `write1h` split `write` by TTL. A row with no split is a 5 m write, the API's default TTL.
export type Usage = {
  input: number
  output: number
  read: number
  write: number
  write5m: number
  write1h: number
  ttl: { label: TtlLabel } | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const splitOf = (creation: unknown, write: number): { write5m: number; write1h: number } => {
  if (typeof creation !== 'object' || creation === null) return { write5m: write, write1h: 0 }
  const write1h = Math.min(num((creation as Record<string, unknown>).ephemeral_1h_input_tokens), write)
  return { write5m: write - write1h, write1h }
}

const ttlOf = (creation: unknown): Usage['ttl'] => {
  if (typeof creation !== 'object' || creation === null) return null
  const five = num((creation as Record<string, unknown>).ephemeral_5m_input_tokens)
  const one = num((creation as Record<string, unknown>).ephemeral_1h_input_tokens)
  if (five > 0) return { label: '5m' }
  if (one > 0) return { label: '1h' }
  return null
}

// Undefined when the line is not JSON, which the caller reports as unread.
export const normalize = (line: string): Row | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const isMain = r.isSidechain !== true && (r.agentId === null || r.agentId === undefined)
  const message = typeof r.message === 'object' && r.message !== null ? (r.message as Record<string, unknown>) : undefined
  const u = message?.usage
  const fields = isMain && typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : null
  const write = fields === null ? 0 : num(fields.cache_creation_input_tokens)
  const usage: Usage | null =
    fields === null
      ? null
      : {
          input: num(fields.input_tokens),
          output: num(fields.output_tokens),
          read: num(fields.cache_read_input_tokens),
          write,
          ...splitOf(fields.cache_creation, write),
          ttl: ttlOf(fields.cache_creation),
        }
  const ts = str(r.timestamp)
  const timestampMs = ts === null ? null : Date.parse(ts)
  return {
    uuid: str(r.uuid),
    parentUuid: str(r.parentUuid),
    type: str(r.type),
    timestampMs: timestampMs === null || Number.isNaN(timestampMs) ? null : timestampMs,
    messageId: str(message?.id),
    model: str(message?.model),
    speed: fields === null ? null : str(fields.speed),
    usage,
  }
}

const UUID_FIELD = /"uuid":"([^"]+)"/g

// The rows of the keys the transcript holds, found in one backward pass for all of them; a key with no row has no entry.
// A row that only names a key as its parent does not match, nor does a nested field holding the key as a uuid.
export const lookupRows = async (host: Host, path: string, keys: readonly string[]): Promise<Map<string, Row>> => {
  const pending = new Set(keys)
  const found = new Map<string, Row>()
  await walkBackward(
    host,
    path,
    (line) => {
      let row: Row | undefined
      let parsed = false
      for (const match of line.matchAll(UUID_FIELD)) {
        const key = match[1]
        if (key === undefined || !pending.has(key)) continue
        if (!parsed) {
          row = normalize(line)
          parsed = true
        }
        if (row === undefined) return 'unread'
        if (row.uuid === key) {
          found.set(key, row)
          pending.delete(key)
        }
      }
      return pending.size === 0 ? 'stop' : 'more'
    },
  )
  return found
}

// The time the reply's first block answered: the parent of the first row of its API message, past the rows of that
// same message. Claude Code writes one row per content block, and each later block's parent is the block before it.
// Parents precede their children in the file, so one backward pass finds the whole chain. Undefined when it is missing.
const requestStart = async (host: Host, path: string, touch: Row): Promise<Row | undefined> => {
  let want = touch.parentUuid
  let start: Row | undefined
  const walk = await walkBackward(host, path, (line) => {
    if (want === null) return 'stop'
    if (!line.includes(`"uuid":"${want}"`)) return 'more'
    const row = normalize(line)
    if (row === undefined) return 'unread'
    if (row.uuid !== want) return 'more'
    const sameReply = row.type === 'assistant' && row.messageId !== null && row.messageId === touch.messageId
    if (!sameReply) {
      start = row
      return 'stop'
    }
    want = row.parentUuid
    return 'more'
  })
  return walk === 'unread' ? undefined : start
}

// One main-thread response: the usage of one API message, and the time its row was logged.
export type Response = {
  messageId: string
  timestampMs: number
  input: number
  read: number
  write: number
  write5m: number
  write1h: number
  ttlMs: number | null
  model: string | null
  speed: string | null
}
// The responses a pass found, oldest first. `recount` is set when the pass did not reach the cursor (it walked the file
// to its start, or was cut short by a read it could not make), so the caller starts its counts again from these.
export type History = { responses: Response[]; recount: boolean }
export type Reading = { view: CacheView; history: History | null }

// The cache reading from the newest main-thread cache activity, and the responses since `cursor` (the newest message the
// caller already counted), from the same backward pass. The view stops at the newest row with a write, and the touch and TTL
// are taken there. Past that stop, the pass only collects history, and only
// while the cursor has not been reached. With no cursor (a first read) it collects the newest response alone. The touch is
// the time the request that row answered was sent: the row its reply's first block answered, not the time the reply was
// logged. The TTL is the newest write's tags.
export const readCache = async (host: Host, path: string, cursor: string | null = null): Promise<Reading> => {
  let touch: { row: Row; promptTokens: number; outputTokens: number } | undefined
  let ttl: Usage['ttl'] | undefined
  // The view's stop: the newest row with a write. Set once; no later row changes the view.
  let frozen = false
  let cursorReached = false
  const found: Response[] = []
  const seen = new Set<string>()
  const walk = await walkBackward(host, path, (line) => {
    const row = normalize(line)
    // An unparsable row is unread before the view's stop. After it, no row can change the view.
    if (row === undefined) return frozen ? 'more' : 'unread'
    const usage = row.usage
    const messageId = row.messageId
    if (usage !== null && messageId !== null && cursor !== null && messageId === cursor) cursorReached = true
    if (usage !== null && messageId !== null && row.timestampMs !== null && !cursorReached && !seen.has(messageId)) {
      if (cursor !== null || found.length === 0) {
        seen.add(messageId)
        found.push({
          messageId,
          timestampMs: row.timestampMs,
          input: usage.input,
          read: usage.read,
          write: usage.write,
          write5m: usage.write5m,
          write1h: usage.write1h,
          ttlMs: usage.ttl === null ? null : TTL_MS[usage.ttl.label],
          model: row.model,
          speed: row.speed,
        })
      }
    }
    if (!frozen && usage !== null && (usage.read !== 0 || usage.write !== 0)) {
      touch ??= { row, promptTokens: usage.input + usage.read + usage.write, outputTokens: usage.output }
      if (usage.write > 0) {
        ttl = usage.ttl
        frozen = true
      }
    }
    // The view stops at the newest write. Past it, the pass goes on only until the cursor is reached, or, with no cursor,
    // until the newest response is taken (the stop at the newest write above).
    return frozen && (cursor === null || cursorReached) ? 'stop' : 'more'
  })
  // After the view's stop, nothing the pass meets can change the view, so the view's walk is the stop.
  const viewWalk: Walk = frozen ? 'stop' : walk
  // A pass that did not reach the cursor walked the file to its start: its responses are the whole history, and the caller
  // starts its counts again from them. That walk happens once per transcript the cursor no longer finds, and the cursor it
  // leaves is the newest response, so the next pass stops at once.
  const history: History | null = walk === 'unread' && found.length === 0 ? null : { responses: found.reverse(), recount: !cursorReached }
  if (viewWalk === 'unread') return { view: { kind: 'unread' }, history }
  return { view: await readingOf(host, path, touch, ttl, viewWalk), history }
}

const readingOf = async (
  host: Host,
  path: string,
  touch: { row: Row; promptTokens: number; outputTokens: number } | undefined,
  ttl: Usage['ttl'] | undefined,
  walk: Walk,
): Promise<CacheView> => {
  if (touch === undefined) return walk === 'covered' ? { kind: 'no-cache' } : { kind: 'unread' }
  if (ttl === undefined || ttl === null) return { kind: 'ttl-unknown' }
  const start = await requestStart(host, path, touch.row)
  if (start === undefined || start.timestampMs === null) return { kind: 'unread' }
  return {
    kind: 'known',
    touchMs: start.timestampMs,
    ttlMs: TTL_MS[ttl.label],
    ttlLabel: ttl.label,
    promptTokens: touch.promptTokens,
    outputTokens: touch.outputTokens,
    model: touch.row.model,
    speed: touch.row.speed,
  }
}

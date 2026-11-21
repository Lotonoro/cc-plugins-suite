import { expect, test } from 'claude-code/testing'
import { correctionText, newlyRestated, restatedIds } from './restatement'
import type { Item, ItemOption, ItemState } from '../types'

const item = (id: number, title: string, state: ItemState = 'open', options: ItemOption[] = []): Item => ({
  id,
  title,
  detail: '',
  blocking: true,
  createdAt: 0,
  state,
  pressedAt: null,
  note: null,
  agent: null,
  unread: false,
  posed: false,
  options,
  answer: null,
  yesno: false,
  replied: false,
  doneLabel: null,
  thread: [],
  windowTurns: [],
  windowChanged: false,
})

const option = (label: string): ItemOption => ({ label, description: '', recommended: false })

// The final step's text of three live replies, copied from their terminal captures: the first two filed the retry-limit ask and
// then restated it (the first without naming its id, the second naming it in the same paragraph), and the third explained a
// missing sync client after filing its two items, and restates neither.
const RUN1 = `I wrote /tmp/hp-r2/scratch/retry.md. Nothing under the repo was touched.

  - Backoff: the wait before each retry starts at 200 ms and doubles each time, up to
    a 10 s cap. The cap is applied before doubling, so a large retry count can't
    overflow the number.
  - Jitter: I picked full jitter, meaning the actual wait is random between 0 and the
    current backoff value. You didn't specify a type, and this is the usual default
    because it stops clients that failed together from retrying in sync.
  - What to retry: I added a short section limiting retries to temporary failures
    (connection errors, timeouts, 5xx and 429 responses), and only for requests that
    are safe to repeat. That's scope you didn't ask for, so cut it if you don't want
    it.
  - Retry limit: I left it as TBD, with a note not to ship the policy until it's set.
    As written, the policy never stops retrying.

  Added #1: what the retry limit should be.`

const RUN2 = `I wrote /tmp/hp-r2/scratch/retry2.md and left the repo alone. The policy:

  - Backoff: starts at 200 ms and doubles each retry (400 ms, 800 ms, …). No single
    wait goes over 10 s.
  - Jitter: full jitter, so each wait is a random value between 0 and that retry's
    backoff. This stops clients that failed together from retrying in lockstep.
  - What gets retried: connection failures, timeouts, 429 and 5xx. Other 4xx responses
    aren't retried, since they'll fail the same way every time. A Retry-After header
    is honored, still capped at 10 s.

  I added two things you didn't ask for: the list of what to retry and the Retry-After
  handling. Cut them if you don't want them.

  The retry limit is marked TBD, with a note that the client shouldn't ship until it's
  set. I didn't pick a number. Added #1 for it; the brief gives the worst-case wait
  totals.`

const NO_CLIENT = `I didn't make the change, because this repo has no sync client. There's nothing here
  to add a retry policy to.

  What I searched in this worktree (feat/human-plugin-followups):
  - File paths matching sync|client|retry|backoff: none.
  - Code matching SyncClient, sync client, def sync, function sync or sync(: none.
  - The word sync anywhere in python/, src/ or mods/: none.

  The repo is the bash scripts under src/, a small Python bridge (mint.py, errors.py)
  and the human-plugin mod. None of it syncs anything. I won't invent a client, and I
  won't dig up some other clone and edit it from here.

  - Added #1 (blocking): where the sync client actually is. If it's in another repo,
    restart the session there. If it's here under another name, tell me which
    component.
  - Added #2 (blocking): the retry limit, which is yours to set. I'll make it a
    required setting with no default, so nothing ships with a number I made up.

  For the backoff, once I have the client, I'll use the usual setup: the wait doubles
  after each failed try, starting at 200 ms, never goes above 10 s, and each wait is a
  random amount up to that value so many clients don't all retry at the same moment.
  I'll only retry errors that can clear up on their own: timeouts, connection resets,
  5xx and 429 responses, and I'll honour Retry-After when the server sends it. I won't
  retry 4xx errors (other than 429), since trying the same bad request again just
  fails again.`

const RUN1_ITEM = item(1, 'Set the retry limit for the sync-client retry policy')
const RUN2_ITEM = item(1, 'Set the retry limit in retry2.md')
const NO_CLIENT_ITEMS = [item(1, 'Which "sync client"? None exists in co-claude'), item(2, 'Retry limit for the sync client')]
const SYNC_RETRY = item(3, 'Set the retry limit for the sync client')
const CACHE_PICK = item(4, 'Pick the cache store', 'open', [option('Redis'), option('Postgres')])

// The corpus: one row per fixture of the rule, named for what it pins. Run 1, run 2 and the no-sync-client reply are the final
// steps of the live replies above. The rest are written to the rule's branches and its near-misses.
const CORPUS: { name: string; answer: string; items: Item[]; expect: number[] }[] = [
  { name: 'run 1: a TBD bullet about the open retry limit restates #1', answer: RUN1, items: [RUN1_ITEM], expect: [1] },
  { name: 'run 2: a TBD paragraph that names #1 restates nothing', answer: RUN2, items: [RUN2_ITEM], expect: [] },
  { name: 'no-sync-client: topic without a cue restates nothing, for either item', answer: NO_CLIENT, items: NO_CLIENT_ITEMS, expect: [] },
  {
    name: 't13 near-miss: a pre-tool block that names the open items restates nothing',
    answer: "Open blockers remain: the date in #1 (affects gate timing) and the #2 decision (affects step 5/rollback), plus I'm adding a non-blocking question about which cache tech you use.",
    items: [item(1, 'Date for the gate'), item(2, 'Rollback decision')],
    expect: [],
  },
  {
    name: 'live false positive: "would decide" is not a cue',
    answer: "I didn't give a recommendation. This directory has no reader-service code, only a debug.log, so there's nothing to judge the choice against. The brief lists the facts that would decide it.",
    items: [item(4, 'Pick the cache store for the reader service')],
    expect: [],
  },
  { name: 'bare "pending" is not a cue', answer: 'Pending: running the tests for the sync client retry limit change.', items: [SYNC_RETRY], expect: [] },
  { name: '"confirm" is not a cue', answer: 'I ran the tests to confirm the retry limit for the sync client is read from config.', items: [SYNC_RETRY], expect: [] },
  {
    name: '"please" is not a cue, and a lead-in without a recap cue is not inherited',
    answer: 'Changes, please review:\n- Added the retry limit for the sync client to config.',
    items: [SYNC_RETRY],
    expect: [],
  },
  { name: 'a bare "?" is not a cue', answer: 'Did I wire the retry limit for the sync client? Yes, in client.py.', items: [SYNC_RETRY], expect: [] },
  { name: 'a question to the reader is a cue', answer: 'Should we set the retry limit for the sync client to 5 or 10?', items: [SYNC_RETRY], expect: [3] },
  { name: 'an addressed phrase is a cue', answer: 'Where we are: the retry limit for the sync client is still open, waiting on you.', items: [SYNC_RETRY], expect: [3] },
  { name: 'a "Still open:" lead-in is inherited by its bullet', answer: 'Still open:\n- The retry limit for the sync client is not set.', items: [SYNC_RETRY], expect: [3] },
  { name: 'the plural "Open questions:" lead-in is inherited', answer: 'Open questions:\n- The retry limit for the sync client is not set.', items: [SYNC_RETRY], expect: [3] },
  { name: 'two option labels are topic, and "your call" is the cue', answer: 'Redis or Postgres for the cache: your call.', items: [CACHE_PICK], expect: [4] },
  { name: 'two option labels with no cue restate nothing', answer: 'Both Redis and Postgres are already running locally.', items: [CACHE_PICK], expect: [] },
  { name: 'one option label and a cue restate nothing: a topic needs two labels', answer: 'Redis for the cache: your call.', items: [CACHE_PICK], expect: [] },
  {
    name: 'a block naming a done item by its id is not a restatement of an open item either',
    answer: 'Retry limit for the sync client: TBD, see #5.',
    items: [SYNC_RETRY, item(5, 'Old ask', 'done-pending')],
    expect: [],
  },
  { name: 'a block naming an id not on the list does not excuse a restatement', answer: 'Retry limit for the sync client: TBD, see #9.', items: [SYNC_RETRY], expect: [3] },
  { name: 'option labels in a block that names the id restate nothing', answer: '#4: Redis or Postgres, your call.', items: [CACHE_PICK], expect: [] },
  {
    name: 'a block naming #1 that shares title words with #2 restates neither item',
    answer: 'Added #1: the cache store for the reader is undecided.',
    items: [item(1, 'Pick the cache store'), item(2, 'Cache store for the reader')],
    expect: [],
  },
  {
    name: 'the id matches as a whole token: #3 is not named by #30',
    answer: 'Waiting on you: the retry limit for the sync client (#30).',
    items: [SYNC_RETRY],
    expect: [3],
  },
  {
    name: 'adjacent title words are the only topic words: "limit on retries" is off topic',
    answer: "Limit on retries: I left it as TBD, with a note not to ship the policy until it's set.\n\nAdded #1: what the retry limit should be.",
    items: [RUN1_ITEM],
    expect: [],
  },
  { name: "STEERING's own mention of an id restates nothing", answer: 'Added #4: which store for the cache? The brief is in details.', items: [CACHE_PICK], expect: [] },
  { name: 'a bullet inside fenced code is skipped', answer: '```\n  - Retry limit: I left it as TBD.\n```', items: [RUN1_ITEM], expect: [] },
  { name: 'a bullet inside a tilde fence is skipped', answer: '~~~\n  - Retry limit: I left it as TBD.\n~~~', items: [RUN1_ITEM], expect: [] },
  { name: 'a tilde line inside a backtick fence does not close it', answer: '```\n~~~\n- Retry limit: I left it as TBD.\n```', items: [RUN1_ITEM], expect: [] },
  { name: 'a done-pending item is not a candidate, even when restated', answer: RUN1, items: [item(1, RUN1_ITEM.title, 'done-pending')], expect: [] },
  { name: 'a done-waiting item is a candidate', answer: RUN1, items: [item(1, RUN1_ITEM.title, 'done-waiting')], expect: [1] },
  {
    name: 'a done-waiting item restated with its own id restates nothing: the id exempts it like any listed item',
    answer: 'Retry limit for the sync client: TBD, see #3.',
    items: [item(3, SYNC_RETRY.title, 'done-waiting')],
    expect: [],
  },
  { name: 'a title of one content word never matches by topic', answer: 'Your call on the retry.', items: [item(1, 'Retry')], expect: [] },
]

for (const row of CORPUS) {
  test(row.name, () => {
    expect(restatedIds(row.answer, row.items)).toEqual(row.expect)
  })
}

test('an empty answer, an empty list, and an answer with no candidate return nothing without throwing', () => {
  expect(restatedIds('', [SYNC_RETRY])).toEqual([])
  expect(restatedIds('Retry limit: TBD.', [])).toEqual([])
  expect(restatedIds('Nothing here.', [SYNC_RETRY])).toEqual([])
})

test('the correction names the restated ids, in at most 30 words, with no done-notice marker', () => {
  const one = correctionText([1])
  expect(one).toContain('#1')
  expect(one.split(/\s+/).length).toBeLessThanOrEqual(30)
  expect(one).not.toMatch(/#\d+ is done:/)
  expect(one).not.toMatch(/The human chose .+ on #\d+\./)
  expect(correctionText([3, 5])).toContain('#3, #5')
})

test('an item already named in a correction is not named again', () => {
  expect(newlyRestated([1, 3], [1])).toEqual([3])
  expect(newlyRestated([1], [1])).toEqual([])
})

test('a fence of four backticks is closed only by a fence at least as long: a three-backtick line inside it is code', () => {
  expect(restatedIds('````\n```\nRetry limit: I left it as TBD.\n````', [RUN1_ITEM])).toEqual([])
})

test('a line indented four spaces that shows a fence still opens one for restatement, so the bullet after it is skipped', () => {
  expect(restatedIds('    ```\n- Retry limit for the sync client: I left it as TBD.', [SYNC_RETRY])).toEqual([])
})

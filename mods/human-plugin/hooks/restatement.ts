import type { Item, ItemOption } from '../types'
import { FENCE, closesFence } from './tables'

// The constants of the restatement rule, in one place. A change to any of them must keep restatement.test.ts green: its
// corpus pins every cue and branch. A block asks when it addresses the human's pending part: an addressed phrase, a question
// to the reader, or an undecided marker. A list item also takes the lead-in above it (LEAD_INS).
const ADDRESSED = /\b(your calls?|your decisions?|up to you|waiting (on|for) you|needs? (you to|your)|you('ll)? need to|let me know|tell me|say go|unless you veto)\b|\byes or no\?/i
const UNDECIDED = /\b(tbd|to be decided|undecided)\b/i
const READER = /\b(you|your|should i|should we)\b/i
const LEAD_INS = /\b(open questions?|still open|waiting on you|for you|needs your)\b/i
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'if', 'so', 'not', 'no', 'do', 'does', 'did', 'we', 'you', 'i', 'me',
  'my', 'our', 'your', 'which', 'what', 'when', 'where', 'who', 'how', 'why', 'there', 'here', 'than', 'then', 'up', 'about', 'into',
  'over', 'any', 'all', 'some', 'each', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 's', 't',
])

const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^([-*+]|\d+[.)])\s/

// A block of the answer: a paragraph, a heading or a list item, with the lead-in line of the list it sits in (null outside one).
type Block = { text: string; leadIn: string | null }

// Splits the answer into blocks. A block runs to a blank line, a heading or the next list item, so a wrapped line stays with
// its block. Fenced code is left out; a fence closes only on a marker of its own kind and at least its length (closesFence).
const blocksOf = (answer: string): Block[] => {
  const raw: { item: boolean; lines: string[] }[] = []
  let current: { item: boolean; lines: string[] } | null = null
  let fence: string | null = null
  let open = false
  for (const text of answer.split('\n')) {
    const line = text.trim()
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    const opening = FENCE.exec(line)?.[1]
    if (opening !== undefined) {
      fence = opening
      open = false
    } else if (line === '') {
      open = false
    } else if (open && current !== null && !HEADING.test(line) && !LIST_ITEM.test(line)) {
      current.lines.push(line)
    } else {
      current = { item: LIST_ITEM.test(line), lines: [line] }
      raw.push(current)
      open = !HEADING.test(line)
    }
  }
  const blocks: Block[] = []
  let lead: string | null = null
  for (const { item, lines } of raw) {
    const text = lines.join(' ')
    blocks.push({ text, leadIn: item ? lead : null })
    // A lead-in is a heading or a line ending in a colon; any other block ends the list above it.
    if (!item) lead = HEADING.test(text) || text.endsWith(':') ? text : null
  }
  return blocks
}

// The lower-case words of a text, without punctuation or quotes.
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

// How many of a decision's option labels the block names, as whole words in order.
const labelsIn = (block: string, options: readonly ItemOption[]): number => {
  const words = ` ${wordsOf(block).join(' ')} `
  return options.filter(option => {
    const label = wordsOf(option.label).join(' ')
    return label !== '' && words.includes(` ${label} `)
  }).length
}

// Whether the block carries the item's topic: two words that sit next to each other among the title's content words, or two of
// a decision's option labels. A title of fewer than two content words can match only through its labels.
const onTopic = (block: string, item: Item): boolean => {
  const words = wordsOf(block)
  const content = wordsOf(item.title).filter(word => !STOP_WORDS.has(word))
  const pairs = new Set(words.slice(1).map((word, i) => `${words[i]} ${word}`))
  const adjacent = content.slice(1).some((word, i) => pairs.has(`${content[i]} ${word}`))
  return adjacent || labelsIn(block, item.options) >= 2
}

// Whether the block asks the human: its own cue, or the lead-in of its list.
const asks = (block: Block): boolean => {
  const questions: string[] = block.text.match(/[^.!?]*\?/g) ?? []
  const ownCue = ADDRESSED.test(block.text) || UNDECIDED.test(block.text) || questions.some(question => READER.test(question))
  return ownCue || (block.leadIn !== null && LEAD_INS.test(block.leadIn))
}

// Whether the block points at any listed item by its id, as a whole token: #3 is not named by #30 or #3a.
const namesListedId = (block: string, listed: ReadonlySet<string>): boolean => {
  const tokens: string[] = block.match(/#\w+/g) ?? []
  return tokens.some(token => listed.has(token))
}

// Whether a block restates the item's ask: it carries the item's topic and asks the human.
const restates = (block: Block, item: Item): boolean => onTopic(block.text, item) && asks(block)

// A candidate is an item the agent has not been told is done: open, or in the undo window of a done press.
const candidate = (item: Item): boolean => item.state === 'open' || item.state === 'done-waiting'

// The ids of the items the answer restates. The candidates are the items the agent has not been told are done. A block that
// points at any listed item by its id, in any state, is not a restatement of any item, even one whose title it shares.
export const restatedIds = (answer: string, items: readonly Item[]): number[] => {
  const listed = new Set(items.map(item => `#${item.id}`))
  const blocks = blocksOf(answer).filter(block => !namesListedId(block.text, listed))
  return items.filter(item => candidate(item) && blocks.some(block => restates(block, item))).map(item => item.id)
}

// The correction the agent reads on its next request: it names the restated ids and the one move to make instead.
export const correctionText = (ids: readonly number[]): string =>
  `human-plugin: your last reply restated ${ids.map(id => `#${id}`).join(', ')}, which the list already shows. Refer to an item by its id instead of restating its ask.`

// The restated ids that no correction has named yet: an item is corrected at most once per conversation.
export const newlyRestated = (restated: readonly number[], corrected: readonly number[]): number[] =>
  restated.filter(id => !corrected.includes(id))

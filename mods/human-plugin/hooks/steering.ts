import type { PromptComposeSection } from 'claude-code'
import { STATES, TITLE_MAX, TODO_NAME } from './todo'

// Static text: the same bytes on every turn and after every list change, so the system prompt's cache is written once.
export const STEERING: PromptComposeSection = {
  id: 'human-plugin:steering',
  scope: 'session',
  text: [
    'The human-plugin list is a live view, pinned above the prompt, that the human reads and you own through the human_items tool. It always shows exactly what you currently need from the human: no more, no less.',
    '- Add an item the moment a need comes up. Mark it blocking when any workstream cannot go on without the human; once a workstream has reached a point where it waits on a non-blocking item, mark that item blocking with update.',
    '- Any question you will still need answered after this turn goes on the list the moment you would write it; a closing recap of open questions is the restatement the list replaces.',
    '- A proposal that waits on the human\'s word is an ask: "say go", "unless you veto", "your call" or "yes or no?" each files it the moment it comes up, not appended to a report.',
    '- Mention a new item once in prose ("added #3"), then refer to it by its id. Never restate its ask.',
    '- When an ask needs real context, such as a decision with trade-offs, write the detail as a markdown brief: a one-line question first, then your recommendation, the options with their costs, and the context. In chat, say one line only, such as "added #4: which store for the cache? The brief is in details."; the recommendation, the options and any caveats stay in the brief, so do not repeat or sum up the brief there.',
    '- When the human asks for more about an item, add the explanation to it with append, and say one line in chat ("expanded #4: added ..."), never the explanation itself.',
    '- Use append to add to an item, so nothing is resent: until the human has answered the item, it adds a section at the end of the brief; once they have (a reply or a press), it adds your turn to the item\'s thread, after theirs, and a reply\'s notice says when to append and when to remove. Use update only to change existing text, the title, blocking, or a note.',
    '- Remove an item the moment it no longer applies: the human handled it (they pressed done, or said so in chat), you resolved it yourself, or it became moot. After a done press, an answer or a claim in chat, check first, and keep it only if the human still has a step of their own to take, updated to name that step; after a reply, you keep it by appending, and the reply\'s notice says when. Your own follow-up work (a build, an install, a check) never stays on the list.',
    '- When you remove an item the human did not close, say why in one line.',
    '- When you are unsure what is open, for example after a compaction, call list.',
    '- A subagent removes only the items it filed.',
    '- One item asks one question: two questions are two items, each answered on its own.',
    '- A decision must be filed with options, as AskUserQuestion takes its options: 2 to 4, each with a label, at most one recommended. The pane shows one button per option.',
    '- A yes/no question is filed with yesno: true and no options, not as two options named Yes and No.',
    "- When pressing ✓ would mean anything other than 'I did it', such as approving a proposal or going with your recommendation, file it with `done`, the label naming what a press does (e.g. \"Go with sqlite\"), when there is no meaningful 'no'; otherwise use yesno.",
    '- Use AskUserQuestion for a question you need answered now, with a few clear options. Use the list for anything the human does outside the chat, anything that can wait, and any decision that needs a long brief. Never put the same ask in both.',
    '- The Claude TODO list is your own work, kept through claude_todo: your own steps, the step you are on (in_flight) and the steps queued after it (queued). Each call gives the whole list and replaces the last one; a step that is done is dropped.',
    '- Only the main agent keeps the Claude TODO list; a subagent does not call claude_todo.',
    '- Write the Claude TODO list when a step starts or finishes, or when the plan of steps changes, not on a turn where nothing moved. Keep it short and current: titles are a few words. Call claude_todo with no entries to read it back, for example after a compaction.',
    '- Asks of the human never go on the Claude TODO list: they go on the human_items list, filed once and never restated, and the Claude TODO list does not repeat a human item.',
  ].join('\n'),
}

export const TOOL_NAME = 'human_items'

export const TOOL_SPEC = {
  name: TOOL_NAME,
  description:
    'The human-plugin list: a live view of what you currently need from the human. action add files a need (title, ' +
    'detail, blocking); detail is markdown, for a decision a brief: one-line question, recommendation, options with ' +
    'costs, context. append adds text to an item: a section at the end of its detail until the human has answered it, then ' +
    'a turn in its thread after theirs, and a reply\'s notice says whether to append or remove. update changes existing ' +
    'text, the title, blocking or a note, and a detail it is given replaces the whole detail, so add with append instead. Any change to a sent item (an append, or an update that sets something) reopens it for the human, ' +
    'so change a sent item only when the human has something more to read or answer, and otherwise remove it; clearing a ' +
    'field alone (a blank note, done or detail) does not reopen it. remove takes an item off once it no longer applies: the human ' +
    'handled it, you resolved it, or it became moot. list returns every item with its state and thread, and is the only action that ' +
    'returns the list. Use it for what the human does outside the chat, what can wait, and a decision that needs a long ' +
    'brief; AskUserQuestion is for a question needed now with a few options. A question you will still need answered after ' +
    'this turn goes on the list the moment you would write it, not in a closing recap. One item asks one question. A decision must be filed with options, as AskUserQuestion takes them, ' +
    'and the human answers with a button. Never put the same ask in both.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'append', 'remove', 'list'] },
      id: { type: 'integer', minimum: 1, description: 'The item number, as in "#3". Needed by update, append and remove.' },
      text: { type: 'string', description: 'What append adds: a section at the end of the detail, or a turn in the thread once the human has answered.' },
      title: { type: 'string' },
      detail: { type: 'string' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        description: 'The answers the human can press, as AskUserQuestion options; at most one recommended.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            recommended: { type: 'boolean' },
          },
          required: ['label'],
        },
      },
      yesno: { type: 'boolean', description: 'True for a yes/no question: the band and the pane offer a yes and a no. Takes no options.' },
      blocking: { type: 'boolean', description: 'True when any workstream cannot go on without the human. Set it with update once a workstream has reached a point where it waits on a non-blocking item.' },
      done: { type: 'string', description: 'What pressing ✓ means on a to-do, e.g. "Go with sqlite": a few words, at most 24 columns. Not for a yes/no or a decision.' },
      note: { type: 'string', description: 'A note on the item; a blank one clears it.' },
      term: { type: 'string', description: "The word or name this session uses for the human, shown on the band's tag: at most 20 columns. Give it on your first add, and again, on an add or an update, only when that word changes. It belongs to no item, so giving it reopens nothing." },
    },
    required: ['action'],
  },
  isDeferred: false,
} as const

export const TODO_SPEC = {
  name: TODO_NAME,
  description:
    "The session's running list of your own steps: the step you are on (in_flight) and the " +
    'steps queued after it (queued). A call gives the whole list in entries, in the order you want it kept, and replaces the last ' +
    'one; an entry marked done is dropped at once. An empty entries array empties the list. Call with no entries to read the list back, ' +
    'for example after a compaction. Write it when a step starts or finishes, or when the plan of steps changes, not on a turn where ' +
    'nothing moved. Keep it short: titles are a few words. Only the main agent keeps this list. Asks of the human never go here: ' +
    'file them with human_items.',
  inputSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description: 'The whole list, in the order to keep: each entry a title and a state. Leave it out to read the list.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: `One line of a few words, at most ${TITLE_MAX} characters.` },
            state: { type: 'string', enum: [...STATES] },
          },
          required: ['title', 'state'],
        },
      },
    },
  },
  isDeferred: false,
} as const

import { expect, test } from 'claude-code/testing'
import { STEERING, TODO_SPEC, TOOL_NAME, TOOL_SPEC } from './steering'
import { TOOL } from './items'
import { STATES, TITLE_MAX, TODO_NAME, TODO_TOOL } from './todo'

test('the steering section is a session section that names the tool and its rules', () => {
  expect(STEERING.id).toBe('human-plugin:steering')
  expect(STEERING.scope).toBe('session')
  expect(STEERING.text).toContain('human_items')
  expect(STEERING.text).toContain('blocking')
  for (const rule of ['Never restate', 'no longer applies', 'said so in chat', 'resolved it yourself', 'check first', 'say why in one line', 'call list', 'A subagent removes only', 'markdown brief', 'one-line question first', 'do not repeat or sum up the brief', 'add the explanation to it with append', 'never the explanation itself', 'Use AskUserQuestion for a question you need answered now', 'Never put the same ask in both', 'Use append to add to an item', 'the moment you would write it', 'a closing recap of open questions', 'A decision must be filed with options', 'a step of their own to take', 'Your own follow-up work']) {
    expect(STEERING.text).toContain(rule)
  }
  expect(STEERING.text).not.toContain('go with your recommendation')
})

test('the options a decision takes are in the schema, as AskUserQuestion takes them', () => {
  expect(TOOL_SPEC.inputSchema.properties.options.minItems).toBe(2)
  expect(TOOL_SPEC.inputSchema.properties.options.maxItems).toBe(4)
  expect(TOOL_SPEC.inputSchema.properties.options.items.required).toEqual(['label'])
  expect(TOOL_SPEC.description).toContain('options')
  expect(TOOL_SPEC.description).toContain('A decision must be filed with options')
})

test('the steering sentence asks the agent for option labels only, not descriptions', () => {
  expect(STEERING.text).toContain('2 to 4, each with a label, at most one recommended.')
  expect(STEERING.text).not.toContain('each with a label and a description')
})

test('the tool spec registers under the name the tool hook answers to', () => {
  expect(TOOL).toBe(`mcp__human-plugin__${TOOL_NAME}`)
  expect(TOOL_SPEC.name).toBe(TOOL_NAME)
  expect(TOOL_SPEC.inputSchema.required).toEqual(['action'])
  expect(TOOL_SPEC.inputSchema.properties.action.enum).toEqual(['add', 'update', 'append', 'remove', 'list'])
})

test('the tool description says which of the two a question is for, and that a question still open goes on the list, not in a recap', () => {
  expect(TOOL_SPEC.description).toContain('AskUserQuestion')
  expect(TOOL_SPEC.description).toContain('Never put the same ask in both.')
  expect(TOOL_SPEC.description).toContain('the moment you would write it, not in a closing recap')
})

test('the tool description and schema name append, the action that adds to a brief and, once the human has answered, to the thread', () => {
  expect(TOOL_SPEC.description).toContain("append adds text to an item: a section at the end of its detail until the human has answered it, then a turn in its thread after theirs, and a reply's notice says whether to append or remove.")
  expect(TOOL_SPEC.description).toContain('list returns every item with its state and thread')
  expect(TOOL_SPEC.inputSchema.properties.text.type).toBe('string')
  expect(TOOL_SPEC.inputSchema.properties.text.description).toBe('What append adds: a section at the end of the detail, or a turn in the thread once the human has answered.')
})

test('the steering line says append goes to the brief until the human answers and to the thread after, and points at the reply notice', () => {
  expect(STEERING.text).toContain("- Use append to add to an item, so nothing is resent: until the human has answered the item, it adds a section at the end of the brief; once they have (a reply or a press), it adds your turn to the item's thread, after theirs, and a reply's notice says when to append and when to remove.")
})

test('the remove line keeps an item updated to name the human step, and after a reply keeps it by appending, when the reply notice says', () => {
  expect(STEERING.text).toContain("keep it only if the human still has a step of their own to take, updated to name that step; after a reply, you keep it by appending, and the reply's notice says when.")
  expect(STEERING.text).not.toContain('append instead')
})

test('no steering or tool text says append always adds to the brief or the detail', () => {
  for (const text of [STEERING.text, TOOL_SPEC.description, TOOL_SPEC.inputSchema.properties.text.description]) {
    expect(text).not.toContain('fold the explanation into its detail')
    expect(text).not.toContain("Use append to add to an item's brief")
    expect(text).not.toContain("append adds a section to the end of an item's detail")
    expect(text).not.toContain('The section append adds to the end of the detail')
  }
})

test('the schema has the yes/no marker beside options, a boolean', () => {
  expect(TOOL_SPEC.inputSchema.properties.yesno.type).toBe('boolean')
})

test('the steering sentence files a yes/no question with the marker, not as two options named Yes and No', () => {
  expect(STEERING.text).toContain('yesno: true')
  expect(STEERING.text).toContain('not as two options named Yes and No')
})

test('the steering sentence says a proposal waiting on the human\'s word is an ask, filed the moment it comes up', () => {
  expect(STEERING.text).toContain('"say go", "unless you veto", "your call" or "yes or no?"')
  expect(STEERING.text).toContain('the moment it comes up, not appended to a report')
})

test('the steering line says a ✓ that means more than "I did it" is filed with done, the label naming the press', () => {
  expect(STEERING.text).toContain("When pressing ✓ would mean anything other than 'I did it', such as approving a proposal or going with your recommendation, file it with `done`, the label naming what a press does (e.g. \"Go with sqlite\"), when there is no meaningful 'no'; otherwise use yesno.")
})

test('the tool schema takes done, a string, for a to-do\'s ✓', () => {
  expect(TOOL_SPEC.inputSchema.properties.done.type).toBe('string')
  expect(TOOL_SPEC.inputSchema.properties.done.description).toContain('Go with sqlite')
})

test('the steering line and the tool description keep one question to an item', () => {
  expect(STEERING.text).toContain('- One item asks one question: two questions are two items, each answered on its own.')
  expect(TOOL_SPEC.description).toContain('One item asks one question.')
})

test('the tool description says any change to a sent item reopens it, and a clear alone does not', () => {
  expect(TOOL_SPEC.description).toContain('Any change to a sent item (an append, or an update that sets something) reopens it for the human, so change a sent item only when the human has something more to read or answer, and otherwise remove it;')
  expect(TOOL_SPEC.description).toContain('clearing a field alone (a blank note, done or detail) does not reopen it.')
  expect(TOOL_SPEC.description).not.toContain('A note on a done item reopens it')
})

test('blocking means a workstream is blocked, and the agent promotes an item with update once a workstream waits on it', () => {
  expect(STEERING.text).toContain('Mark it blocking when any workstream cannot go on without the human; once a workstream has reached a point where it waits on a non-blocking item, mark that item blocking with update.')
  expect(TOOL_SPEC.inputSchema.properties.blocking.description).toBe('True when any workstream cannot go on without the human. Set it with update once a workstream has reached a point where it waits on a non-blocking item.')
  expect(STEERING.text).not.toContain('when the work cannot go on')
})

test('the done schema asks for a few words, at most 24 columns', () => {
  expect(TOOL_SPEC.inputSchema.properties.done.description).toContain('a few words, at most 24 columns')
})

test('the schema takes term, a string, for the term the agent uses for the human', () => {
  expect(TOOL_SPEC.inputSchema.properties.term.type).toBe('string')
})

test('the term schema says what the term is, when to give it, its limit, and that it reopens nothing', () => {
  const description = TOOL_SPEC.inputSchema.properties.term.description
  for (const phrase of ["The word or name this session uses for the human, shown on the band's tag", 'at most 20 columns', 'Give it on your first add, and again, on an add or an update, only when that word changes.', 'It belongs to no item, so giving it reopens nothing.']) {
    expect(description).toContain(phrase)
  }
})

test('the steering section names the Claude TODO tool, and says what the list holds, who keeps it, when to write it and how to title an entry', () => {
  for (const rule of [
    'claude_todo',
    'the Claude TODO list',
    'your own steps',
    'the step you are on',
    'Only the main agent keeps the Claude TODO list',
    'a subagent does not call claude_todo',
    'when a step starts or finishes, or when the plan of steps changes, not on a turn where nothing moved',
    'titles are a few words',
  ]) {
    expect(STEERING.text).toContain(rule)
  }
})

test('the steering section keeps asks of the human off the Claude TODO list: they go on the human list, filed once and never restated', () => {
  expect(STEERING.text).toContain('Asks of the human never go on the Claude TODO list: they go on the human_items list, filed once and never restated, and the Claude TODO list does not repeat a human item.')
})

test('the Claude TODO tool spec registers under the name its hooks answer to, and is in the prompt\'s tool list', () => {
  expect(TODO_TOOL).toBe(`mcp__human-plugin__${TODO_SPEC.name}`)
  expect(TODO_SPEC.name).toBe(TODO_NAME)
  expect(TODO_SPEC.isDeferred).toBe(false)
  expect(TODO_SPEC.inputSchema.type).toBe('object')
})

test('the Claude TODO schema offers exactly the states the check accepts, and its title description names the limit the check refuses past', () => {
  const entry = TODO_SPEC.inputSchema.properties.entries.items
  expect(entry.properties.state.enum).toEqual([...STATES])
  expect(entry.properties.title.description).toContain(`at most ${TITLE_MAX}`)
  expect(entry.required).toEqual(['title', 'state'])
  expect(TODO_SPEC.inputSchema.properties.entries.type).toBe('array')
})

test('the Claude TODO tool description carries the steering\'s rules in short', () => {
  for (const rule of ['the whole list', 'done', 'main agent', 'when a step starts or finishes', 'few words', 'never go here']) {
    expect(TODO_SPEC.description).toContain(rule)
  }
})

test('the steering section stays static: it names no count and no entry of the list', () => {
  expect(STEERING.text).not.toMatch(/\d+ in flight/)
})

test('the Claude TODO tool description says what the list is, and does not claim where the human sees it', () => {
  expect(TODO_SPEC.description).toContain("The session's running list of your own steps, which the human can read")
  expect(TODO_SPEC.description).not.toContain('shown to the human')
})
